#!/usr/bin/env python3
"""Precómputo de capas de terreno para un sitio (sites/<id>.json).

A partir del DTM del sitio genera, en <out>/<sitio>/:
  dtm.tif           DTM como Cloud-Optimized GeoTIFF (copia del producto USGS, sin remuestrear)
  slope.tif         pendiente en grados, COG, misma grilla que el DTM
  hillshade.tif     sombreado del relieve, COG (solo visual)
  contours.geojson  curvas de nivel en lon/lat planetocéntricas (este positivo)
  slope/, hillshade/  tiles XYZ PNG para el mapa (pipeline/tiles.py); la pendiente, con los
                    colores de la leyenda de web/src/map/layers.ts
  coverage.geojson  dónde hay DTM de 1 m de verdad (huella de los píxeles válidos), en lon/lat.
                    El planificador rechaza un destino que cae afuera.
  terrain.json      procedencia, parámetros, estado de cada capa y zoom/límites de los tiles.
                    El frontend lo lee para saber qué capa puede prender.

El código no depende del sitio: todo sale de sites/<id>.json y del manifest.

Por qué la pendiente no sale de `gdaldem slope`: gdaldem toma las unidades de la proyección
como metros de suelo, y los DTM de USGS están en equirectangular con paralelo estándar en el
ecuador. A 18,5° N (Jezero) un "metro" de X mide 0,948 m sobre el suelo y gdaldem subestima la
pendiente este-oeste (30° reales salen 28,7°). Acá cada fila usa su tamaño de píxel real sobre
la esfera de 3396190 m (terrain_shadows.ground_jacobian).

Uso:
  python pipeline/precompute.py --site jezero --prueba   # recorte de 2x2 km en DATA_DIR/prueba/
  python pipeline/precompute.py --site jezero            # DTM completo en DATA_DIR/output/

Sale con 0 si todo anduvo, 1 si falló alguna capa (las demás quedan) y 2 si faltan datos.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import rasterio
from rasterio import features
from rasterio.transform import Affine
from rasterio.warp import transform as warp_transform
from rasterio.warp import transform_geom
from rasterio.windows import Window

sys.path.insert(0, str(Path(__file__).resolve().parent))
import terrain_shadows as ts  # noqa: E402
import tiles  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent          # carpeta raíz del repo
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))   # donde están raw/ y output/ en el server
ENV_FILE = Path("/etc/mapeando.env")
MARS_LONGLAT = f"+proj=longlat +R={ts.MARS_RADIUS_M:.0f} +no_defs"

# Parámetros de las capas (los mismos para todos los sitios)
CONTOUR_INTERVAL_M = 10    # igual que la leyenda de relief-contours en web/src/map/layers.ts
CONTOUR_SIMPLIFY_M = 0.5   # medio píxel de 1 m: no se nota en el mapa y achica el GeoJSON
CONTOUR_DECIMALS = 6       # 1e-6° ≈ 6 cm en Marte
HILLSHADE_Z = 3            # exageración vertical del sombreado (solo visual)
HILLSHADE_AZIMUTH_DEG = 315
HILLSHADE_ALTITUDE_DEG = 45
COVERAGE_CELL_PX = 10     # celda de la máscara de cobertura: 10 px = 10 m en un DTM de 1 m
PRUEBA_PX = 2000           # tamaño del recorte en modo --prueba (2000 px = 2 km a 1 m/px)

SLOPE_NODATA = -9999.0
BAD_Z_M = 1e5              # |z| mayor que esto es basura (los DTM marcan nodata con ±3,4e38)
STRIP_PX = 8_000_000       # píxeles por franja al calcular la pendiente (~32 MB por arreglo)
JAC_STEP = 64              # cada cuántas filas se calcula el píxel sobre el suelo (se interpola entre medio)
MAX_COL_VARIATION = 0.005  # si el píxel cambia más que esto a lo ancho del DTM, se avisa

# Capas que se teselan para el mapa: carpeta de salida y rampa de color de tiles.py.
# La carpeta es CONTRATO: el último segmento de la plantilla `tiles` de web/src/map/layers.ts.
TILED_LAYERS = {"relief-slope": ("slope", "pendiente"), "relief-hillshade": ("hillshade", None)}
# La ortoimagen no sale del DTM: se tesela del producto de USGS y se pide con --ortho.
ORTHO_LAYER = "base-ortho"

GTIFF_OPTS = ["-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=IF_SAFER"]
COG_OPTS = ["-of", "COG", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=YES", "-co", "BIGTIFF=IF_SAFER"]


class DataNotReady(Exception):
    """Faltan datos de entrada (la descarga todavía no terminó o la ruta está mal)."""


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run(cmd):
    """Corre un comando de terminal. Si falla, levanta CalledProcessError."""
    log("$ " + " ".join(cmd))
    subprocess.run(cmd, check=True)


# ------------------------------------------------------------------ entradas

def load_site(site_id):
    """Lee sites/<site_id>.json."""
    path = ROOT / "sites" / f"{site_id}.json"
    if not path.exists():
        disponibles = sorted(p.stem for p in (ROOT / "sites").glob("*.json") if p.stem != "common")
        raise DataNotReady(f"No existe {path}. Sitios disponibles: {disponibles}")
    return json.loads(path.read_text())


def bucket_name():
    """Nombre del bucket de S3: variable BUCKET o /etc/mapeando.env."""
    if os.environ.get("BUCKET"):
        return os.environ["BUCKET"]
    try:
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip().removeprefix("export ")
            if line.startswith("BUCKET="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except (FileNotFoundError, PermissionError):
        pass
    return None


def find_input(site, key):
    """Ruta para leer el archivo `key` del sitio.

    1. Lo que diga el manifest, si lo marca `ok` (download.py verificó que abre).
    2. Si el manifest no lo menciona, el archivo en raw/<sitio>/ con el nombre de la URL.
       Si el manifest lo menciona pero no está `ok`, el archivo local puede estar a medio
       bajar y no se usa.
    3. La copia de S3.
    """
    entry = next((f for f in site["files"] if f["key"] == key), None)
    if entry is None:
        raise DataNotReady(f"sites/{site['id']}.json no tiene un archivo con key '{key}'")

    in_manifest = None
    manifest = DATA_DIR / "manifest.json"
    if manifest.exists():
        files = json.loads(manifest.read_text()).get("sites", {}).get(site["id"], {}).get("files", [])
        in_manifest = next((f for f in files if f.get("key") == key), None)
    if in_manifest and in_manifest.get("status") == "ok":
        path = DATA_DIR / in_manifest["path"]
        if path.exists():
            return str(path)

    filename = Path(urlparse(entry["url"]).path).name
    local = DATA_DIR / "raw" / site["id"] / filename
    if in_manifest is None and local.exists():
        return str(local)

    bucket = bucket_name()
    if not bucket:
        raise DataNotReady(f"El '{key}' de {site['id']} todavía no está descargado en {DATA_DIR / 'raw'} "
                           "y no sé el bucket de S3. Corré antes: export BUCKET=<nombre-del-bucket>")
    return f"/vsis3/{bucket}/raw/{site['id']}/{filename}"


def raster_size(path):
    """[ancho, alto] en píxeles. Sirve también para verificar que el raster abre."""
    out = subprocess.run(["gdalinfo", "-json", path], capture_output=True, text=True)
    if out.returncode != 0:
        raise DataNotReady(f"No puedo abrir {path}: {out.stderr.strip()[:300]}")
    return json.loads(out.stdout)["size"]


def gdal_version():
    out = subprocess.run(["gdalinfo", "--version"], capture_output=True, text=True)
    return out.stdout.strip() or None


# ------------------------------------------------------------------ pendiente

def lonlat_fn(ds):
    """(cols, rows) del centro de píxel -> (lon, lat) planetocéntricas sobre la esfera de Marte."""
    t = ds.transform

    def f(cols, rows):
        c, r = np.asarray(cols, float) + 0.5, np.asarray(rows, float) + 0.5
        xs, ys = t.a * c + t.b * r + t.c, t.d * c + t.e * r + t.f
        lons, lats = warp_transform(ds.crs, MARS_LONGLAT, xs.tolist(), ys.tolist())
        return np.asarray(lons), np.asarray(lats)

    return f


def row_jacobians(ds):
    """Jacobiano píxel -> metros de suelo de cada fila, en la columna central. (alto, 2, 2)

    Se calcula cada JAC_STEP filas y se interpola: en un DTM de sitio varía como cos(lat),
    muy suave (el error de interpolar es del orden de 1e-9).
    """
    f = lonlat_fn(ds)
    cc = (ds.width - 1) / 2.0
    sample = np.unique(np.r_[np.arange(0, ds.height, JAC_STEP), ds.height - 1])
    jacs = np.array([ts.ground_jacobian(f, cc, float(r)) for r in sample]).reshape(len(sample), 4)
    rows = np.arange(ds.height)
    return np.stack([np.interp(rows, sample, jacs[:, k]) for k in range(4)], axis=1).reshape(-1, 2, 2)


def column_variation(ds):
    """Cuánto cambia el tamaño del píxel este-oeste entre el borde y el centro de la fila central."""
    f = lonlat_fn(ds)
    rc = (ds.height - 1) / 2.0
    sizes = [np.hypot(*ts.ground_jacobian(f, c, rc)[:, 0]) for c in (0.0, (ds.width - 1) / 2.0, ds.width - 1.0)]
    return float(max(abs(sizes[0] - sizes[1]), abs(sizes[2] - sizes[1])) / sizes[1])


def slope_strip(z, valid, jinv):
    """Pendiente en grados de las filas internas de `z`, con el operador de Horn (3x3).

    z, valid: (n + 2, ancho), con una fila de contexto arriba y otra abajo.
    jinv: (n, 2, 2), inversa del jacobiano píxel -> (este, norte) en metros de cada fila.
    Devuelve (n, ancho) float32 con NaN donde falta algún vecino, incluidas la primera y la
    última columna: el borde queda sin dato en vez de inventarle vecinos.
    """
    z = np.where(valid, z, 0).astype(np.float32)
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    dz_dcol = ((c + 2 * f + i) - (a + 2 * d + g)) / 8.0
    dz_drow = ((g + 2 * h + i) - (a + 2 * b + c)) / 8.0
    # gradiente sobre el suelo = J^-T · gradiente en píxeles
    ge = jinv[:, 0, 0, None] * dz_dcol + jinv[:, 1, 0, None] * dz_drow
    gn = jinv[:, 0, 1, None] * dz_dcol + jinv[:, 1, 1, None] * dz_drow
    s = np.degrees(np.arctan(np.hypot(ge, gn)))

    v = valid
    ok = (v[:-2, :-2] & v[:-2, 1:-1] & v[:-2, 2:] & v[1:-1, :-2] & v[1:-1, 1:-1] & v[1:-1, 2:]
          & v[2:, :-2] & v[2:, 1:-1] & v[2:, 2:])
    out = np.full((z.shape[0] - 2, z.shape[1]), np.nan, dtype=np.float32)
    out[:, 1:-1] = np.where(ok, s, np.nan)
    return out


def compute_slope(dtm, dst):
    """Escribe la pendiente de `dtm` en `dst` (GTiff en bloques), misma grilla. Devuelve info de la grilla."""
    with rasterio.open(dtm) as ds:
        h, w = ds.height, ds.width
        jac = row_jacobians(ds)
        jinv = np.linalg.inv(jac)
        profile = dict(driver="GTiff", width=w, height=h, count=1, dtype="float32", crs=ds.crs,
                       transform=ds.transform, nodata=SLOPE_NODATA, tiled=True, blockxsize=512,
                       blockysize=512, compress="deflate", predictor=3, BIGTIFF="IF_SAFER")
        strip = max(1, STRIP_PX // w)
        with rasterio.open(dst, "w", **profile) as out:
            for r0 in range(0, h, strip):
                r1 = min(h, r0 + strip)
                q0, q1 = max(0, r0 - 1), min(h, r1 + 1)
                band = ds.read(1, window=Window(0, q0, w, q1 - q0), masked=True)
                z = band.astype(np.float32).filled(np.nan)
                valid = np.isfinite(z) & (np.abs(z) < BAD_Z_M)
                if r0 == 0:          # sin fila de contexto arriba: la primera fila queda sin dato
                    z, valid = np.vstack([z[:1], z]), np.vstack([np.zeros((1, w), bool), valid])
                if r1 == h:          # ídem abajo
                    z, valid = np.vstack([z, z[-1:]]), np.vstack([valid, np.zeros((1, w), bool)])
                s = slope_strip(z, valid, jinv[r0:r1])
                out.write(np.where(np.isnan(s), SLOPE_NODATA, s).astype(np.float32), 1,
                          window=Window(0, r0, w, r1 - r0))
        center = jac[h // 2]
        return {"pixel_ground_m": [round(float(np.hypot(*center[:, 0])), 4),
                                   round(float(np.hypot(*center[:, 1])), 4)],
                "column_variation": column_variation(ds),
                "shape": [h, w]}


# ------------------------------------------------------------------ cobertura

def coverage_mask(dtm, cell=COVERAGE_CELL_PX):
    """Máscara de cobertura: celdas de `cell` x `cell` píxeles donde TODOS los píxeles del DTM
    tienen dato. Conservadora a propósito: una celda con un solo hueco queda afuera, así un
    destino aceptado nunca cae sobre nodata. Se lee por franjas, sin cargar el DTM entero.

    Devuelve (máscara uint8 1/0, transform de la grilla de celdas, crs).
    """
    with rasterio.open(dtm) as ds:
        h, w = ds.height, ds.width
        ch, cw = -(-h // cell), -(-w // cell)
        mask = np.zeros((ch, cw), dtype=np.uint8)
        strip = max(1, STRIP_PX // (w * cell))        # filas de celdas por franja
        for c0 in range(0, ch, strip):
            c1 = min(ch, c0 + strip)
            r0, r1 = c0 * cell, min(h, c1 * cell)
            band = ds.read(1, window=Window(0, r0, w, r1 - r0), masked=True)
            z = band.astype(np.float32).filled(np.nan)
            valid = np.isfinite(z) & (np.abs(z) < BAD_Z_M)
            # La última fila y columna de celdas pueden quedar incompletas: se rellenan con
            # "sin dato" y quedan afuera.
            full = np.zeros(((c1 - c0) * cell, cw * cell), dtype=bool)
            full[: r1 - r0, :w] = valid
            mask[c0:c1] = full.reshape(c1 - c0, cell, cw, cell).all(axis=(1, 3))
        return mask, ds.transform @ Affine.scale(cell), ds.crs


def coverage_geojson(mask, transform, crs):
    """Polígonos de las celdas con dato, en lon/lat planetocéntricas (este positivo)."""
    feats = []
    for geom, value in features.shapes(mask, mask=mask == 1, transform=transform):
        if value != 1:
            continue
        g = transform_geom(crs, MARS_LONGLAT, geom, precision=CONTOUR_DECIMALS)
        feats.append({"type": "Feature", "properties": {}, "geometry": g})
    return {"type": "FeatureCollection", "features": feats}


def compute_coverage(dtm, dst, cell=COVERAGE_CELL_PX):
    """Escribe coverage.geojson. Devuelve celdas con dato, celdas totales y cantidad de polígonos."""
    mask, transform, crs = coverage_mask(dtm, cell)
    fc = coverage_geojson(mask, transform, crs)
    Path(dst).write_text(json.dumps(fc, separators=(",", ":")))
    return {"cells_ok": int(mask.sum()), "cells": int(mask.size), "features": len(fc["features"])}


# ------------------------------------------------------------------ salidas

def to_cog(src, dst):
    run(["gdal_translate", *COG_OPTS, str(src), str(dst)])


def publish(tmp, dst):
    """Mueve una salida terminada a su lugar de un solo paso: nginx nunca sirve un archivo a medias."""
    os.replace(tmp, dst)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Precómputo de capas de terreno de un sitio")
    ap.add_argument("--site", required=True, help="id del sitio (nombre del JSON en sites/)")
    ap.add_argument("--out", help="carpeta base de salida (default: DATA_DIR/output, o DATA_DIR/prueba con --prueba)")
    ap.add_argument("--prueba", action="store_true",
                    help=f"procesar solo un recorte de {PRUEBA_PX}x{PRUEBA_PX} px del centro")
    ap.add_argument("--no-tiles", action="store_true", help="no generar los tiles PNG del mapa")
    ap.add_argument("--ortho", action="store_true",
                    help="teselar también la ortoimagen del sitio. Va aparte porque es la capa "
                         "más cara: en Jezero son 7,4 GB a 25 cm/px y tarda horas")
    ap.add_argument("--max-zoom", type=int, default=None, dest="max_zoom",
                    help="tope de zoom al teselar; por defecto lo deduce gdal2tiles del tamaño "
                         "del píxel. Para la ortoimagen conviene ponerlo")
    args = ap.parse_args(argv)

    t0 = time.time()
    try:
        site = load_site(args.site)
        src = find_input(site, "dtm")
        width, height = raster_size(src)
    except DataNotReady as e:
        log(f"Faltan datos: {e}")
        return 2

    base = Path(args.out).expanduser() if args.out else DATA_DIR / ("prueba" if args.prueba else "output")
    out = base / site["id"]
    work = out / ".work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    log(f"Sitio: {site['name']}")
    log(f"DTM de entrada: {src} ({width}x{height} px)")
    log(f"Salidas en: {out}")

    dtm = out / "dtm.tif"
    entry = next(f for f in site["files"] if f["key"] == "dtm")
    index = {
        "site": site["id"],
        "name": site["name"],
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mode": "prueba" if args.prueba else "completo",
        "source": {"key": "dtm", "desc": entry.get("desc"), "mission": entry.get("mission"),
                   "url": entry.get("url"), "read_from": src},
        "radius_m": ts.MARS_RADIUS_M,
        "gdal": gdal_version(),
        "layers": {},
        "warnings": [],
    }
    layers = index["layers"]

    # 1. DTM -> COG. Es el único paso que lee el original (lento si viene de S3);
    #    todo lo demás sale de este archivo local. Si falla, no hay nada más que hacer.
    cmd = ["gdal_translate", *COG_OPTS]
    if args.prueba:
        size_x, size_y = min(PRUEBA_PX, width), min(PRUEBA_PX, height)
        x0, y0 = (width - size_x) // 2, (height - size_y) // 2
        cmd += ["-srcwin", str(x0), str(y0), str(size_x), str(size_y)]
        index["source"]["srcwin"] = [x0, y0, size_x, size_y]
    try:
        run(cmd + [src, str(work / "dtm.tif")])
        publish(work / "dtm.tif", dtm)
    except subprocess.CalledProcessError as e:
        log(f"No pude convertir el DTM: {e}")
        shutil.rmtree(work, ignore_errors=True)
        return 1
    layers["dtm"] = {"file": "dtm.tif", "status": "ok", "unit": "m", "provenance": "OBSERVED",
                     "mission": entry.get("mission"),
                     "note": "Copia del DTM de USGS en COG: mismo dato y misma grilla, solo cambia el formato."}

    # 2. Pendiente en grados, en la misma grilla que el DTM (la usa el planificador).
    def slope_step():
        info = compute_slope(dtm, work / "slope_raw.tif")
        to_cog(work / "slope_raw.tif", work / "slope.tif")
        publish(work / "slope.tif", out / "slope.tif")
        px_e, px_n = info["pixel_ground_m"]
        index["grid"] = {"shape": info["shape"], "pixel_ground_m": info["pixel_ground_m"]}
        # Hillshade y curvas salen de la misma grilla: comparten la resolución.
        resolution = f"{px_e:.2f} m (E-O) x {px_n:.2f} m (N-S) por píxel"
        for layer_id in ("relief-slope", "relief-hillshade", "relief-contours"):
            layers[layer_id]["resolution"] = resolution
        if info["column_variation"] > MAX_COL_VARIATION:
            index["warnings"].append(
                f"El tamaño del píxel este-oeste cambia {info['column_variation']:.1%} a lo ancho del DTM; "
                "la pendiente usa el del centro de cada fila.")
        if abs(px_e / px_n - 1) > 0.01:
            index["warnings"].append(
                f"El píxel mide {px_e:.3f} x {px_n:.3f} m sobre el suelo. La pendiente lo corrige; "
                "el sombreado (gdaldem) no, pero es solo visual.")

    layers["relief-slope"] = {
        "file": "slope.tif", "unit": "°", "provenance": "DERIVED", "mission": entry.get("mission"),
        "nodata": SLOPE_NODATA,
        "method": "Horn 3x3 con el tamaño de píxel real sobre el suelo, fila por fila "
                  f"(esfera de {ts.MARS_RADIUS_M:.0f} m).",
        "assumptions": ["Pendiente a la escala del DTM: no ve rocas ni escalones más chicos que el píxel.",
                        "Sin dato en el borde del DTM y alrededor de cada hueco del DTM."],
    }

    # 3. Sombreado: solo para ver el relieve en el mapa, con exageración vertical.
    def hillshade_step():
        run(["gdaldem", "hillshade", str(dtm), str(work / "hillshade_raw.tif"),
             "-z", str(HILLSHADE_Z), "-az", str(HILLSHADE_AZIMUTH_DEG), "-alt", str(HILLSHADE_ALTITUDE_DEG),
             "-compute_edges", *GTIFF_OPTS])
        to_cog(work / "hillshade_raw.tif", work / "hillshade.tif")
        publish(work / "hillshade.tif", out / "hillshade.tif")

    layers["relief-hillshade"] = {
        "file": "hillshade.tif", "unit": None, "provenance": "DERIVED", "mission": entry.get("mission"),
        "params": {"z_factor": HILLSHADE_Z, "azimuth_deg": HILLSHADE_AZIMUTH_DEG,
                   "altitude_deg": HILLSHADE_ALTITUDE_DEG},
        "assumptions": ["Iluminación sintética fija: no es la luz real del momento.",
                        f"Relieve exagerado x{HILLSHADE_Z} en vertical."],
    }

    # 4. Curvas de nivel: en la proyección del DTM, simplificadas en metros y recién al final
    #    pasadas a lon/lat para el mapa.
    def contours_step():
        run(["gdal_contour", "-a", "elev", "-i", str(CONTOUR_INTERVAL_M), str(dtm), str(work / "contours_raw.gpkg")])
        run(["ogr2ogr", "-f", "GPKG", "-simplify", str(CONTOUR_SIMPLIFY_M),
             str(work / "contours_simple.gpkg"), str(work / "contours_raw.gpkg")])
        run(["ogr2ogr", "-f", "GeoJSON", "-t_srs", MARS_LONGLAT,
             "-lco", f"COORDINATE_PRECISION={CONTOUR_DECIMALS}",
             str(work / "contours.geojson"), str(work / "contours_simple.gpkg")])
        publish(work / "contours.geojson", out / "contours.geojson")

    layers["relief-contours"] = {
        "file": "contours.geojson", "unit": "m", "provenance": "DERIVED", "mission": entry.get("mission"),
        "params": {"interval_m": CONTOUR_INTERVAL_M, "attribute": "elev", "simplify_m": CONTOUR_SIMPLIFY_M},
        "crs": MARS_LONGLAT,
    }

    # 5. Cobertura: dónde hay DTM de 1 m de verdad. El planificador rechaza destinos afuera.
    def coverage_step():
        info = compute_coverage(dtm, work / "coverage.geojson")
        publish(work / "coverage.geojson", out / "coverage.geojson")
        layers["coverage"]["stats"] = info
        if info["cells_ok"] == 0:
            raise RuntimeError("El DTM no tiene ninguna celda completa con dato")

    layers["coverage"] = {
        "file": "coverage.geojson", "unit": None, "provenance": "DERIVED", "mission": entry.get("mission"),
        "resolution": f"celdas de {COVERAGE_CELL_PX} x {COVERAGE_CELL_PX} píxeles del DTM",
        "params": {"cell_px": COVERAGE_CELL_PX},
        "crs": MARS_LONGLAT,
        "assumptions": ["Una celda cuenta solo si todos sus píxeles del DTM tienen dato: el borde "
                        "real del DTM puede quedar hasta una celda más afuera."],
    }

    # Un paso que falla no frena a los demás: el terrain.json dice qué quedó y qué no.
    failed = False
    for layer_id, fn in (("relief-slope", slope_step), ("relief-hillshade", hillshade_step),
                         ("relief-contours", contours_step), ("coverage", coverage_step)):
        try:
            fn()
            layers[layer_id]["status"] = "ok"
        except Exception as e:  # seguir con la próxima capa
            failed = True
            log(f"Falló {layer_id}: {e}")
            layers[layer_id].update(status="error", error=str(e)[:400])

    # 6. Tiles PNG para el mapa, desde los COG que quedaron bien.
    missing_tools = tiles.faltan_herramientas()
    for layer_id, (folder, color) in TILED_LAYERS.items():
        layer = layers[layer_id]
        if args.no_tiles or layer.get("status") != "ok":
            continue
        if missing_tools:
            failed = True
            layer["tiles"] = {"status": "error", "error": "Faltan herramientas de GDAL: " + ", ".join(missing_tools)}
            continue
        try:
            layer["tiles"] = {"status": "ok", **tiles.raster_a_tiles(
                out / layer["file"], out / folder, color=color, max_zoom=args.max_zoom)}
        except Exception as e:  # seguir con la próxima capa
            failed = True
            log(f"Falló el teselado de {layer_id}: {e}")
            layer["tiles"] = {"status": "error", "error": str(e)[:400]}

    # 7. Ortoimagen: el basemap. Se tesela directo del producto de USGS, recortada
    #    al bbox del sitio; no se pasa a COG ni se deriva nada de ella, es imagen
    #    real. Va aparte y hay que pedirla con --ortho: en Jezero son 7,4 GB a
    #    25 cm/px y teselarla compite por disco y CPU con la descarga.
    ortho_entry = next((f for f in site["files"] if f["key"] == "ortho"), None)
    if args.ortho and not args.no_tiles:
        layers[ORTHO_LAYER] = {
            "file": "ortho", "unit": None, "provenance": "OBSERVED",
            "mission": (ortho_entry or {}).get("mission"),
            "desc": (ortho_entry or {}).get("desc"),
            "note": "Imagen real, sin realce. Recortada al bbox del sitio.",
            "assumptions": ["Recortada al bbox de sites/<sitio>.json: afuera no hay imagen."],
        }
        try:
            if ortho_entry is None:
                raise DataNotReady(f"sites/{site['id']}.json no declara un archivo con key 'ortho'")
            if missing_tools:
                raise RuntimeError("Faltan herramientas de GDAL: " + ", ".join(missing_tools))
            bbox = site["bbox"]
            te = [bbox["lon_min"], bbox["lat_min"], bbox["lon_max"], bbox["lat_max"]]
            info = tiles.raster_a_tiles(Path(find_input(site, "ortho")), out / "ortho",
                                        max_zoom=args.max_zoom, te=te)
            layers[ORTHO_LAYER].update(status="ok", tiles={"status": "ok", **info})
        except Exception as e:
            failed = True
            log(f"Falló el teselado de {ORTHO_LAYER}: {e}")
            layers[ORTHO_LAYER].update(status="error", error=str(e)[:400])

    (work / "terrain.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    publish(work / "terrain.json", out / "terrain.json")
    shutil.rmtree(work, ignore_errors=True)

    log("Listo. Archivos generados:")
    for layer in layers.values():
        p = out / layer["file"]
        if layer.get("status") == "ok" and p.is_dir():
            log(f"  {p.name + '/':17s} {'solo tiles':>13s}")  # la ortoimagen no deja un archivo
        elif layer.get("status") == "ok" and p.exists():
            log(f"  {p.name:17s} {p.stat().st_size / 1e6:8.1f} MB")
        else:
            log(f"  {layer['file']:17s} ERROR")
        t = layer.get("tiles")
        if t:
            log(f"    tiles: {t['template']} zoom {t['minzoom']}-{t['maxzoom']}, {t['count']} PNG"
                if t["status"] == "ok" else f"    tiles: ERROR {t['error']}")
    for w in index["warnings"]:
        log(f"Aviso: {w}")
    log(f"Tiempo total: {(time.time() - t0) / 60:.1f} min")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
