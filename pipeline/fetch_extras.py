#!/usr/bin/env python3
"""Datos complementarios del briefing que no son rasters de sitio.

- Cráteres de Robbins & Hynek 2012 por sitio (API OGC de USGS, recorte por bbox) -> landmarks.
- NASA DONKI: simulaciones WSA-Enlil con impacto en Marte (clima espacial) -> franja de condiciones.
- Modelo de campo magnético cortical de Langlais et al. 2019 (Zenodo) -> dato geofísico de Gale.
- SWIM 2.0: composites globales de hielo subsuperficial (opcional, Could).

Uso: python3 pipeline/fetch_extras.py [--sync]   (DATA_DIR, BUCKET y NASA_API_KEY opcionales)
"""
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
RAW = DATA_DIR / "raw"
ROOT = Path(__file__).resolve().parent.parent


def log(m):
    print(f"[{dt.datetime.now(dt.timezone.utc).strftime('%FT%TZ')}] {m}", flush=True)


def get_json(url, timeout=180):
    req = urllib.request.Request(url, headers={"User-Agent": "mapeando-ando/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def curl(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    rc = subprocess.run(["curl", "-sfL", "--retry", "5", "-o", str(dest), url]).returncode
    if rc != 0:
        dest.unlink(missing_ok=True)
    return rc == 0


def robbins(site):
    b = site["bbox"]
    pad = 1.0  # landmarks visibles en el horizonte, más allá del DTM
    bbox = f"{b['lon_min']-pad},{b['lat_min']-pad},{b['lon_max']+pad},{b['lat_max']+pad}"
    base = "https://astrogeology.usgs.gov/pygeoapi/collections/mars/robbinsv1/items"
    # El servidor limita el tamaño de página: se siguen los links "next" hasta agotar.
    feats, url, seen = [], f"{base}?f=json&bbox={bbox}&limit=500", set()
    while url and url not in seen:
        seen.add(url)
        d = get_json(url)
        feats += d.get("features", [])
        nxt = [l["href"] for l in d.get("links", []) if l.get("rel") == "next"]
        if not nxt or not d.get("features"):
            break
        href = nxt[0]
        url = href if href.startswith("http") else "https://astrogeology.usgs.gov/pygeoapi" + href
        if "f=json" not in url:
            url += "&f=json"
    out = RAW / site["id"] / "landmarks" / "robbins_craters.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "bbox_query": bbox,
                               "source": base, "features": feats}))
    log(f"Robbins {site['id']}: {len(feats)} cráteres")


def donki():
    out = RAW / "common" / "donki"
    out.mkdir(parents=True, exist_ok=True)
    start, end = dt.date(2025, 11, 1), dt.date.today()
    sims, mars = [], []
    while start <= end:
        stop = min(start + dt.timedelta(days=59), end)
        # El endpoint del CCMC no es alcanzable desde AWS; api.nasa.gov con NASA_API_KEY
        # (gratis en api.nasa.gov) o DEMO_KEY, que tiene límite por hora: se espera y reintenta.
        url = ("https://api.nasa.gov/DONKI/WSAEnlilSimulations"
               f"?startDate={start}&endDate={stop}&api_key={os.environ.get('NASA_API_KEY', 'DEMO_KEY')}")
        page = []
        for attempt in range(6):  # DEMO_KEY tiene límite de tasa: reintento con espera creciente
            try:
                page = get_json(url) or []
                break
            except Exception as e:
                log(f"DONKI {start}..{stop} intento {attempt+1}: {e}")
                time.sleep(600)
        time.sleep(5)
        sims += page
        for s in page:
            for imp in s.get("impactList") or []:
                if (imp.get("location") or "").lower() == "mars":
                    mars.append({"simulationID": s.get("simulationID"),
                                 "modelCompletionTime": s.get("modelCompletionTime"),
                                 "arrivalTime": imp.get("arrivalTime"), "isGlancingBlow": imp.get("isGlancingBlow"),
                                 "link": s.get("link")})
        start = stop + dt.timedelta(days=1)
    (out / "wsa_enlil_simulations.json").write_text(json.dumps(sims))
    (out / "mars_impacts.json").write_text(json.dumps(mars, indent=1))
    log(f"DONKI: {len(sims)} simulaciones, {len(mars)} impactos en Marte")


def langlais():
    out = RAW / "common" / "magnetic_langlais2019"
    rec = get_json("https://zenodo.org/api/records/3876714")
    (out).mkdir(parents=True, exist_ok=True)
    (out / "zenodo_record.json").write_text(json.dumps(rec, indent=1))
    for f in rec.get("files", []):
        url = f.get("links", {}).get("self")
        name = f.get("key")
        if url and name:
            ok = curl(url, out / name)
            log(f"Langlais 2019 {name}: {'ok' if ok else 'ERROR'}")


def swim():
    out = RAW / "common" / "swim2"
    base = "https://swim.psi.edu/output/SWIM2/Global/Composite"
    for depth in ("c0_1", "c1_5", "c_5"):
        for name in (f"SWIM2_{depth}_Browse.png", f"SWIM2_{depth}.tif", f"SWIM2_{depth}_GeoTIFF.tif"):
            ok = curl(f"{base}/{name}", out / name)
            log(f"SWIM {name}: {'ok' if ok else 'no disponible'}")


def main():
    sites = [json.loads(p.read_text()) for p in sorted((ROOT / "sites").glob("*.json")) if p.name != "common.json"]
    steps = [("robbins", lambda: [robbins(s) for s in sites]), ("donki", donki),
             ("langlais", langlais), ("swim", swim)]
    failed = []
    for name, fn in steps:
        try:
            fn()
        except Exception as e:
            failed.append(name)
            log(f"ERROR {name}: {e}")
    if "--sync" in sys.argv and os.environ.get("BUCKET"):
        subprocess.run(["aws", "s3", "sync", str(RAW), f"s3://{os.environ['BUCKET']}/raw", "--only-show-errors"])
        log("sync ok")
    log(f"EXTRAS_DONE fallidos={failed}")


if __name__ == "__main__":
    main()
