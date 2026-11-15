#!/usr/bin/env python3
"""Nombres de objetivo de PIXL (Mars 2020), desde las etiquetas PDS4.

PIXL no publica una lista de objetivos: el nombre está solo en la etiqueta .xml de cada
producto. Este script lee el inventario de la colección (lo baja download.py, key
`pixl_inventory` de sites/<sitio>.json), baja UNA etiqueta por observación y escribe
/data/raw/<sitio>/targets/<key>.csv con:

    obs_id, sol, site, drive, target

Site y drive salen del nombre del producto (`..__<site 3><drive 4>...`); places.py los cruza con
los waypoints del rover. PIXL va en el brazo: el objetivo está al lado del rover.

SHERLOC no entra: sus etiquetas no traen el nombre del objetivo (revisado en productos de
ciencia del sol 1213), solo el de los blancos de calibración.

Educado con PDS (skill mapeando-geodata): un pedido a la vez, Crawl-delay de 10 s, User-Agent
identificable y espera larga ante 429/503. Se reanuda: lo ya escrito no se vuelve a pedir.
Son ~110 etiquetas: ~20 minutos.

    python3 pipeline/fetch_targets.py                 # todos los sitios que declaran inventarios
    python3 pipeline/fetch_targets.py --site jezero
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

UA = "mapeando-ando/1.0 (NASA Space Apps 2026; descarga dirigida de datos PDS)"
DELAY_S = 10          # Crawl-delay del robots.txt de PDS Geosciences
BACKOFF_S = 600       # ante 429/503: esperar en serio, no reintentar en loop
MAX_RETRIES = 3

INVENTORY_KEYS = ("pixl_inventory",)
FIELDS = ["obs_id", "sol", "site", "drive", "target"]

# urn:nasa:pds:mars2020_pixl:data_oxides_pmc:ps__0125_0678032243_000rqa__0041712...::1.1
LID = re.compile(r"^[PS],(urn:nasa:pds:[^:]+:([^:]+):([a-z]{2}__(\d{4})_(\d{10})_[^:]+?))::")
RMC = re.compile(r"__(\d{3})(\d{4})")
# El nombre va en el título de la tabla:
# "PIXL Individual Point Oxide Compositions: Naltsos (Sol 0125), Detector A".
PIXL_TABLE = re.compile(r"<name>PIXL[^<:]*:\s*(.+?)\s*\(Sol \d+\)")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


_last = [0.0]


def get(url):
    """GET educado: Crawl-delay antes de cada pedido y espera larga ante 429/503."""
    for attempt in range(MAX_RETRIES):
        wait = _last[0] + DELAY_S - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.monotonic()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < MAX_RETRIES - 1:
                log(f"{e.code} en {url}: espero {BACKOFF_S} s")
                time.sleep(BACKOFF_S)
                continue
            raise
    raise RuntimeError(f"sin respuesta de {url}")


def observations(inventory_text):
    """Una entrada por observación (sol + reloj): el primer producto de cada una."""
    seen = {}
    for line in inventory_text.splitlines():
        m = LID.match(line.strip())
        if not m:
            continue
        _, collection, product, sol, sclk = m.groups()
        rmc = RMC.search(product)
        if not rmc:
            continue
        seen.setdefault(f"{sol}_{sclk}", {"collection": collection, "product": product, "sol": int(sol),
                                          "site": int(rmc[1]), "drive": int(rmc[2])})
    return seen


def target_from_label(xml):
    """Nombre del objetivo, o None si la etiqueta no lo trae."""
    m = PIXL_TABLE.search(xml)
    return m[1].strip() if m else None


def label_url(inventory_url, obs):
    """La etiqueta vive en <colección>/sol_<5 dígitos>/<producto>.xml, junto al inventario."""
    base = inventory_url.rsplit("/", 1)[0]
    return f"{base}/sol_{obs['sol']:05d}/{obs['product']}.xml"


def local_inventory(site_id, entry):
    path = DATA_DIR / "raw" / site_id / Path(urlparse(entry["url"]).path).name
    return path if path.exists() else None


def run_entry(site_id, entry):
    inv = local_inventory(site_id, entry)
    if inv is None:
        log(f"{site_id}/{entry['key']}: falta el inventario (correr antes download.py)")
        return False
    out = DATA_DIR / "raw" / site_id / "targets" / f"{entry['key']}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        with open(out, newline="") as fh:
            done = {r["obs_id"] for r in csv.DictReader(fh)}
    todo = {k: v for k, v in observations(inv.read_text()).items() if k not in done}
    log(f"{site_id}/{entry['key']}: {len(done)} ya hechas, {len(todo)} por pedir "
        f"(~{len(todo) * DELAY_S / 60:.0f} min)")
    new_file = not out.exists()
    with open(out, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        if new_file:
            w.writeheader()
        for i, (obs_id, obs) in enumerate(sorted(todo.items()), 1):
            try:
                target = target_from_label(get(label_url(entry["url"], obs)))
            except Exception as e:  # una etiqueta que falla no frena el resto; se reintenta otra corrida
                log(f"  {obs_id}: {e}")
                continue
            # Se escribe también sin nombre: así no se vuelve a pedir.
            w.writerow({"obs_id": obs_id, "sol": obs["sol"], "site": obs["site"],
                        "drive": obs["drive"], "target": target or ""})
            fh.flush()
            if i % 25 == 0:
                log(f"  {i}/{len(todo)}")
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description="Nombres de objetivo de PIXL desde etiquetas PDS")
    ap.add_argument("--site", action="append", help="solo estos sitios (repetible)")
    ap.add_argument("--only", action="append", choices=INVENTORY_KEYS, help="solo estos inventarios")
    args = ap.parse_args(argv)
    sites = [json.loads(p.read_text()) for p in sorted((ROOT / "sites").glob("*.json")) if p.stem != "common"]
    ok = True
    for site in sites:
        if args.site and site["id"] not in args.site:
            continue
        for entry in site["files"]:
            if entry["key"] in INVENTORY_KEYS and (not args.only or entry["key"] in args.only):
                ok &= run_entry(site["id"], entry)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
