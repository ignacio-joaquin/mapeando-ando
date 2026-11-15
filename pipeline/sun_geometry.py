"""Posición del Sol vista desde un punto de la superficie de Marte, con SPICE.

Kernels: naif0012.tls (segundos intercalares), pck00011.tpc (orientación IAU_MARS),
de440s.bsp (planetas) y mar0NNs.bsp (Marte respecto de su baricentro). Todo en UTC/ET
explícito; la hora local es la hora solar local verdadera (LTST) de SPICE (et2lst).
"""
from __future__ import annotations

import math
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import spiceypy as sp

MARS_RADIUS_M = 3396190.0
MARS_ID = 499
SOL_S = 88775.244          # sol solar medio, en segundos
LOCAL_DAY_S = 86400        # SPICE expresa la LTST en "segundos locales" (1/86400 de sol)


@contextmanager
def spice_kernels(paths: list[Path]):
    """Carga los kernels y los libera al salir, aunque haya error."""
    sp.kclear()
    try:
        for p in paths:
            sp.furnsh(str(p))
        yield
    finally:
        sp.kclear()


def _wrap_local(ds: float) -> float:
    """Diferencia de hora local llevada a (−medio sol, +medio sol]."""
    return (ds + LOCAL_DAY_S / 2) % LOCAL_DAY_S - LOCAL_DAY_S / 2


class SiteSun:
    """Sol desde un punto fijo (lat/lon planetocéntricas, este positivo; altura en m)."""

    def __init__(self, lat_deg: float, lon_deg: float, elev_m: float = 0.0,
                 radius_m: float = MARS_RADIUS_M):
        lat, lon = math.radians(lat_deg), math.radians(lon_deg)
        self.lat_deg, self.lon_deg, self.lon_rad = lat_deg, lon_deg, lon
        self.up = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
        self.east = np.array([-math.sin(lon), math.cos(lon), 0.0])
        self.north = np.array([-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)])
        self.obs_km = self.up * (radius_m + elev_m) / 1000.0

    def az_el(self, et: float) -> tuple[float, float]:
        """Azimut (desde el norte, horario) y elevación del centro del Sol, en grados.
        Corrige tiempo de luz y aberración estelar; no corrige refracción (atmósfera tenue)."""
        state, _ = sp.spkcpo("SUN", et, "IAU_MARS", "OBSERVER", "LT+S",
                             self.obs_km.tolist(), "MARS", "IAU_MARS")
        s = np.asarray(state[:3])
        s /= np.linalg.norm(s)
        el = math.degrees(math.asin(float(np.clip(s @ self.up, -1, 1))))
        az = math.degrees(math.atan2(s @ self.east, s @ self.north)) % 360.0
        return az, el

    def ltst_s(self, et: float) -> float:
        """Hora solar local verdadera, en segundos locales desde la medianoche (0..86399)."""
        hr, mn, sc, _, _ = sp.et2lst(et, MARS_ID, self.lon_rad, "PLANETOCENTRIC")
        return hr * 3600 + mn * 60 + sc

    def et_at_ltst(self, et_guess: float, target_s: float, iters: int = 8) -> float:
        """ET más cercano a `et_guess` en que la LTST vale `target_s` (±1 s local)."""
        et = et_guess
        for _ in range(iters):
            d = _wrap_local(target_s - self.ltst_s(et))
            if abs(d) < 1.0:
                break
            et += d * SOL_S / LOCAL_DAY_S
        return et

    def local_midnight_after(self, et: float) -> float:
        """Primera medianoche local (LTST 00:00) en o después de `et`."""
        to_go = (LOCAL_DAY_S - self.ltst_s(et)) % LOCAL_DAY_S
        m = self.et_at_ltst(et + to_go * SOL_S / LOCAL_DAY_S, 0.0)
        return m if m >= et - 1.0 else self.et_at_ltst(m + SOL_S, 0.0)

    def flat_horizon_crossings(self, et0: float, et1: float, step_s: float = 300.0) -> tuple[float | None, float | None]:
        """Amanecer y atardecer sobre horizonte plano (elevación 0 del centro del Sol)
        entre et0 y et1. None si el Sol no cruza (no pasa en latitudes de sitios de rover)."""
        ts = np.arange(et0, et1 + step_s, step_s)
        els = np.array([self.az_el(t)[1] for t in ts])
        rise = set_ = None
        for i in range(len(ts) - 1):
            if els[i] <= 0 < els[i + 1] and rise is None:
                rise = self._bisect_el(ts[i], ts[i + 1], rising=True)
            if els[i] > 0 >= els[i + 1]:
                set_ = self._bisect_el(ts[i], ts[i + 1], rising=False)
        return rise, set_

    def _bisect_el(self, lo: float, hi: float, rising: bool) -> float:
        for _ in range(30):
            mid = 0.5 * (lo + hi)
            up = self.az_el(mid)[1] > 0
            if up == rising:
                hi = mid
            else:
                lo = mid
            if hi - lo < 0.5:
                break
        return 0.5 * (lo + hi)


def solar_longitude_deg(et: float) -> float:
    """Ls: longitud solar de Marte (estación). 0° = equinoccio de primavera boreal."""
    return math.degrees(sp.lspcn("MARS", et, "LT+S")) % 360.0


def utc_to_et(utc: str) -> float:
    return sp.str2et(utc)


def et_to_utc(et: float) -> str:
    return sp.et2utc(et, "ISOC", 0) + "Z"
