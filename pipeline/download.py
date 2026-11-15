#!/usr/bin/env python3
"""Descarga los datos crudos de todos los sitios (sites/*.json) y los comunes.

- Reanuda descargas cortadas (curl -C -).
- Encuentra archivos por patrón en un índice HTTP cuando no hay URL fija.
- Recorta los DEM globales (MOLA-HRSC 200 m, MOLA 463 m) por sitio con lectura remota (GDAL /vsicurl/).
- Verifica que cada raster abra (gdalinfo) y escribe DATA_DIR/manifest.json.
- Opcional: sincroniza DATA_DIR/raw con S3 (--sync, usa la variable BUCKET).

Uso: python3 pipeline/download.py [--site jezero] [--sync]
"""
import argparse
import datetime as dt
import html.parser
import json
import math
import os
import re
import subprocess
import time
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
RAW = DATA_DIR / "raw"

# Identificable siempre (skill mapeando-geodata): si algo sale mal, el host sabe quién es.
UA = "mapeando-ando/1.0 (NASA Space Apps 2026; descarga dirigida de datos PDS)"
BACKOFF_S = 600          # ante 429/503: el server pide aire, se espera en serio
BACKOFF_TRIES = 3
NET_RETRY_S = 30         # caída de red (timeout, conexión): reintento corto
NET_TRIES = 8


def log(msg):
    print(f"[{dt.datetime.now(dt.timezone.utc).replace(tzinfo=None).isoformat(timespec='seconds')}Z] {msg}", flush=True)


class _Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for k, v in attrs:
                if k == "href" and v:
                    self.hrefs.append(v)


def discover(index_url, pattern, pick="first"):
    polite_wait(index_url)
    req = urllib.request.Request(index_url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        page = r.read().decode("utf-8", "replace")
    p = _Links()
    p.feed(page)
    rx = re.compile(pattern)
    names = [h.split("?")[0].rstrip("/").split("/")[-1] for h in p.hrefs]
    hits = sorted({urllib.parse.urljoin(index_url, n) for n in names if rx.search(n)})
    if not hits:
        raise RuntimeError(f"no file matching {pattern!r} in {index_url}")
    return hits[-1] if pick == "last" else hits[0]


# Crawl-delay del robots.txt de cada host (segundos entre pedidos). PDS Geosciences: 10 s.
CRAWL_DELAY = {"pds-geosciences.wustl.edu": 10}
_last_request = {}


def polite_wait(url):
    """Espera lo que pida el Crawl-delay del host desde el último pedido a ese mismo host."""
    host = urllib.parse.urlparse(url).hostname or ""
    delay = CRAWL_DELAY.get(host, 0)
    wait = _last_request.get(host, -1e9) + delay - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_request[host] = time.monotonic()


def fetch(url, dest):
    """Baja url a dest, reanudando. Los reintentos los maneja este loop, no curl: así un 429/503
    espera BACKOFF_S (no los 10 s de --retry-delay) y cada intento pasa por el Crawl-delay."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["curl", "--fail", "-L", "-C", "-", "-A", UA, "-sS", "-w", "%{http_code}",
           "-o", str(dest), url]
    backoffs = net_errors = 0
    while True:
        polite_wait(url)
        log(f"GET {url} -> {dest}")
        out = subprocess.run(cmd, stdout=subprocess.PIPE, text=True)
        rc, code = out.returncode, (out.stdout or "").strip()[-3:]
        # curl devuelve 33 cuando el server ignora el range sobre un archivo ya completo
        if rc in (0, 33):
            return
        if code in ("429", "503") and backoffs < BACKOFF_TRIES:
            backoffs += 1
            log(f"HTTP {code} de {url}: espero {BACKOFF_S} s ({backoffs}/{BACKOFF_TRIES})")
            time.sleep(BACKOFF_S)
            continue
        # 6 DNS, 7 conexión, 18 transferencia parcial, 28 timeout, 52/56 conexión cortada
        if rc in (6, 7, 18, 28, 52, 56) and net_errors < NET_TRIES:
            net_errors += 1
            log(f"curl exit {rc} (red) para {url}: reintento en {NET_RETRY_S} s ({net_errors}/{NET_TRIES})")
            time.sleep(NET_RETRY_S)
            continue
        raise RuntimeError(f"curl exit {rc} (HTTP {code or '?'}) for {url}")


def gdal_summary(path):
    out = subprocess.run(["gdalinfo", "-json", str(path)], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"gdalinfo failed for {path}: {out.stderr.strip()[:300]}")
    info = json.loads(out.stdout)
    return {
        "size_px": info.get("size"),
        "pixel_size": info.get("geoTransform", [None, None])[1],
        "bands": len(info.get("bands", [])),
        "dtype": (info.get("bands") or [{}])[0].get("type"),
    }


GLOBAL_DEMS = ("dem200", "dem463")


def crop_global_dem(site, d, dest):
    R = d["radius_m"]
    pad = site.get("horizon_pad_deg", 1.0)
    b = site["bbox"]
    src = f"/vsicurl/{d['url']}"
    env = dict(os.environ, GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="8",
               GDAL_HTTP_RETRY_DELAY="5", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        log(f"skip existing {dest}")
        return
    # El archivo puede venir en grados (geográfico) o en metros (equirectangular): se detecta.
    info = json.loads(subprocess.run(["gdalinfo", "-json", src], env=env, capture_output=True,
                                     text=True, check=True).stdout)
    in_degrees = abs(info["geoTransform"][1]) < 1.0
    tx = (lambda lon: lon) if in_degrees else (lambda lon: R * math.radians(lon))
    ty = (lambda lat: lat) if in_degrees else (lambda lat: R * math.radians(lat))
    ulx, uly = tx(b["lon_min"] - pad), ty(b["lat_max"] + pad)
    lrx, lry = tx(b["lon_max"] + pad), ty(b["lat_min"] - pad)
    log(f"crop {dest.stem} for {site['id']} pad={pad}deg ({'deg' if in_degrees else 'm'}) -> {dest}")
    cmd = ["gdal_translate", "-q", "-projwin", str(ulx), str(uly), str(lrx), str(lry),
           "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", src, str(dest)]
    rc = subprocess.run(cmd, env=env).returncode
    if rc != 0:
        raise RuntimeError("gdal_translate crop failed")


def process_file(f, outdir, manifest_files):
    entry = {k: f.get(k) for k in ("key", "kind", "desc", "mission")}
    try:
        url = f.get("url") or discover(f["discover"]["index"], f["discover"]["pattern"],
                                       f["discover"].get("pick", "first"))
        dest = outdir / Path(urllib.parse.urlparse(url).path).name
        fetch(url, dest)
        entry.update(url=url, path=str(dest.relative_to(DATA_DIR)), bytes=dest.stat().st_size, status="ok")
        if f.get("kind") == "raster":
            entry["raster"] = gdal_summary(dest)
    except Exception as e:  # keep going; the manifest records what failed
        entry.update(status="optional_missing" if f.get("optional") else "error", error=str(e)[:400])
        log(f"{'WARN' if f.get('optional') else 'ERROR'} {f.get('key')}: {e}")
    manifest_files.append(entry)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", action="append", help="solo estos sitios (repetible)")
    ap.add_argument("--sync", action="store_true", help="subir DATA_DIR/raw a s3://$BUCKET/raw al terminar")
    args = ap.parse_args()

    common = json.loads((ROOT / "sites/common.json").read_text())
    sites = [json.loads(p.read_text()) for p in sorted((ROOT / "sites").glob("*.json")) if p.name != "common.json"]
    if args.site:
        sites = [s for s in sites if s["id"] in args.site]

    manifest = {"generated_at": dt.datetime.now(dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z",
                "data_dir": str(DATA_DIR), "common": [], "sites": {}}

    for f in common["files"]:
        process_file(f, RAW / "common", manifest["common"])

    for s in sites:
        log(f"=== site {s['id']} ===")
        files = []
        outdir = RAW / s["id"]
        for f in s["files"]:
            process_file(f, outdir, files)
        for k in GLOBAL_DEMS:
            dem = {"key": f"{k}_crop", "kind": "raster", "desc": common[k]["desc"],
                   "mission": "MGS MOLA + MEX HRSC" if k == "dem200" else "MGS MOLA"}
            dest = outdir / f"{k}_crop.tif"
            try:
                crop_global_dem(s, common[k], dest)
                dem.update(path=str(dest.relative_to(DATA_DIR)), bytes=dest.stat().st_size, status="ok",
                           raster=gdal_summary(dest))
            except Exception as e:
                dem.update(status="error", error=str(e)[:400])
                log(f"ERROR {k} {s['id']}: {e}")
            files.append(dem)
        manifest["sites"][s["id"]] = {"name": s["name"], "rover": s["rover"], "center": s["center"],
                                      "bbox": s["bbox"], "notes": s.get("notes"), "files": files}

    (DATA_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    log(f"manifest written: {DATA_DIR / 'manifest.json'}")

    if args.sync:
        bucket = os.environ.get("BUCKET")
        if not bucket:
            log("BUCKET not set; skipping sync")
        else:
            log(f"sync {RAW} -> s3://{bucket}/raw")
            subprocess.run(["aws", "s3", "sync", str(RAW), f"s3://{bucket}/raw", "--only-show-errors"], check=True)
            subprocess.run(["aws", "s3", "cp", str(DATA_DIR / "manifest.json"), f"s3://{bucket}/manifest.json"], check=True)
            log("sync done")

    errors = [f for s in manifest["sites"].values() for f in s["files"] if f["status"] == "error"]
    errors += [f for f in manifest["common"] if f["status"] == "error"]
    if errors:
        log(f"finished with {len(errors)} error(s)")
        sys.exit(1)
    log("finished OK")


if __name__ == "__main__":
    main()
