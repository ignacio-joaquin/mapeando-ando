"""Rasters sintéticos para los tests de /api/route y /api/illumination.

Grilla de N × N píxeles de PX m en equirectangular marciano (en metros, como los
DTM de HiRISE), centrada cerca de Jezero. Así los tests ejercitan la conversión
lat/lon → CRS del raster, que es lo que se rompía en la primera versión del A*.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

R = 3396190.0
CRS = f"+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R={R:.0f} +units=m +no_defs"
LAT0, LON0 = 18.44, 77.45
PX = 5.0
N = 200
X0 = R * math.radians(LON0) - N * PX / 2
Y0 = R * math.radians(LAT0) + N * PX / 2
TRANSFORM = from_origin(X0, Y0, PX, PX)

SOL_TAG = "20261115T0000Z"
SOL_START = 1794700800.0  # 2026-11-15T00:00:00Z
BAND_S = 3699.0           # ~1 h LTST en segundos UTC
N_BANDS = 24


def latlon(row: float, col: float) -> tuple[float, float]:
    """Centro del píxel (row, col) en grados planetocéntricos."""
    x = X0 + (col + 0.5) * PX
    y = Y0 - (row + 0.5) * PX
    return math.degrees(y / R), math.degrees(x / R)


def iso(t: float) -> str:
    import datetime as dt
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def band_time(band: int) -> float:
    return SOL_START + (band - 1) * BAND_S


def _write(path: Path, data: np.ndarray, dtype: str, nodata) -> None:
    data = data if data.ndim == 3 else data[None]
    with rasterio.open(path, "w", driver="GTiff", width=N, height=N, count=data.shape[0], dtype=dtype,
                       crs=CRS, transform=TRANSFORM, nodata=nodata) as ds:
        ds.write(data.astype(dtype))


def write_terrain(data_dir: Path, slope: np.ndarray, dtm: np.ndarray | None = None, site: str = "jezero") -> Path:
    out = data_dir / "output" / site
    out.mkdir(parents=True, exist_ok=True)
    _write(out / "slope.tif", slope, "float32", -9999.0)
    layers = {"relief-slope": {"file": "slope.tif", "status": "ok", "mission": "MRO"}}
    if dtm is not None:
        _write(out / "dtm.tif", dtm, "float32", -9999.0)
        layers["dtm"] = {"file": "dtm.tif", "status": "ok"}
    (out / "terrain.json").write_text(json.dumps({"site": site, "layers": layers}))
    return out


def write_shadow_stack(data_dir: Path, bands: dict[int, np.ndarray] | None = None, site: str = "jezero",
                       tag: str = SOL_TAG) -> Path:
    """Pila de 24 bandas: todo al sol salvo las que se pasan en `bands` (1 sol, 0 sombra, 255 sin dato)."""
    d = data_dir / "output" / site / "illumination" / tag
    d.mkdir(parents=True, exist_ok=True)
    stack = np.ones((N_BANDS, N, N), dtype=np.uint8)
    for b, arr in (bands or {}).items():
        stack[b - 1] = arr
    _write(d / "shadow_hourly.tif", stack, "uint8", 255)
    index = {
        "site": site,
        "sol": {"start_utc": iso(SOL_START), "end_utc": iso(SOL_START + N_BANDS * BAND_S),
                "flat_sunrise": {"utc": iso(band_time(7)), "ltst": "06:00"},
                "flat_sunset": {"utc": iso(band_time(19)), "ltst": "18:00"}},
        "shadow_hourly": {"file": "shadow_hourly.tif", "step_min": 60,
                          "bands": [{"band": b, "ltst": f"{b - 1:02d}:00", "utc": iso(band_time(b)),
                                     "sun_el_deg": 30.0, "lit_fraction": 1.0} for b in range(1, N_BANDS + 1)]},
        "grid": {"shape": [N, N], "pixel_ground_m": [round(PX * math.cos(math.radians(LAT0)), 3), PX]},
        "provenance": {"ephemeris": "NAIF SPICE: test"},
        "assumptions": ["Sol puntual (centro del disco); sin refracción ni polvo."],
    }
    (d / "index.json").write_text(json.dumps(index))
    return d


def manifest(site: str = "jezero") -> dict:
    return {"sites": {site: {"name": "Jezero", "rover": "Perseverance", "files": []}}}
