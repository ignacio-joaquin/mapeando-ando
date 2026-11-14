#!/usr/bin/env python3
"""Descarga dirigida de productos PDS Geosciences (química del rover, RIMFAX, ubicaciones).

No es un crawler: recorre solo los directorios listados abajo, filtra por extensión
y respeta el Crawl-delay del servidor (10 s por pedido). Corre en segundo plano.

Uso: python3 pipeline/fetch_pds.py [--sync] [--delay 10]
"""
import html.parser
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

GEO = "https://pds-geosciences.wustl.edu"
RAW = Path(os.environ.get("DATA_DIR", "/data")) / "raw"
UA = "mapeando-ando/1.0 (NASA Space Apps 2026; descarga dirigida de datos PDS)"
DELAY = float(sys.argv[sys.argv.index("--delay") + 1]) if "--delay" in sys.argv else 10.0

# (directorio remoto, carpeta local, extensiones, profundidad máxima de subdirectorios)
JOBS = [
    ("/m2020/urn-nasa-pds-mars2020_rover_places/data_localizations/", RAW / "jezero/rover_places", (".csv", ".xml"), 0),
    ("/m2020/urn-nasa-pds-mars2020_pixl/data_oxides_pmc/", RAW / "jezero/pixl", (".csv", ".xml"), 1),
    ("/msl/msl-m-chemcam-libs-4_5-rdr-v1/mslccm_1xxx/data/moc/", RAW / "gale/chemcam", (".csv", ".xml", ".lbl"), 0),
    ("/m2020/urn-nasa-pds-mars2020_rimfax/browse_radargram/", RAW / "jezero/rimfax", (".png", ".xml"), 2),
]


def log(m):
    print(time.strftime("[%Y-%m-%dT%H:%M:%SZ] ", time.gmtime()) + m, flush=True)


class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.hrefs += [v for k, v in attrs if k == "href" and v]


def listing(path):
    time.sleep(DELAY)
    req = urllib.request.Request(GEO + path, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        p = Links()
        p.feed(r.read().decode("utf-8", "replace"))
    # solo hijos directos del directorio pedido
    return [h for h in p.hrefs if h.startswith(path) and h != path]


def get(path, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return True
    time.sleep(DELAY)
    dest.parent.mkdir(parents=True, exist_ok=True)
    rc = subprocess.run(["curl", "-sf", "--retry", "4", "-A", UA, "-o", str(dest), GEO + path]).returncode
    return rc == 0


def walk(root, path, out, exts, depth):
    n = 0
    for h in listing(path):
        if h.endswith("/"):
            if depth > 0:
                n += walk(root, h, out, exts, depth - 1)
        elif h.lower().endswith(exts):
            if get(h, out / h[len(root):]):
                n += 1
    return n


def main():
    for root, out, exts, depth in JOBS:
        try:
            n = walk(root, root, out, exts, depth)
            log(f"{root} -> {out}: {n} archivos")
        except Exception as e:
            log(f"ERROR {root}: {e}")
    if "--sync" in sys.argv and os.environ.get("BUCKET"):
        subprocess.run(["aws", "s3", "sync", str(RAW), f"s3://{os.environ['BUCKET']}/raw", "--only-show-errors"])
    log("PDS_DONE")


if __name__ == "__main__":
    main()
