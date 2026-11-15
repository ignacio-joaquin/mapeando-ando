"""Mars24 en la API: hora solar local (LTST) y longitud solar (Ls) sin SPICE.

Es el mismo algoritmo que `web/src/mars/mars24.ts` (Allison & McEwen 2000, tal
como lo publica el NASA GISS "Mars24 Sunclock algorithm"): si cambia uno, cambia
el otro. `api/tests/test_sol_reuse.py` compara los dos con valores sacados de la
versión de TypeScript.

Precisión del orden de segundos en la hora y de centésimas de grado en Ls: alcanza
para elegir qué pila de sombras usar y en qué banda horaria, no para navegación.
La API no carga SPICE (los kernels están en el pipeline y pesan).
"""
from __future__ import annotations

import math
from typing import NamedTuple

# TT − UTC en segundos (segundos intercalares + 32,184). Válido desde 2017-01-01.
TT_MINUS_UTC_S = 69.184
# Sol medio en segundos terrestres (1,027491252 días).
SOL_S = 88775.244

_PBS_TERMS = (
    (0.0071, 2.2353, 49.409),
    (0.0057, 2.7543, 168.173),
    (0.0039, 1.1177, 191.837),
    (0.0037, 15.7866, 21.736),
    (0.0021, 2.1354, 15.957),
    (0.0020, 2.4694, 95.528),
    (0.0018, 32.8493, 49.095),
)


def _sin(deg: float) -> float:
    return math.sin(math.radians(deg))


def _cos(deg: float) -> float:
    return math.cos(math.radians(deg))


class MarsTime(NamedTuple):
    msd: float        # Mars Sol Date
    mtc: float        # Coordinated Mars Time, horas 0–24 en el meridiano 0
    ls_deg: float     # longitud solar (estación), 0–360
    eot_h: float      # ecuación del tiempo, en horas


def mars_time(t: float) -> MarsTime:
    """Hora marciana de un instante UTC (segundos epoch)."""
    jd_tt = 2_440_587.5 + t / 86_400.0 + TT_MINUS_UTC_S / 86_400.0
    d = jd_tt - 2_451_545.0  # días desde J2000 (TT)

    m = (19.3871 + 0.52402073 * d) % 360.0
    alpha_fms = (270.3871 + 0.524038496 * d) % 360.0
    pbs = sum(a * _cos(0.985626 * d / tau + phi) for a, tau, phi in _PBS_TERMS)
    nu_minus_m = ((10.691 + 3.0e-7 * d) * _sin(m) + 0.623 * _sin(2 * m) + 0.05 * _sin(3 * m)
                  + 0.005 * _sin(4 * m) + 0.0005 * _sin(5 * m) + pbs)
    ls = (alpha_fms + nu_minus_m) % 360.0
    eot_deg = 2.861 * _sin(2 * ls) - 0.071 * _sin(4 * ls) + 0.002 * _sin(6 * ls) - nu_minus_m

    msd = (d - 4.5) / 1.027491252 + 44_796.0 - 0.00096
    return MarsTime(msd, (msd % 1.0) * 24.0, ls, eot_deg * 24.0 / 360.0)


def ls_deg(t: float) -> float:
    return mars_time(t).ls_deg


def ltst_hours(t: float, lon_east: float) -> float:
    """Hora solar verdadera local (lo que marca un reloj de sol), horas 0–24."""
    mt = mars_time(t)
    lon_west = (-lon_east) % 360.0
    return (mt.mtc - lon_west * 24.0 / 360.0 + mt.eot_h) % 24.0


def local_midnight_before(t: float, lon_east: float) -> float:
    """Última medianoche local (LTST 00:00) en o antes de `t`, en segundos epoch UTC."""
    m = t - ltst_hours(t, lon_east) / 24.0 * SOL_S
    for _ in range(3):  # la ecuación del tiempo cambia segundos por sol: converge enseguida
        off = (ltst_hours(m, lon_east) + 12.0) % 24.0 - 12.0
        m -= off / 24.0 * SOL_S
    return m if m <= t + 1.0 else m - SOL_S


def dls_deg(from_ls: float, to_ls: float) -> float:
    """Diferencia de estación de `from_ls` a `to_ls`, en grados, entre −180 y 180."""
    return (to_ls - from_ls + 180.0) % 360.0 - 180.0


def declination_deg(ls: float) -> float:
    """Declinación del Sol (latitud subsolar) según Ls. Mars24, paso C-1."""
    return math.degrees(math.asin(0.42565 * _sin(ls))) + 0.25 * _sin(ls)
