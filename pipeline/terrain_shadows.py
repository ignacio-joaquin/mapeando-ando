"""Sombras proyectadas por el terreno sobre un DTM cualquiera.

Núcleo geométrico, sin I/O: recibe arrays y funciones de lectura, así se puede testear
con terrenos sintéticos y usar con cualquier DTM (cualquier CRS y tamaño de píxel).

Dos escalas:

- **Cercana (dentro del DTM).** Para una posición del Sol (azimut, elevación) se recorre el
  DTM en líneas paralelas al azimut solar, desde el lado del Sol. Un píxel i está en sombra
  si algún píxel j más cerca del Sol cumple z_j + u_j·tan(e) > z_i + u_i·tan(e), con u la
  distancia sobre el suelo a lo largo del rayo. Eso es un máximo acumulado: O(N) por
  posición del Sol, sin precomputar ni guardar horizontes por píxel. Las alturas se pasan a
  un plano tangente en el centro del DTM (z − r²/2R) para incluir la curvatura de Marte.
- **Lejana (fuera del DTM).** Con un DEM más grueso (p. ej. MOLA+HRSC 200 m) se precomputa,
  en una grilla de observadores, el ángulo de horizonte del terreno que queda fuera del DTM
  para 360 azimuts, y la distancia a la que está. Para cada píxel se corrige por su propia
  altura: tan H ≈ tan H_grilla − (z − z_grilla)/d*.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Iterator

import numpy as np
from scipy.ndimage import map_coordinates

MARS_RADIUS_M = 3396190.0
NO_FAR = -1e9  # tan del horizonte lejano cuando no hay terreno fuera del DTM


# ------------------------------------------------------------------ geometría local

def ground_jacobian(pix_to_lonlat: Callable, col: float, row: float,
                    radius_m: float = MARS_RADIUS_M) -> np.ndarray:
    """Matriz 2x2 que pasa un desplazamiento en píxeles (col, fila) a metros de suelo
    (este, norte) alrededor de (col, row). Cubre píxeles anisótropos (equirectangular
    lejos del ecuador), CRS rotados y CRS geográficos."""
    lons, lats = pix_to_lonlat(np.array([col, col + 1.0, col]), np.array([row, row, row + 1.0]))
    lat0 = math.radians(lats[0])

    def en(i):
        dlon = (lons[i] - lons[0] + 180.0) % 360.0 - 180.0
        return (radius_m * math.cos(lat0) * math.radians(dlon), radius_m * math.radians(lats[i] - lats[0]))

    (e1, n1), (e2, n2) = en(1), en(2)
    return np.array([[e1, e2], [n1, n2]], dtype=np.float64)


def curvature_drop(rows: np.ndarray, cols: np.ndarray, jac: np.ndarray, center: tuple[float, float],
                   radius_m: float = MARS_RADIUS_M) -> np.ndarray:
    """Caída de la superficie (m) respecto del plano tangente en `center` (fila, col)."""
    dr, dc = rows - center[0], cols - center[1]
    e = jac[0, 0] * dc + jac[0, 1] * dr
    n = jac[1, 0] * dc + jac[1, 1] * dr
    return (e * e + n * n) / (2.0 * radius_m)


# ------------------------------------------------------------------ escala cercana

@dataclass(frozen=True)
class SweepPlan:
    """Cómo recorrer la grilla para un azimut solar.

    axis: 0 = se avanza fila por fila, 1 = columna por columna (el eje más alineado con el Sol).
    step_m: metros de suelo por paso sobre ese eje, a lo largo del rayo.
    slope: cuántos píxeles se corre la línea en el otro eje por cada paso.
    reverse: True si se recorre desde el último índice (el Sol está de ese lado).
    """
    axis: int
    step_m: float
    slope: float
    reverse: bool


def sweep_plan(jac: np.ndarray, sun_az_deg: float) -> SweepPlan:
    az = math.radians(sun_az_deg)
    toward_sun = np.array([math.sin(az), math.cos(az)])  # este, norte
    v = np.linalg.solve(jac, -toward_sun)                # píxeles (col, fila) por metro, alejándose del Sol
    if abs(v[0]) >= abs(v[1]):
        major, minor, axis = v[0], v[1], 1
    else:
        major, minor, axis = v[1], v[0], 0
    return SweepPlan(axis=axis, step_m=1.0 / abs(major), slope=minor / abs(major), reverse=bool(major < 0))


def sweep_lit(get_lines: Callable[[int, int], np.ndarray], n_major: int, n_minor: int,
              plan: SweepPlan, tan_el: float, block: int = 512) -> Iterator[tuple[int, int, np.ndarray]]:
    """Recorre la grilla desde el lado del Sol y devuelve, por bloque, qué píxeles ven el Sol
    según el terreno cercano.

    get_lines(i0, i1) devuelve las alturas en el plano tangente de las líneas i0..i1−1 del
    eje mayor, forma (i1−i0, n_minor), con −inf donde no hay dato (no tapa nada).
    Produce (i0, i1, lit) con lit booleano de la misma forma.
    """
    offs = np.rint(np.arange(n_major) * plan.slope).astype(np.int64)
    omin, omax = min(int(offs.min()), 0), max(int(offs.max()), 0)
    # Una entrada por línea paralela al rayo: el máximo de z + u·tan(e) visto hasta ahora.
    # float32 alcanza: a 10⁵ m el error de redondeo es de milímetros.
    state = np.full(n_minor + omax - omin, -np.inf, dtype=np.float32)
    t = np.empty(n_minor, dtype=np.float32)
    starts = list(range(0, n_major, block))
    if plan.reverse:
        starts.reverse()
    for i0 in starts:
        i1 = min(i0 + block, n_major)
        lines = np.asarray(get_lines(i0, i1), dtype=np.float32)
        lit = np.empty(lines.shape, dtype=bool)
        idx = range(i1 - i0 - 1, -1, -1) if plan.reverse else range(i1 - i0)
        for j in idx:
            k = (n_major - 1 - (i0 + j)) if plan.reverse else (i0 + j)
            o = omax - offs[k]
            s = state[o:o + n_minor]
            np.add(lines[j], np.float32(k * plan.step_m * tan_el), out=t)
            np.less_equal(s, t, out=lit[j])
            np.maximum(s, t, out=s)
        yield i0, i1, lit


# ------------------------------------------------------------------ escala lejana

@dataclass
class FarHorizon:
    """Horizonte lejano en una grilla de observadores, para azimuts de 0 a 359°.

    A y B: tan H ≈ A − z·B en cada observador, con z la altura del píxel (ver módulo).
    grid_rows / grid_cols: posición de los observadores en píxeles del DTM de trabajo.
    """
    a: np.ndarray            # (ny, nx, n_az)
    b: np.ndarray            # (ny, nx, n_az)
    grid_rows: np.ndarray    # (ny,)
    grid_cols: np.ndarray    # (nx,)
    az_step_deg: float

    def at_azimuth(self, az_deg: float) -> tuple[np.ndarray, np.ndarray]:
        """A y B interpolados linealmente en azimut."""
        n = self.a.shape[2]
        x = (az_deg % 360.0) / self.az_step_deg
        i0 = int(math.floor(x)) % n
        i1, w = (i0 + 1) % n, x - math.floor(x)
        return (self.a[..., i0] * (1 - w) + self.a[..., i1] * w,
                self.b[..., i0] * (1 - w) + self.b[..., i1] * w)

    def tan_at(self, a: np.ndarray, b: np.ndarray, rows: np.ndarray, cols: np.ndarray,
               z: np.ndarray) -> np.ndarray:
        """tan del horizonte lejano en el bloque rows × cols (1D cada uno), con alturas z
        de forma (len(rows), len(cols)). Interpolación bilineal entre observadores."""
        gr = np.interp(rows, self.grid_rows, np.arange(len(self.grid_rows)))[:, None]
        gc = np.interp(cols, self.grid_cols, np.arange(len(self.grid_cols)))[None, :]
        coords = np.array([np.broadcast_to(gr, z.shape).ravel(), np.broadcast_to(gc, z.shape).ravel()])
        ai = map_coordinates(a, coords, order=1, mode="nearest").reshape(z.shape)
        bi = map_coordinates(b, coords, order=1, mode="nearest").reshape(z.shape)
        return ai - z * bi


def destination(lat_deg: np.ndarray, lon_deg: np.ndarray, az_deg: float, dist_m: np.ndarray,
                radius_m: float = MARS_RADIUS_M) -> tuple[np.ndarray, np.ndarray]:
    """Punto a `dist_m` sobre el círculo máximo, saliendo con azimut `az_deg` (esfera)."""
    lat1, lon1 = np.radians(lat_deg)[:, None], np.radians(lon_deg)[:, None]
    ang, th = dist_m[None, :] / radius_m, math.radians(az_deg)
    lat2 = np.arcsin(np.sin(lat1) * np.cos(ang) + np.cos(lat1) * np.sin(ang) * math.cos(th))
    lon2 = lon1 + np.arctan2(math.sin(th) * np.sin(ang) * np.cos(lat1), np.cos(ang) - np.sin(lat1) * np.sin(lat2))
    return np.degrees(lat2), np.degrees(lon2)


def far_horizon_tan(obs_lat: np.ndarray, obs_lon: np.ndarray, obs_z: np.ndarray,
                    sample_dem: Callable[[np.ndarray, np.ndarray], np.ndarray],
                    covered_by_dtm: Callable[[np.ndarray, np.ndarray], np.ndarray],
                    az_deg: float, dist_m: np.ndarray,
                    radius_m: float = MARS_RADIUS_M) -> tuple[np.ndarray, np.ndarray]:
    """tan del ángulo de horizonte y distancia del punto que lo define, para un azimut.

    Solo cuenta terreno que el DTM no cubre (fuera del rectángulo o sin dato), así las dos
    escalas no se pisan. sample_dem devuelve NaN fuera del DEM.
    """
    lat2, lon2 = destination(obs_lat, obs_lon, az_deg, dist_m, radius_m)
    zt = sample_dem(lat2, lon2)
    ok = np.isfinite(zt) & ~covered_by_dtm(lat2, lon2)
    d = dist_m[None, :]
    tan = np.where(ok, (zt - obs_z[:, None] - d * d / (2.0 * radius_m)) / d, -np.inf)
    k = np.argmax(tan, axis=1)
    best = tan[np.arange(len(obs_z)), k]
    return best, np.where(np.isfinite(best), dist_m[k], np.inf)


def build_far_horizon(obs_lat: np.ndarray, obs_lon: np.ndarray, obs_z: np.ndarray,
                      grid_shape: tuple[int, int], grid_rows: np.ndarray, grid_cols: np.ndarray,
                      sample_dem, covered_by_dtm, dist_m: np.ndarray, az_step_deg: float = 1.0,
                      radius_m: float = MARS_RADIUS_M, chunk: int = 2000) -> FarHorizon:
    n_az = int(round(360.0 / az_step_deg))
    n = len(obs_z)
    a = np.full((n, n_az), NO_FAR, dtype=np.float32)
    b = np.zeros((n, n_az), dtype=np.float32)
    valid = np.isfinite(obs_z)
    idx = np.flatnonzero(valid)
    for c0 in range(0, len(idx), chunk):
        sel = idx[c0:c0 + chunk]
        for j in range(n_az):
            tan, dstar = far_horizon_tan(obs_lat[sel], obs_lon[sel], obs_z[sel], sample_dem,
                                         covered_by_dtm, j * az_step_deg, dist_m, radius_m)
            has = np.isfinite(tan)
            bj = np.where(has, 1.0 / dstar, 0.0)
            a[sel, j] = np.where(has, tan + obs_z[sel] * bj, NO_FAR)
            b[sel, j] = bj
    shape = (*grid_shape, n_az)
    return FarHorizon(a.reshape(shape), b.reshape(shape), grid_rows, grid_cols, az_step_deg)
