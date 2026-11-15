#!/usr/bin/env python3
"""Dosis de radiación por celda (MSL RAD · MODELED) para el presupuesto de la travesía.

Modelo (detalle y limitaciones en docs/radiation.md):

    dosis(celda) = H0 × sky_view(celda) / sky_view(Bradbury Landing)

    H0        dosis equivalente en superficie medida por MSL RAD en Gale
              (reference/rad_surface_dose.json): 0,64 mSv/día = 26,7 µSv/h
    sky_view  fracción del ángulo sólido del cielo que no tapa el terreno
              = 1 − promedio sobre azimuts de sin(ángulo del horizonte)

Se normaliza por el sky-view del lugar donde RAD midió: así el modelo da exactamente H0 en
Bradbury Landing y no cuenta dos veces el horizonte de Gale. Supone radiación isótropa desde
el cielo; el horizonte se busca en 32 direcciones hasta 60 km, con el DTM cerca y el DEM
global de 200 m lejos, en metros reales sobre el suelo y con la curvatura de Marte.

Lo llama precompute.py como un paso más (escritura atómica, terrain.json y tiles). Escribe:
  skyview.tif     fracción de cielo visible (0-1), grilla de 100 m
  dose_rate.tif   dosis equivalente, µSv/h, grilla de 100 m (la usa api/planner.py)
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
REFERENCE_FILE = ROOT / "reference" / "rad_surface_dose.json"

# Radio del proyecto: el de sites/common.json (regla 6 de docs/context.md).
MARS_RADIUS_M = float(json.loads((ROOT / "sites" / "common.json").read_text())["dem200"]["radius_m"])
MARS_LONGLAT = f"+proj=longlat +R={MARS_RADIUS_M:.0f} +no_defs"

RES_M = 100                 # la dosis no cambia a escala de metros
N_AZIMUTHS = 32
MAX_DIST_M = 60_000         # hasta dónde se busca el horizonte
N_DISTANCES = 200           # muestras por dirección, espaciadas en forma geométrica
BAD_Z_M = 1e5               # mismo filtro de nodata que precompute.py

# Donde midió RAD: Bradbury Landing, en Gale (primeros ~300 soles, Hassler et al. 2014).
RAD_SITE = {"site": "gale", "name": "Bradbury Landing", "lat": -4.5895, "lon": 137.4417}


class MissingInput(Exception):
    """Falta el DTM del sitio."""


@dataclass
class Grid:
    z: np.ndarray            # alturas en la grilla grande (DTM cerca, DEM 200 m lejos)
    has_dtm: np.ndarray      # celdas con DTM
    transform: object
    crs: object
    roi: tuple[int, int, int, int]   # fila, columna, alto, ancho del área del DTM
    kx: float                # metros sobre el suelo por metro de proyección, este-oeste


# ------------------------------------------------------------------ datos de entrada

def load_reference():
    """H0 (mSv/día), su incertidumbre y la cita, de reference/rad_surface_dose.json."""
    ref = json.loads(REFERENCE_FILE.read_text())
    eq = ref["dose_equivalent_mSv_per_day"]
    return {"h0_msv_day": float(eq["value"]), "h0_unc_msv_day": float(eq["uncertainty"]),
            "citation": ref["reference"], "period": ref["period"]}


def find_dem200(site_id, data_dir=None):
    """dem200_crop.tif del sitio (lo recorta download.py), o None si no está."""
    data_dir = Path(data_dir or DATA_DIR)
    manifest = data_dir / "manifest.json"
    if manifest.exists():
        files = json.loads(manifest.read_text()).get("sites", {}).get(site_id, {}).get("files", [])
        entry = next((f for f in files if f.get("key") == "dem200_crop"), None)
        if entry and entry.get("status") == "ok" and (data_dir / entry["path"]).exists():
            return data_dir / entry["path"]
    local = data_dir / "raw" / site_id / "dem200_crop.tif"
    return local if local.exists() else None


def ground_scale_x(crs, x, y):
    """Metros sobre el suelo por metro de proyección en sentido este-oeste.

    En equirectangular con paralelo estándar lat_ts, un "metro" de la proyección mide
    cos(lat)/cos(lat_ts) sobre el suelo (en Jezero, 0,948). Norte-sur no cambia.
    """
    lat_ts = float(crs.to_dict().get("lat_ts", 0.0)) if crs.is_projected else 0.0
    _, lats = transform(crs, MARS_LONGLAT, [x], [y])
    return math.cos(math.radians(lats[0])) / math.cos(math.radians(lat_ts))


# ------------------------------------------------------------------ sky-view

def sky_view(z, rows, cols, res_m, kx=1.0):
    """Fracción de cielo visible en las celdas (rows, cols) de z (m, NaN = sin dato)."""
    z0 = z[rows, cols]
    H, W = z.shape
    dists = np.geomspace(res_m, MAX_DIST_M, N_DISTANCES)
    sum_sin = np.zeros(z0.shape)
    for k in range(N_AZIMUTHS):
        az = 2 * math.pi * k / N_AZIMUTHS                 # 0 = norte, sentido horario
        # Paso en metros sobre el suelo -> desplazamiento en píxeles de la proyección.
        dcol, drow = math.sin(az) / (res_m * kx), -math.cos(az) / res_m
        hmax = np.zeros(z0.shape)                         # horizonte mínimo: el plano (0°)
        for d in dists:
            r = np.rint(rows + drow * d).astype(int)
            c = np.rint(cols + dcol * d).astype(int)
            inside = (r >= 0) & (r < H) & (c >= 0) & (c < W)
            if not inside.any():
                break
            zs = np.full(z0.shape, np.nan)
            zs[inside] = z[r[inside], c[inside]]
            drop = d * d / (2 * MARS_RADIUS_M)            # curvatura: lo lejano "baja"
            with np.errstate(invalid="ignore"):
                hmax = np.fmax(hmax, np.arctan2(zs - drop - z0, d))   # fmax ignora NaN
        sum_sin += np.sin(hmax)
    return 1 - sum_sin / N_AZIMUTHS


def _read_valid(arr):
    return np.where(np.isfinite(arr) & (np.abs(arr) < BAD_Z_M), arr, np.nan)


def build_grid(bounds, crs, dtm_path, dem200_path, pad_m):
    """Grilla de RES_M m alineada con el borde oeste y norte de `bounds`.

    Alturas del DTM (promediadas) donde hay; alrededor, el DEM global de 200 m.
    """
    left, bottom, right, top = bounds
    n_pad = int(math.ceil(pad_m / RES_M))
    roi_w = int(math.ceil((right - left) / RES_M))
    roi_h = int(math.ceil((top - bottom) / RES_M))
    W, H = roi_w + 2 * n_pad, roi_h + 2 * n_pad
    t = from_origin(left - n_pad * RES_M, top + n_pad * RES_M, RES_M, RES_M)

    z_dtm = np.full((H, W), np.nan)
    if dtm_path is not None:
        with rasterio.open(dtm_path) as src:
            reproject(rasterio.band(src, 1), z_dtm, dst_transform=t, dst_crs=crs,
                      dst_nodata=np.nan, resampling=Resampling.average)
        z_dtm = _read_valid(z_dtm)
    z = z_dtm.copy()
    if dem200_path is not None:
        z_dem = np.full((H, W), np.nan)
        with rasterio.open(dem200_path) as src:
            reproject(rasterio.band(src, 1), z_dem, dst_transform=t, dst_crs=crs,
                      dst_nodata=np.nan, resampling=Resampling.bilinear)
        z = np.where(np.isnan(z), _read_valid(z_dem), z)
    cx, cy = (left + right) / 2, (bottom + top) / 2
    return Grid(z, ~np.isnan(z_dtm), t, crs, (n_pad, n_pad, roi_h, roi_w), ground_scale_x(crs, cx, cy))


def point_sky_view(lat, lon, dtm_path, dem200_path):
    """Sky-view de un punto suelto (para la normalización en Bradbury desde otro sitio)."""
    src_path = dtm_path or dem200_path
    with rasterio.open(src_path) as ds:
        crs = ds.crs
    if not crs.is_projected:
        return None
    xs, ys = transform(MARS_LONGLAT, crs, [lon], [lat])
    x, y = xs[0], ys[0]
    g = build_grid((x - RES_M / 2, y - RES_M / 2, x + RES_M / 2, y + RES_M / 2), crs,
                   dtm_path, dem200_path, MAX_DIST_M)
    r0, c0, _, _ = g.roi
    if np.isnan(g.z[r0, c0]):
        return None
    return float(sky_view(g.z, np.array([r0]), np.array([c0]), RES_M, g.kx)[0])


# ------------------------------------------------------------------ cálculo del sitio

def compute(site_id, dtm_path, out_dir, data_dir=None, pad_m=MAX_DIST_M):
    """Escribe skyview.tif y dose_rate.tif (GTiff) en out_dir. Devuelve un resumen."""
    data_dir = Path(data_dir or DATA_DIR)
    dtm_path, out_dir = Path(dtm_path), Path(out_dir)
    if not dtm_path.exists():
        raise MissingInput(f"Falta {dtm_path}. Corré antes pipeline/precompute.py --site {site_id}")
    ref = load_reference()
    warnings = []

    dem200 = find_dem200(site_id, data_dir)
    if dem200 is None:
        warnings.append("Falta dem200_crop.tif: el horizonte lejano (más allá del DTM) no se incluye, "
                        "así que el sky-view sale más alto de lo real.")

    with rasterio.open(dtm_path) as ds:
        bounds, crs = ds.bounds, ds.crs
    g = build_grid(bounds, crs, dtm_path, dem200, pad_m)
    r0, c0, h, w = g.roi
    rows, cols = np.mgrid[r0:r0 + h, c0:c0 + w]
    valid = g.has_dtm[rows, cols]
    svf = np.full((h, w), np.nan)
    svf[valid] = sky_view(g.z, rows[valid], cols[valid], RES_M, g.kx)

    # Normalización: el sky-view donde midió RAD.
    svf_ref, ref_how = _reference_sky_view(site_id, svf, g, data_dir)
    if svf_ref is None:
        svf_ref = 1.0
        warnings.append("No se pudo calcular el sky-view de Bradbury Landing (faltan los datos de Gale): "
                        "la dosis no está normalizada y sale hasta ~8 % más baja.")

    h0_usv_h = ref["h0_msv_day"] * 1000 / 24
    dose = h0_usv_h * svf / svf_ref

    out_dir.mkdir(parents=True, exist_ok=True)
    profile = dict(driver="GTiff", width=w, height=h, count=1, dtype="float32", crs=crs,
                   transform=g.transform @ rasterio.Affine.translation(c0, r0), nodata=np.nan,
                   compress="deflate", tiled=True, blockxsize=256, blockysize=256)
    with rasterio.open(out_dir / "skyview.tif", "w", **profile) as dst:
        dst.write(svf.astype("float32"), 1)
    with rasterio.open(out_dir / "dose_rate.tif", "w", **profile) as dst:
        dst.write(dose.astype("float32"), 1)

    v = dose[np.isfinite(dose)]
    p1, p50, p99 = (float(x) for x in np.percentile(v, [1, 50, 99])) if v.size else (math.nan,) * 3
    return {
        "h0_usv_h": round(h0_usv_h, 3),
        "skyview_reference": {**RAD_SITE, "value": round(svf_ref, 4), "how": ref_how},
        "skyview_median": round(float(np.nanmedian(svf)), 4) if v.size else None,
        "dose_usv_h": {"p1": round(p1, 2), "p50": round(p50, 2), "p99": round(p99, 2)},
        "spread_vs_uncertainty": {
            "half_spread_pct": round(100 * (p99 - p1) / 2 / p50, 1) if v.size else None,
            "rad_uncertainty_pct": round(100 * ref["h0_unc_msv_day"] / ref["h0_msv_day"], 1),
        },
        "warnings": warnings,
    }


def _reference_sky_view(site_id, svf, g, data_dir):
    """Sky-view en Bradbury: de la grilla si el sitio es Gale, si no con los datos de Gale."""
    if site_id == RAD_SITE["site"]:
        xs, ys = transform(MARS_LONGLAT, g.crs, [RAD_SITE["lon"]], [RAD_SITE["lat"]])
        r0, c0, h, w = g.roi
        col = int((xs[0] - g.transform.c) / RES_M) - c0
        row = int((g.transform.f - ys[0]) / RES_M) - r0
        if 0 <= row < h and 0 <= col < w and np.isfinite(svf[row, col]):
            return float(svf[row, col]), "grilla de Gale (DTM + DEM 200 m)"
    dem = find_dem200(RAD_SITE["site"], data_dir)
    if dem is None:
        return None, None
    # Desde otro sitio: solo el DEM de 200 m (leer el DTM de Gale entero tarda minutos).
    # Bradbury está en una planicie: el detalle del DTM cerca casi no cambia su horizonte.
    value = point_sky_view(RAD_SITE["lat"], RAD_SITE["lon"], None, dem)
    return value, "DEM 200 m de Gale (sin el DTM)" if value is not None else None
