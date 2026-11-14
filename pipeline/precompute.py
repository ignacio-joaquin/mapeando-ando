#!/usr/bin/env python3
"""Precómputo de capas de terreno para un sitio (sites/<id>.json).

A partir del DTM HiRISE del sitio genera, en <out>/<sitio>/:
  dtm.tif        DTM como Cloud-Optimized GeoTIFF
  slope.tif      pendiente en grados (misma grilla que el DTM)
  hillshade.tif  sombreado del relieve (solo visual)
  contours.gpkg  curvas de nivel

El código no depende del sitio: todo sale de sites/<id>.json.

Uso:
  python pipeline/precompute.py --site jezero --out ~/output --prueba   # recorte 2x2 km, rápido
  python pipeline/precompute.py --site jezero --out ~/output            # DTM completo
"""
import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent          # carpeta raíz del repo
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))   # donde están raw/ y output/ en el server

# Parámetros de las capas (los mismos para todos los sitios)
CONTOUR_INTERVAL_M = 5   # una curva cada 5 m
HILLSHADE_Z = 3          # exageración vertical del sombreado (solo visual)
PRUEBA_PX = 2000         # tamaño del recorte en modo --prueba (2000 px = 2 km)

# Opciones para los GeoTIFF de pendiente y sombreado: en bloques, comprimidos y
# con soporte para archivos de más de 4 GB (Gale es grande).
GTIFF_OPTS = ["-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=IF_SAFER"]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run(cmd):
    """Corre un comando de terminal. Si falla, corta el script mostrando el error."""
    log("$ " + " ".join(cmd))
    subprocess.run(cmd, check=True)


def load_site(site_id):
    """Lee sites/<site_id>.json."""
    path = ROOT / "sites" / f"{site_id}.json"
    if not path.exists():
        disponibles = sorted(p.stem for p in (ROOT / "sites").glob("*.json") if p.stem != "common")
        raise SystemExit(f"No existe {path}. Sitios disponibles: {disponibles}")
    return json.loads(path.read_text())


def bucket_name():
    """Nombre del bucket de S3: variable BUCKET o /etc/mapeando.env."""
    if os.environ.get("BUCKET"):
        return os.environ["BUCKET"]
    try:
        for line in Path("/etc/mapeando.env").read_text().splitlines():
            line = line.strip().removeprefix("export ")
            if line.startswith("BUCKET="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except (FileNotFoundError, PermissionError):
        pass
    return None


def find_input(site, key):
    """Ruta para leer el archivo `key` del sitio: el disco del server si está, si no S3."""
    entry = next((f for f in site["files"] if f["key"] == key), None)
    if entry is None:
        raise SystemExit(f"sites/{site['id']}.json no tiene un archivo con key '{key}'")
    filename = Path(urlparse(entry["url"]).path).name
    local = DATA_DIR / "raw" / site["id"] / filename
    if local.exists():
        return str(local)
    bucket = bucket_name()
    if not bucket:
        raise SystemExit(f"No encuentro {local} y no sé el bucket de S3. "
                         "Corré antes: export BUCKET=<nombre-del-bucket>")
    return f"/vsis3/{bucket}/raw/{site['id']}/{filename}"


def raster_size(path):
    """[ancho, alto] en píxeles."""
    out = subprocess.run(["gdalinfo", "-json", path], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)["size"]


def main():
    ap = argparse.ArgumentParser(description="Precómputo de capas de terreno de un sitio")
    ap.add_argument("--site", required=True, help="id del sitio (nombre del JSON en sites/)")
    ap.add_argument("--out", default=str(DATA_DIR / "output"), help="carpeta base de salida")
    ap.add_argument("--prueba", action="store_true",
                    help=f"procesar solo un recorte de {PRUEBA_PX}x{PRUEBA_PX} px del centro")
    args = ap.parse_args()

    t0 = time.time()
    site = load_site(args.site)
    carpeta = site["id"] + ("_prueba" if args.prueba else "")
    out = Path(args.out).expanduser() / carpeta
    out.mkdir(parents=True, exist_ok=True)

    src = find_input(site, "dtm")
    log(f"Sitio: {site['name']}")
    log(f"DTM de entrada: {src}")
    log(f"Salidas en: {out}")

    dtm = out / "dtm.tif"
    slope = out / "slope.tif"
    hillshade = out / "hillshade.tif"
    contours = out / "contours.gpkg"

    # 1. DTM -> COG. Es el único paso que lee el original (lento si viene de S3);
    #    todo lo demás sale de este archivo local.
    cmd = ["gdal_translate", "-of", "COG", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=YES"]
    if args.prueba:
        ancho, alto = raster_size(src)
        x0, y0 = ancho // 2 - PRUEBA_PX // 2, alto // 2 - PRUEBA_PX // 2
        cmd += ["-srcwin", str(x0), str(y0), str(PRUEBA_PX), str(PRUEBA_PX)]
    run(cmd + [src, str(dtm)])

    # 2. Pendiente en grados, en la misma grilla que el DTM (la usa el planificador).
    #    -compute_edges evita que el borde quede sin dato.
    run(["gdaldem", "slope", str(dtm), str(slope), "-compute_edges", *GTIFF_OPTS])

    # 3. Sombreado: solo para ver el relieve en el mapa, con exageración vertical.
    run(["gdaldem", "hillshade", str(dtm), str(hillshade),
         "-z", str(HILLSHADE_Z), "-compute_edges", *GTIFF_OPTS])

    # 4. Curvas de nivel. gdal_contour no pisa un archivo existente: se borra antes.
    contours.unlink(missing_ok=True)
    run(["gdal_contour", "-a", "elev", "-i", str(CONTOUR_INTERVAL_M), str(dtm), str(contours)])

    log("Listo. Archivos generados:")
    for p in (dtm, slope, hillshade, contours):
        log(f"  {p.name:15s} {p.stat().st_size / 1e6:8.1f} MB")
    log(f"Tiempo total: {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()