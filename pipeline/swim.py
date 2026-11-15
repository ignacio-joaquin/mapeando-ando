#!/usr/bin/env python3
"""Capa de agua: consistencia de hielo somero de SWIM 2.0 (0-1 m), MODELED.

Qué es SWIM: el proyecto Subsurface Water Ice Mapping (PSI, financiado por NASA) combina datos
de varios orbitadores (neutrones de Mars Odyssey, térmico de MGS TES y THEMIS, geomorfología de
MRO y radar SHARAD) en un índice de "consistencia de hielo" por píxel de ~3 km:
  +1 = todos los datos son consistentes con hielo, 0 = sin indicio, -1 = los datos van en contra.
No es una medición de cuánto hielo hay: es un índice que combina datos con pesos del equipo de
SWIM. Por eso la capa es MODELED.

Qué usamos: solo el composite de 0-1 m (SWIM2_c0_1.tif), que es la profundidad accesible para
una EVA. Los de 1-5 m y >5 m se descartaron (docs/context.md §5): en Jezero y Gale el de 1-5 m
salta entre -0,5 y +0,5 con media ~0 y el de >5 m es 0 en todo el sitio.

Entrada: raw/common/swim2/SWIM2_c0_1.tif (lo baja pipeline/fetch_extras.py). Grilla global
equirectangular de ~2964 m, -60° a 60° de latitud, sin dato = -100 (la web de SWIM dice -30:
se aceptan los dos).

Salida (en out_dir):
  ice_consistency.tif  el composite recortado a la huella del DTM, en su grilla y con sus
                       valores originales (float32, -100 = sin dato). Sin remuestrear.

Uso suelto, para experimentar sobre una carpeta que ya tenga dtm.tif:
  python pipeline/swim.py --dir /data/prueba/jezero
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import rasterio

import thermal

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

SWIM_FILE = "SWIM2_c0_1.tif"      # composite de 0-1 m
SWIM_NODATA = -100.0              # el que traen los GeoTIFF de SWIM 2.0
OTHER_NODATA = (-30.0,)           # el que documenta la web de SWIM
WEAK = 0.25                       # |consistencia| por debajo de esto = indicio débil


class MissingInput(Exception):
    """Falta el composite de SWIM o el DTM, o no se superponen."""


def find_swim(data_dir=None):
    path = Path(data_dir or DATA_DIR) / "raw" / "common" / "swim2" / SWIM_FILE
    return path if path.exists() else None


def compute(dtm_path, out_dir, data_dir=None):
    """Escribe ice_consistency.tif en out_dir. Devuelve un resumen."""
    dtm_path, out_dir = Path(dtm_path), Path(out_dir)
    if not dtm_path.exists():
        raise MissingInput(f"Falta {dtm_path}.")
    src = find_swim(data_dir)
    if src is None:
        raise MissingInput(f"No está raw/common/swim2/{SWIM_FILE}. Lo baja pipeline/fetch_extras.py.")

    with rasterio.open(dtm_path) as dtm:
        dtm_bounds, dtm_crs = dtm.bounds, dtm.crs

    with rasterio.open(src) as ds:
        try:
            win = thermal.crop_window(ds, dtm_bounds, dtm_crs)
        except thermal.MissingInput:
            raise MissingInput("El composite de SWIM no se superpone con el DTM del sitio.") from None
        ci = ds.read(1, window=win).astype("float32")
        transform = ds.window_transform(win)
        crs = ds.crs
        res = (abs(ds.transform.a), abs(ds.transform.e))
        nodatas = {SWIM_NODATA, *OTHER_NODATA} | ({float(ds.nodata)} if ds.nodata is not None else set())

    valid = np.isfinite(ci) & ~np.isin(ci, list(nodatas))
    out = np.where(valid, ci, SWIM_NODATA).astype("float32")

    out_dir.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out_dir / "ice_consistency.tif", "w", driver="GTiff", width=ci.shape[1],
                       height=ci.shape[0], count=1, dtype="float32", crs=crs, transform=transform,
                       nodata=SWIM_NODATA, compress="deflate") as dst:
        dst.write(out, 1)

    v = ci[valid]
    warnings = []
    if v.size == 0:
        warnings.append("SWIM no tiene datos sobre el DTM del sitio.")
    elif v.max() <= 0:
        warnings.append("SWIM: ningún píxel del sitio es consistente con hielo somero (0-1 m).")
    elif v.max() < WEAK:
        warnings.append(f"SWIM: el indicio de hielo somero en el sitio es débil (máximo {v.max():.2f} "
                        "en una escala de -1 a +1).")
    return {
        "source_file": src.name,
        "depth_m": "0-1",
        "pixel_size": [round(res[0], 3), round(res[1], 3)],
        "pixel_units": crs.linear_units if crs.is_projected else "°",
        "n_pixels": int(ci.size),
        "coverage_pct": round(100 * int(valid.sum()) / max(ci.size, 1), 2),
        "consistency": ({"min": round(float(v.min()), 3), "mean": round(float(v.mean()), 3),
                         "max": round(float(v.max()), 3)} if v.size else None),
        "pct_positive": round(100 * float((v > 0).mean()), 1) if v.size else None,
        "warnings": warnings,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Consistencia de hielo somero de SWIM 2.0 para un sitio")
    ap.add_argument("--dir", required=True, help="carpeta con dtm.tif; recibe ice_consistency.tif")
    args = ap.parse_args(argv)
    folder = Path(args.dir).expanduser()
    work = folder / ".swim.work"
    shutil.rmtree(work, ignore_errors=True)
    try:
        summary = compute(folder / "dtm.tif", work)
    except MissingInput as e:
        print(f"Faltan datos: {e}", file=sys.stderr)
        shutil.rmtree(work, ignore_errors=True)
        return 2
    os.replace(work / "ice_consistency.tif", folder / "ice_consistency.tif")   # escritura atómica
    shutil.rmtree(work, ignore_errors=True)
    print(f"Listo -> {folder}")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
