#!/usr/bin/env python3
"""Capa térmica THEMIS (Mars Odyssey · OBSERVED) y suelo suelto probable (MODELED).

Qué mide THEMIS de noche: de noche el suelo devuelve el calor que juntó de día. La roca y el
suelo compacto (inercia térmica alta) se enfrían despacio y se ven más tibios; la arena, el
polvo y el grano fino (inercia térmica baja) se enfrían rápido y se ven más fríos. Por eso el
IR nocturno es el dato clásico para separar arena suelta de roca.

Qué tenemos: el mosaico controlado de USGS del IR nocturno de THEMIS (100 m/px), recortado al
sitio por pipeline/fetch_science.sh en raw/<sitio>/themis/<cuadrángulo>_nir_crop.tif. Es un
producto CUALITATIVO de 8 bits: los valores se estiraron y mezclaron entre imágenes para que el
mosaico no tenga costuras, así que el brillo es RELATIVO (más tibio / más frío dentro del
sitio), no una temperatura ni una inercia térmica en unidades. Todo lo de abajo respeta eso.

Salidas (en out_dir):
  themis_night.tif  el IR nocturno de THEMIS recortado a la huella del DTM, en su grilla y
                    con sus valores originales (uint8, 0 = sin dato). Sin remuestrear: es el
                    dato observado. Se tesela para el mapa (capa survival-thermal).
  loose_soil.tif    suelo suelto probable (uint8, misma grilla): 1 = de lo más frío de noche
                    dentro del sitio, 0 = no, 255 = sin dato. Es un criterio del equipo sobre
                    un brillo relativo: MODELED. Lo usa terrain_layers.py para reforzar el
                    peligro de terreno.

Criterio de suelo suelto: un píxel es "suelto probable" si su brillo nocturno está en el
LOOSE_PERCENTILE % más frío del sitio. Solo se marca si hay contraste: si el percentil queda a
menos de MIN_CONTRAST_DN del valor mediano, el sitio es térmicamente parejo y no se marca nada
(un percentil siempre encuentra "el 20 % más frío", aunque todo sea igual).

Uso suelto, para experimentar sobre una carpeta que ya tenga dtm.tif:
  python pipeline/thermal.py --site jezero --dir /data/prueba/jezero
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import Window, from_bounds

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

# Criterio de suelo suelto (supuestos del equipo, documentados en el README).
LOOSE_PERCENTILE = 20      # el 20 % más frío de noche dentro del sitio
MIN_CONTRAST_DN = 5        # contraste mínimo (en DN de 0-255) entre ese percentil y la mediana

THEMIS_NODATA = 0          # los mosaicos de 8 bits de USGS marcan "sin dato" con 0
LOOSE_NODATA = 255


class MissingInput(Exception):
    """Falta el recorte de THEMIS del sitio o el DTM."""


# ------------------------------------------------------------------ entradas

def find_night_ir(site_id, data_dir=None):
    """Recorte del IR nocturno de THEMIS del sitio (lo baja fetch_science.sh), o None."""
    folder = Path(data_dir or DATA_DIR) / "raw" / site_id / "themis"
    found = sorted(folder.glob("*_nir_crop.tif"))
    return found[0] if found else None


def crop_window(themis, dtm_bounds, dtm_crs):
    """Ventana de `themis` (dataset abierto) que cubre la huella del DTM, recortada al raster."""
    left, bottom, right, top = transform_bounds(dtm_crs, themis.crs, *dtm_bounds, densify_pts=21)
    win = from_bounds(left, bottom, right, top, transform=themis.transform)
    # Píxeles enteros hacia afuera, para no perder el borde del DTM.
    c0, r0 = int(np.floor(win.col_off)), int(np.floor(win.row_off))
    c1, r1 = int(np.ceil(win.col_off + win.width)), int(np.ceil(win.row_off + win.height))
    c0, r0 = max(c0, 0), max(r0, 0)
    c1, r1 = min(c1, themis.width), min(r1, themis.height)
    if c1 <= c0 or r1 <= r0:
        raise MissingInput("El recorte de THEMIS no se superpone con el DTM del sitio.")
    return Window(c0, r0, c1 - c0, r1 - r0)


# ------------------------------------------------------------------ cálculos

def loose_soil(night_dn, valid):
    """1 = suelo suelto probable, 0 = no, 255 = sin dato. Devuelve (clases, umbral, avisos).

    `night_dn`: brillo nocturno (DN), `valid`: dónde hay dato.
    """
    out = np.full(night_dn.shape, LOOSE_NODATA, dtype="uint8")
    if not valid.any():
        return out, None, ["El recorte de THEMIS no tiene datos sobre el DTM."]
    v = night_dn[valid].astype("float64")
    threshold = float(np.percentile(v, LOOSE_PERCENTILE))
    median = float(np.median(v))
    warnings = []
    if median - threshold < MIN_CONTRAST_DN:
        warnings.append(f"THEMIS nocturno sin contraste en el sitio (percentil {LOOSE_PERCENTILE} a "
                        f"{median - threshold:.0f} DN de la mediana): no se marca suelo suelto.")
        out[valid] = 0
        return out, None, warnings
    out[valid] = (night_dn[valid] <= threshold).astype("uint8")
    return out, threshold, warnings


def compute(site_id, dtm_path, out_dir, data_dir=None):
    """Escribe themis_night.tif y loose_soil.tif en out_dir. Devuelve un resumen."""
    dtm_path, out_dir = Path(dtm_path), Path(out_dir)
    if not dtm_path.exists():
        raise MissingInput(f"Falta {dtm_path}. Corré antes pipeline/precompute.py --site {site_id}")
    src = find_night_ir(site_id, data_dir)
    if src is None:
        raise MissingInput(f"No está el IR nocturno de THEMIS de {site_id} en raw/{site_id}/themis/. "
                           "Lo baja pipeline/fetch_science.sh.")

    with rasterio.open(dtm_path) as dtm:
        dtm_bounds, dtm_crs = dtm.bounds, dtm.crs

    with rasterio.open(src) as ds:
        win = crop_window(ds, dtm_bounds, dtm_crs)
        dn = ds.read(1, window=win)
        nodata = ds.nodata if ds.nodata is not None else THEMIS_NODATA
        transform = ds.window_transform(win)
        crs = ds.crs
        res = (abs(ds.transform.a), abs(ds.transform.e))
        units = crs.linear_units if crs.is_projected else "°"

    valid = dn != nodata
    classes, threshold, warnings = loose_soil(dn, valid)

    out_dir.mkdir(parents=True, exist_ok=True)
    base = dict(driver="GTiff", width=dn.shape[1], height=dn.shape[0], count=1, dtype="uint8",
                crs=crs, transform=transform, compress="deflate", tiled=True,
                blockxsize=256, blockysize=256)
    with rasterio.open(out_dir / "themis_night.tif", "w", **base, nodata=THEMIS_NODATA) as dst:
        dst.write(np.where(valid, dn, THEMIS_NODATA).astype("uint8"), 1)
    with rasterio.open(out_dir / "loose_soil.tif", "w", **base, nodata=LOOSE_NODATA) as dst:
        dst.write(classes, 1)

    n_valid = int(valid.sum())
    v = dn[valid]
    return {
        "source_file": src.name,
        "pixel_size": [round(res[0], 6), round(res[1], 6)],
        "pixel_units": units,
        "coverage_pct": round(100 * n_valid / max(dn.size, 1), 2),
        "night_dn": ({k: int(np.percentile(v, p)) for k, p in (("p5", 5), ("p50", 50), ("p95", 95))}
                     if n_valid else None),
        "loose_threshold_dn": None if threshold is None else round(threshold, 1),
        "loose_pct": round(100 * int((classes == 1).sum()) / max(n_valid, 1), 2),
        "warnings": warnings,
    }


# ------------------------------------------------------------------ uso suelto

def main(argv=None):
    ap = argparse.ArgumentParser(description="Capa térmica THEMIS y suelo suelto probable de un sitio")
    ap.add_argument("--site", required=True, help="id del sitio (para buscar raw/<sitio>/themis/)")
    ap.add_argument("--dir", required=True, help="carpeta con dtm.tif; recibe las salidas")
    args = ap.parse_args(argv)
    folder = Path(args.dir).expanduser()
    work = folder / ".thermal.work"
    shutil.rmtree(work, ignore_errors=True)
    try:
        summary = compute(args.site, folder / "dtm.tif", work)
    except MissingInput as e:
        print(f"Faltan datos: {e}", file=sys.stderr)
        shutil.rmtree(work, ignore_errors=True)
        return 2
    for name in ("themis_night.tif", "loose_soil.tif"):
        os.replace(work / name, folder / name)      # escritura atómica
    shutil.rmtree(work, ignore_errors=True)
    print(f"Listo -> {folder}")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
