"""Geometría de la ruta sobre la esfera de Marte y muestreo de elevación en el DTM."""
from __future__ import annotations

import math
from pathlib import Path

MARS_RADIUS_M = 3396190.0  # esfera IAU Mars 2000, la misma de los DTM
MARS_LONGLAT = "+proj=longlat +R=3396190 +no_defs"


class TerrainError(ValueError):
    """Punto fuera del DTM o sobre nodata."""


def _norm_lon(lon: float) -> float:
    return (lon + 180.0) % 360.0 - 180.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * MARS_RADIUS_M * math.asin(math.sqrt(a))


def densify(lat1: float, lon1: float, lat2: float, lon2: float, step_m: float) -> list[tuple[float, float]]:
    """Puntos cada ~step_m entre dos vértices, incluidos ambos extremos. Interpolación
    lineal en lat/lon: a la escala de un sitio (decenas de km) el error es despreciable."""
    n = max(1, math.ceil(haversine_m(lat1, lon1, lat2, lon2) / step_m))
    return [(lat1 + (lat2 - lat1) * k / n, lon1 + (lon2 - lon1) * k / n) for k in range(n + 1)]


def sample_dtm(dtm_path: Path, latlon: list[tuple[float, float]]) -> list[float]:
    """Elevación (m) del DTM en cada (lat, lon). Lanza TerrainError si alguno cae fuera
    del raster o en nodata."""
    import rasterio
    from rasterio.warp import transform

    with rasterio.open(dtm_path) as ds:
        lons = [_norm_lon(lo) for _, lo in latlon]
        lats = [la for la, _ in latlon]
        xs, ys = transform(MARS_LONGLAT, ds.crs, lons, lats)
        left, bottom, right, top = ds.bounds
        for i, (x, y) in enumerate(zip(xs, ys)):
            if not (left <= x <= right and bottom <= y <= top):
                raise TerrainError(f"El punto ({lats[i]:.5f}, {lons[i]:.5f}) cae fuera del DTM.")
        nodata = ds.nodata
        out = []
        for i, v in enumerate(ds.sample(zip(xs, ys), indexes=1)):
            z = float(v[0])
            if not math.isfinite(z) or (nodata is not None and math.isclose(z, nodata, rel_tol=1e-6)):
                raise TerrainError(f"El punto ({lats[i]:.5f}, {lons[i]:.5f}) cae en una zona sin datos del DTM.")
            out.append(z)
        return out
