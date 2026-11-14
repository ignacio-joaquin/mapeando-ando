"""Línea de vista al hábitat sobre el DTM: ¿hay contacto por radio desde este punto?

Se usa para el límite duro "minutos seguidos sin contacto" y para el factor de costo
"sin contacto" del A*. Es geometría pura sobre el DTM (DERIVED), con supuestos:

- Radio en línea de vista directa, sin repetidores ni difracción por el borde.
- Antena del hábitat a HABITAT_MAST_M sobre el suelo y del traje a SUIT_ANTENNA_M.
- Se descuenta la curvatura de Marte (abultamiento d1·d2 / 2R).
- El DTM se lee promediado en una ventana que cubre todas las estaciones: los
  obstáculos más chicos que la celda no se ven.

Una sola lectura por pedido (`ContactField.from_dtm`), después todo es numpy.
"""
from __future__ import annotations

import math

import numpy as np

from .illumination import apply_affine
from .terrain import MARS_LONGLAT, MARS_RADIUS_M, _norm_lon

HABITAT_MAST_M = 3.0
SUIT_ANTENNA_M = 2.0
MAX_SIDE = 1500        # lado máximo de la grilla promediada
MARGIN_M = 1000.0      # margen alrededor de las estaciones
MAX_SAMPLES = 128      # muestras por línea de vista
CHUNK = 4096           # puntos por bloque, para acotar memoria

ASSUMPTIONS = [
    "Radio en línea de vista directa, sin repetidores ni difracción",
    f"Antena del hábitat a {HABITAT_MAST_M:.0f} m y del traje a {SUIT_ANTENNA_M:.0f} m sobre el suelo",
    "Se descuenta la curvatura de Marte",
]


class ContactField:
    """Elevación promediada alrededor de la travesía y la posición del hábitat."""

    def __init__(self, z: np.ndarray, transform, crs, habitat_xy: tuple[float, float], cell_m: float,
                 unit_m: float = 1.0):
        self.z = z                       # NaN = sin dato
        # Borde de NaN: un índice fuera de la grilla se recorta al borde y da "sin dato".
        self.zp = np.pad(z.astype(np.float32), 1, constant_values=np.nan)
        self.transform = transform       # Affine celda → CRS
        self.inv = ~transform
        self.crs = crs
        self.cell_m = cell_m
        self.unit_m = unit_m             # metros por unidad del CRS (1 en CRS métricos)
        self.hx, self.hy = habitat_xy
        self.hz = self._z_at(np.array([self.hx]), np.array([self.hy]))[0]

    @property
    def resolution(self) -> str:
        return f"DTM promediado a {self.cell_m:.0f} m"

    @classmethod
    def from_dtm(cls, ds, habitat: tuple[float, float], stations: list[tuple[float, float]]):
        """Lee el DTM alrededor de las estaciones. None si el hábitat cae fuera del DTM."""
        from rasterio.enums import Resampling
        from rasterio.transform import Affine
        from rasterio.warp import transform as warp
        from rasterio.windows import Window

        lons = [_norm_lon(lo) for _, lo in stations]
        lats = [la for la, _ in stations]
        xs, ys = warp(MARS_LONGLAT, ds.crs, lons, lats)
        hx, hy = warp(MARS_LONGLAT, ds.crs, [_norm_lon(habitat[1])], [habitat[0]])
        px = abs(ds.transform.a)
        # Tamaño del píxel sobre el suelo: en CRS métricos es el propio paso.
        unit_m = 1.0 if ds.crs and ds.crs.is_projected else math.pi / 180 * MARS_RADIUS_M
        px_m = px * unit_m
        margin_px = MARGIN_M / px_m
        rows, cols = zip(*(ds.index(x, y, op=math.floor) for x, y in zip(xs, ys)))
        r0 = max(0, int(min(rows) - margin_px))
        r1 = min(ds.height, int(max(rows) + margin_px) + 1)
        c0 = max(0, int(min(cols) - margin_px))
        c1 = min(ds.width, int(max(cols) + margin_px) + 1)
        if r1 <= r0 or c1 <= c0:
            return None
        h, w = r1 - r0, c1 - c0
        f = max(1, math.ceil(max(h, w) / MAX_SIDE))
        oh, ow = -(-h // f), -(-w // f)
        win = Window(c0, r0, w, h)
        a = ds.read(1, window=win, out_shape=(oh, ow), resampling=Resampling.average, masked=True)
        z = np.ma.filled(a.astype(np.float64), np.nan)
        z[~np.isfinite(z)] = np.nan
        if ds.nodata is not None:
            z[np.isclose(z, ds.nodata)] = np.nan
        t = ds.window_transform(win) * Affine.scale(w / ow, h / oh)
        field = cls(z, t, ds.crs, (hx[0], hy[0]), px_m * f, unit_m)
        if not math.isfinite(field.hz):
            return None
        return field

    def _z_at(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        c, r = apply_affine(self.inv, xs, ys)
        rows, cols = self.zp.shape
        r = np.clip(np.floor(r) + 1, 0, rows - 1).astype(np.intp)
        c = np.clip(np.floor(c) + 1, 0, cols - 1).astype(np.intp)
        return self.zp[r, c]

    def visible_xy(self, xs, ys) -> np.ndarray:
        """1 = hay línea de vista, 0 = tapado, -1 = sin dato. xs, ys en el CRS del DTM."""
        xs = np.asarray(xs, dtype=np.float64).ravel()
        ys = np.asarray(ys, dtype=np.float64).ravel()
        out = np.full(xs.shape, -1, dtype=np.int8)
        for k in range(0, xs.size, CHUNK):
            out[k:k + CHUNK] = self._visible_chunk(xs[k:k + CHUNK], ys[k:k + CHUNK])
        return out

    def _visible_chunk(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        dx, dy = xs - self.hx, ys - self.hy
        dist = np.hypot(dx, dy) * self.unit_m
        zt = self._z_at(xs, ys)
        n = int(min(MAX_SAMPLES, max(2, math.ceil(np.nanmax(dist, initial=0.0) / self.cell_m))))
        f = (np.arange(1, n) / n)[None, :]                     # sin los extremos
        sx = self.hx + dx[:, None] * f
        sy = self.hy + dy[:, None] * f
        zs = self._z_at(sx, sy)
        d1 = dist[:, None] * f
        bulge = d1 * (dist[:, None] - d1) / (2 * MARS_RADIUS_M)
        h0 = self.hz + HABITAT_MAST_M
        h1 = zt[:, None] + SUIT_ANTENNA_M
        ray = h0 + (h1 - h0) * f
        blocked = np.any(zs + bulge > ray, axis=1)
        unknown = ~np.isfinite(zt) | np.any(~np.isfinite(zs), axis=1)
        out = np.where(blocked, 0, 1).astype(np.int8)
        # Tapado por terreno conocido es tapado aunque falte un dato en otra parte del rayo.
        out[unknown & ~blocked] = -1
        out[~np.isfinite(zt)] = -1
        out[dist < self.cell_m] = 1
        return out

    def visible_latlon(self, latlon: list[tuple[float, float]]) -> list[bool | None]:
        from rasterio.warp import transform as warp
        if not latlon:
            return []
        xs, ys = warp(MARS_LONGLAT, self.crs, [_norm_lon(lo) for _, lo in latlon], [la for la, _ in latlon])
        return [None if v < 0 else bool(v) for v in self.visible_xy(xs, ys)]
