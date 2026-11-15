#!/usr/bin/env python3
"""Peligro de terreno para EVA: pendiente + rugosidad a 1 m.

Lo llama precompute.py como un paso más (escritura atómica, registro en terrain.json y
tiles). También se puede correr solo sobre una carpeta que ya tenga dtm.tif y slope.tif,
para experimentar:

  python pipeline/terrain_layers.py --dir /data/prueba/jezero

Salidas (misma grilla que el DTM):
  roughness.tif       rugosidad σ (m): desvío estándar, en una ventana de 5 m, del residuo
                      del DTM tras restar el promedio local en 15 m. En una ladera lisa
                      da ~0: no repite la pendiente.
  terrain_factor.tif  factor de terreno η de Pandolf (1.1 a 1.8), solo por rugosidad.
                      La pendiente entra en Pandolf aparte, como el grado G de la ruta.
  hazard.tif          clase de peligro (uint8): 0 bajo, 1 medio, 2 alto, 3 no transitable,
                      255 sin dato. Manda la peor entre la clase de pendiente y la de rugosidad.

Solo geometría del terreno: no incluye gravedad, traje ni carga.
Se procesa por bloques con borde extra, así que anda con DTMs grandes (Gale) sin costuras.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.ndimage import uniform_filter

# --- Parámetros (documentados en el README) ---
TREND_WINDOW_M = 15        # escala de la "forma general" del terreno, que se resta
ROUGHNESS_WINDOW_M = 5     # ~ resolución horizontal real de un DTM HiRISE (3-5 px)

# Cortes de pendiente: los MISMOS que SLOPE_CLASSES (web/src/map/layers.ts),
# RAMPAS["pendiente"] (pipeline/tiles.py) y SLOPE_CUTS (api/planner.py). El último es el
# límite duro de api/safety.py (Limits.max_slope_deg): lo que se pinta "no transitable" es
# lo que el planificador no pisa. Convención "≥": 25° exactos ya es no transitable.
# Un test (test_terrain_layers.py) compara estos cortes con los del planificador.
SLOPE_CUTS_DEG = (10.0, 20.0, 25.0)

# Cortes de rugosidad σ (m). σ es un desvío estándar: en un campo denso de bloques de
# altura h da σ ≈ h/2, así que los cortes equivalen a escalones de ~0,3, ~0,5 y ~0,8-1 m.
ROUGHNESS_CUTS_M = (0.15, 0.25, 0.40)

# Rugosidad σ (m) -> η de Pandolf. Interpolación lineal; fuera de rango se satura.
ETA_ANCHORS_M = (0.05, 0.15, 0.25, 0.40)
ETA_VALUES = (1.1, 1.2, 1.5, 1.8)   # camino de tierra, matorral liviano, matorral denso, pantano

HAZARD_CLASSES = ("bajo", "medio", "alto", "no transitable")
HAZARD_NODATA = 255
BAD_Z_M = 1e5              # mismo valor que precompute.py: los DTM marcan nodata con ±3,4e38
BLOCK = 2048               # tamaño de bloque de procesamiento (px)


class MissingInput(Exception):
    """Falta dtm.tif o slope.tif."""


# ------------------------------------------------------------------ cálculos

def odd(n):
    n = max(int(round(n)), 1)
    return n if n % 2 == 1 else n + 1


def moving_mean(a, valid, size):
    """Promedio en ventana size x size usando solo celdas válidas.
    (uniform_filter con NaN contagiaría filas enteras: por eso se promedia con pesos.)"""
    num = uniform_filter(np.where(valid, a, 0.0), size=size, mode="nearest")
    den = uniform_filter(valid.astype("float64"), size=size, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den > 1e-9, num / den, np.nan)


def roughness(z, trend_px, window_px):
    """σ móvil de (z - promedio local). z en metros, NaN = sin dato."""
    valid = ~np.isnan(z)
    if not valid.any():
        return np.full(z.shape, np.nan)
    z0 = z - np.nanmean(z)              # centrar mejora la precisión (alturas ~ -2500 m)
    r = z0 - moving_mean(z0, valid, trend_px)
    m = moving_mean(r, valid, window_px)
    m2 = moving_mean(r * r, valid, window_px)
    return np.where(valid, np.sqrt(np.clip(m2 - m * m, 0, None)), np.nan)


def terrain_factor(rough_m):
    """η de Pandolf a partir de σ (m). NaN se mantiene NaN."""
    eta = np.interp(rough_m, ETA_ANCHORS_M, ETA_VALUES)
    return np.where(np.isnan(rough_m), np.nan, eta)


def hazard_class(slope_deg, rough_m):
    """Clase 0-3 = max(clase de pendiente, clase de rugosidad); 255 si falta alguno."""
    missing = np.isnan(slope_deg) | np.isnan(rough_m)
    c_slope = np.searchsorted(SLOPE_CUTS_DEG, np.nan_to_num(slope_deg), side="right")
    c_rough = np.searchsorted(ROUGHNESS_CUTS_M, np.nan_to_num(rough_m), side="right")
    return np.where(missing, HAZARD_NODATA, np.maximum(c_slope, c_rough)).astype("uint8")


# ------------------------------------------------------------------ por bloques

def read(src, window):
    z = src.read(1, window=window, masked=True).astype("float64").filled(np.nan)
    return np.where(np.isfinite(z) & (np.abs(z) < BAD_Z_M), z, np.nan)


def compute(dtm_path, slope_path, out_dir):
    """Escribe roughness.tif, terrain_factor.tif y hazard.tif en out_dir (GTiff en bloques).

    Devuelve un resumen con el % del terreno en cada clase.
    """
    dtm_path, slope_path, out_dir = Path(dtm_path), Path(slope_path), Path(out_dir)
    for p in (dtm_path, slope_path):
        if not p.exists():
            raise MissingInput(f"Falta {p}. Corré antes pipeline/precompute.py para ese sitio.")

    with rasterio.open(dtm_path) as dsrc, rasterio.open(slope_path) as ssrc:
        if (dsrc.width, dsrc.height) != (ssrc.width, ssrc.height):
            raise MissingInput("dtm.tif y slope.tif no tienen la misma grilla")
        # Tamaño de píxel en metros de la proyección. En eqc con lat_ts=0, a 18,5° N el píxel
        # E-O mide 0,948 m sobre el suelo: con ventanas de 15 y 5 px no cambia nada.
        px = abs(dsrc.transform.a)
        n_trend, n_win = odd(TREND_WINDOW_M / px), odd(ROUGHNESS_WINDOW_M / px)
        halo = n_trend // 2 + n_win // 2 + 1        # borde extra: sin costuras entre bloques
        W, H = dsrc.width, dsrc.height

        base = dict(driver="GTiff", width=W, height=H, count=1, crs=dsrc.crs, transform=dsrc.transform,
                    tiled=True, blockxsize=512, blockysize=512, compress="deflate", BIGTIFF="IF_SAFER")
        prof_f = {**base, "dtype": "float32", "nodata": np.nan, "predictor": 3}
        prof_c = {**base, "dtype": "uint8", "nodata": HAZARD_NODATA, "predictor": 2}

        counts = np.zeros(len(HAZARD_CLASSES), dtype=np.int64)
        out_dir.mkdir(parents=True, exist_ok=True)
        with rasterio.open(out_dir / "roughness.tif", "w", **prof_f) as o_r, \
             rasterio.open(out_dir / "terrain_factor.tif", "w", **prof_f) as o_e, \
             rasterio.open(out_dir / "hazard.tif", "w", **prof_c) as o_h:
            for row in range(0, H, BLOCK):
                for col in range(0, W, BLOCK):
                    h, w = min(BLOCK, H - row), min(BLOCK, W - col)
                    win = Window(col, row, w, h)
                    r0, c0 = max(row - halo, 0), max(col - halo, 0)
                    r1, c1 = min(row + h + halo, H), min(col + w + halo, W)
                    z = read(dsrc, Window(c0, r0, c1 - c0, r1 - r0))
                    rough = roughness(z, n_trend, n_win)[row - r0:row - r0 + h, col - c0:col - c0 + w]
                    slope = read(ssrc, win)
                    cls = hazard_class(slope, rough)
                    o_r.write(rough.astype("float32"), 1, window=win)
                    o_e.write(terrain_factor(rough).astype("float32"), 1, window=win)
                    o_h.write(cls, 1, window=win)
                    counts += np.bincount(cls[cls != HAZARD_NODATA], minlength=len(HAZARD_CLASSES))

    total = max(int(counts.sum()), 1)
    return {"pct_by_class": {name: round(100 * int(c) / total, 2) for name, c in zip(HAZARD_CLASSES, counts)}}


# ------------------------------------------------------------------ uso suelto

def main(argv=None):
    ap = argparse.ArgumentParser(description="Peligro de terreno (pendiente + rugosidad) sobre una carpeta")
    ap.add_argument("--dir", required=True, help="carpeta con dtm.tif y slope.tif; recibe las salidas")
    args = ap.parse_args(argv)
    folder = Path(args.dir).expanduser()
    work = folder / ".terrain_layers.work"
    shutil.rmtree(work, ignore_errors=True)
    try:
        summary = compute(folder / "dtm.tif", folder / "slope.tif", work)
    except MissingInput as e:
        print(f"Faltan datos: {e}", file=sys.stderr)
        shutil.rmtree(work, ignore_errors=True)
        return 2
    for name in ("roughness.tif", "terrain_factor.tif", "hazard.tif"):
        os.replace(work / name, folder / name)      # escritura atómica
    shutil.rmtree(work, ignore_errors=True)
    print(f"Listo -> {folder}")
    for name, pct in summary["pct_by_class"].items():
        print(f"  {name:15s} {pct:6.2f} %")
    return 0


if __name__ == "__main__":
    sys.exit(main())
