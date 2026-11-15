"""Planificador 4D de POST /api/route: A* sobre la grilla del sitio, con costo según la
hora estimada de llegada a cada celda.

Modelo de costo (docs/seguridad.md, decisión en docs/context.md §5):

    costo de un paso = Δt · (1 + Σ_k w_k · r_k(celda, hora de llegada))
    Δt               = largo sobre el terreno (horizontal / cos pendiente) / velocidad
    r_pendiente      = pendiente media de la celda / pendiente máxima (límite duro);
                       ≥ el límite no se pisa; sin dato = 1
    r_sombra         = banda de shadow_hourly.tif más cercana a la hora de llegada a
                       la celda: en sombra 1; al sol o sin dato 0
    r_contacto       = sin línea de vista al hábitat 1 (sin dato también); con vista 0
    rugosidad, suelo suelto y radiación por terreno tienen peso pero todavía no tienen
    capa: quedan inactivos y la respuesta lo dice

El "1 +" es el tiempo puro: como cada paso cuesta al menos Δt, la distancia octile /
velocidad nunca sobreestima lo que falta; la heurística es admisible y consistente, y
el A* da la ruta de menor costo de la grilla. Los pesos son visibles en la respuesta
(`cost`), con cuántos minutos-equivalentes aporta cada factor.

La seguridad de la ruta (límites duros, puntaje, robustez y veredicto) sale de
api/safety.py sobre la ruta ya resuelta. Aproximación declarada: la hora de llegada a cada celda es la de
la ruta de menor costo hasta ella (A* clásico, no un A* dependiente del tiempo exacto).

Para que responda en pocos segundos, cada tramo se resuelve en una ventana con margen
alrededor de sus extremos, promediada a celdas de modo que el lado mayor tenga como
mucho MAX_CELLS_SIDE celdas. Solo lee rasters precomputados: nunca corre el pipeline.

Degradar, no romper: si falta la pendiente, si un punto cae fuera del DTM o si el
tramo es muy largo, ese tramo va en línea recta con clase `unknown` y se dice por qué.
"""
from __future__ import annotations

import bisect
import datetime as dt
import heapq
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import safety
from .consumables import SOURCE as SUIT_SOURCE
from .consumables import (Step, SuitParams, battery_wh, dwell_consumption, o2_kg, pandolf_watts,
                          segment_consumption)
from .contact import ASSUMPTIONS as CONTACT_ASSUMPTIONS
from .contact import ContactField
from .illumination import (NODATA_U8, SHADOW, SOL_REUSE_MAX_DLS_DEG, ShadowStack, apply_affine, parse_utc,
                           sample_on_points, stack_for_time)
from .terrain import MARS_LONGLAT, MARS_RADIUS_M, _norm_lon, densify, haversine_m

SPEED_M_S = 0.8          # el mismo default de /api/route/consumables

# = SLOPE_CLASSES (web/src/map/layers.ts) y RAMPAS (pipeline/tiles.py). El último corte es el
# límite duro de pendiente: lo que el mapa pinta "no transitable" es lo que el A* no pisa.
SLOPE_CUTS = (10.0, 20.0, safety.Limits().max_slope_deg)
CLASSES = ("ok", "caution", "limit", "blocked")   # solo para colorear el tramo


@dataclass(frozen=True)
class CostWeights:
    """Pesos w_k del costo. Defaults documentados en docs/seguridad.md."""
    slope: float = 2.0
    shadow: float = 1.0
    contact: float = 1.0
    roughness: float = 1.0
    loose_soil: float = 1.0
    radiation: float = 1.0


# id, etiqueta, por qué no está activo (None = tiene capa)
COST_FACTORS: tuple[tuple[str, str, str | None], ...] = (
    ("slope", "Pendiente", None),
    ("shadow", "Sombra / frío", None),
    ("contact", "Sin contacto con el hábitat", None),
    ("roughness", "Rugosidad", "Falta la capa de rugosidad en el pipeline."),
    ("loose_soil", "Suelo suelto (THEMIS)", "Falta la inercia térmica de THEMIS procesada."),
    ("radiation", "Radiación por terreno",
     "La dosis por celda (survival-dose) varía menos que la incertidumbre de RAD: entra en el "
     "presupuesto de dosis de la travesía, no en el costo del A*."),
)

MAX_CELLS_SIDE = 300
MIN_MARGIN_M = 300.0
MARGIN_FRACTION = 0.5
MAX_WINDOW_PX = 40_000_000   # ~6 km × 6 km a 1 m: más que eso, sumar una estación intermedia
STRIP_PX = 4_000_000         # se lee la pendiente de a franjas para no cargar la ventana entera


class LegNotPlannable(Exception):
    """El tramo no se puede evaluar sobre el terreno; va en línea recta como `unknown`."""


# ------------------------------------------------------------------ geometría


def _to_xy(crs, latlon: list[tuple[float, float]]) -> tuple[list[float], list[float]]:
    from rasterio.warp import transform
    return transform(MARS_LONGLAT, crs, [_norm_lon(lo) for _, lo in latlon], [la for la, _ in latlon])


def _to_lonlat(crs, xs, ys) -> list[tuple[float, float]]:
    from rasterio.warp import transform
    lons, lats = transform(crs, MARS_LONGLAT, list(xs), list(ys))
    return list(zip(lons, lats))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Rumbo inicial sobre la esfera, 0° = norte, sentido horario."""
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _pixel_ground_m(ds, row: int, col: int) -> tuple[float, float]:
    """Tamaño real del píxel sobre el suelo (E-O, N-S) cerca de (row, col), en cualquier CRS."""
    t = ds.transform
    pts = [t * (col + 0.5, row + 0.5), t * (col + 1.5, row + 0.5), t * (col + 0.5, row + 1.5)]
    (lo0, la0), (lo1, la1), (lo2, la2) = _to_lonlat(ds.crs, [p[0] for p in pts], [p[1] for p in pts])
    return haversine_m(la0, lo0, la1, lo1), haversine_m(la0, lo0, la2, lo2)


@dataclass
class Grid:
    """Ventana de trabajo de un tramo: pendiente por celda y su georreferencia.

    Cada celda junta f × f píxeles de slope.tif. `slope` es la media (para el costo y
    el estiramiento del paso); `peak` es la pendiente que no se puede esquivar dentro
    de la celda (para lo que no se pisa, el límite duro y la clase del tramo).

    `peak` es la f-ésima pendiente más alta de la celda: cruzarla de lado a lado pisa
    al menos f píxeles, así que una franja empinada que la atraviesa (≥ f píxeles) no
    se diluye en el promedio, y una roca o un píxel ruidoso suelto (< f píxeles) no
    bloquea una celda de 30 m. Con f = 1 es el valor del píxel. Así lo que se puede
    pisar no depende del largo del tramo (que fija f).
    """
    slope: np.ndarray        # grados, media por celda, NaN = sin dato
    cls: np.ndarray          # índice en CLASSES según `peak`, -1 = sin dato
    transform: object        # Affine celda → CRS del raster
    crs: object
    dx_m: float
    dy_m: float
    contact: np.ndarray | None = None   # 1 con vista al hábitat, 0 tapado, -1 sin dato
    slope_peak: np.ndarray | None = None  # grados, f-ésima más alta por celda; None = igual a la media

    @property
    def peak(self) -> np.ndarray:
        return self.slope if self.slope_peak is None else self.slope_peak

    def cell_of(self, x: float, y: float) -> tuple[int, int]:
        c, r = apply_affine(~self.transform, x, y)
        return int(math.floor(r)), int(math.floor(c))

    def centers(self) -> tuple[np.ndarray, np.ndarray]:
        rows, cols = self.cls.shape
        cc, rr = np.meshgrid(np.arange(cols) + 0.5, np.arange(rows) + 0.5)
        return apply_affine(self.transform, cc, rr)


def build_grid(ds, a_xy: tuple[float, float], b_xy: tuple[float, float], leg_m: float) -> Grid:
    """Lee la pendiente alrededor de un tramo y la junta en celdas de trabajo (media y la
    f-ésima más alta, ver Grid)."""
    from rasterio.transform import Affine
    from rasterio.windows import Window

    ends = []
    for x, y in (a_xy, b_xy):
        r, c = ds.index(x, y, op=math.floor)
        if not (0 <= r < ds.height and 0 <= c < ds.width):
            raise LegNotPlannable("Un extremo del tramo cae fuera del DTM del sitio.")
        ends.append((r, c))
    (ra, ca), (rb, cb) = ends
    px_e, px_n = _pixel_ground_m(ds, (ra + rb) // 2, (ca + cb) // 2)

    margin_m = max(MIN_MARGIN_M, MARGIN_FRACTION * leg_m)
    mr, mc = math.ceil(margin_m / px_n), math.ceil(margin_m / px_e)
    r0, r1 = max(0, min(ra, rb) - mr), min(ds.height, max(ra, rb) + mr + 1)
    c0, c1 = max(0, min(ca, cb) - mc), min(ds.width, max(ca, cb) + mc + 1)
    h, w = r1 - r0, c1 - c0
    if h * w > MAX_WINDOW_PX:
        raise LegNotPlannable(f"Tramo de {leg_m / 1000:.1f} km: muy largo para evaluarlo de una vez; "
                              "sumá una estación intermedia.")

    f = max(1, math.ceil(max(h, w) / MAX_CELLS_SIDE))
    nr, nc = -(-h // f), -(-w // f)
    sums = np.zeros((nr, nc))
    counts = np.zeros((nr, nc))
    peaks = np.full((nr, nc), -np.inf)      # máximo por celda
    unavoid = np.full((nr, nc), -np.inf)    # f-ésima más alta por celda
    n = f * f
    nodata = ds.nodata
    strip = f * max(1, (STRIP_PX // w) // f)
    for rs in range(0, h, strip):
        rh = min(strip, h - rs)
        a = ds.read(1, window=Window(c0, r0 + rs, w, rh)).astype(np.float64)
        valid = np.isfinite(a) & (a >= 0)
        if nodata is not None:
            valid &= a != nodata
        ph = -(-rh // f) * f
        vals = np.zeros((ph, nc * f))
        mask = np.zeros((ph, nc * f))
        tops = np.full((ph, nc * f), -np.inf)
        vals[:rh, :w] = np.where(valid, a, 0.0)
        mask[:rh, :w] = valid
        tops[:rh, :w] = np.where(valid, a, -np.inf)
        i0 = rs // f
        blk = (ph // f, f, nc, f)
        sums[i0:i0 + ph // f] += vals.reshape(blk).sum(axis=(1, 3))
        counts[i0:i0 + ph // f] += mask.reshape(blk).sum(axis=(1, 3))
        np.maximum(peaks[i0:i0 + ph // f], tops.reshape(blk).max(axis=(1, 3)), out=peaks[i0:i0 + ph // f])
        # La franja tiene filas de celdas enteras (strip es múltiplo de f): cada celda cae entera acá.
        cells = tops.reshape(blk).transpose(0, 2, 1, 3).reshape(ph // f, nc, n)
        unavoid[i0:i0 + ph // f] = np.partition(cells, n - f, axis=2)[..., n - f]

    slope = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
    # Celdas incompletas (borde de la ventana o del DTM, huecos): no se sabe cuántos píxeles hay que
    # pisar para cruzarlas, así que va el máximo, que es lo conservador.
    slope_peak = np.where(counts >= n, unavoid, np.where(counts > 0, peaks, np.nan))
    cls = np.full(slope.shape, -1, dtype=np.int8)
    known = np.isfinite(slope_peak)
    cls[known] = np.searchsorted(SLOPE_CUTS, slope_peak[known], side="right")
    transform = ds.window_transform(Window(c0, r0, w, h)) * Affine.scale(f)
    return Grid(slope, cls, transform, ds.crs, px_e * f, px_n * f, slope_peak=slope_peak)


# ------------------------------------------------------------------ sombra


class ShadowSampler:
    """Sol/sombra en una celda a una hora dada. Lee cada banda una sola vez por tramo."""

    def __init__(self, stack: ShadowStack, ds, grid: Grid):
        self.stack, self.ds = stack, ds
        xs, ys = grid.centers()
        if ds.crs != grid.crs:
            from rasterio.warp import transform
            tx, ty = transform(grid.crs, ds.crs, xs.ravel().tolist(), ys.ravel().tolist())
            xs, ys = np.asarray(tx).reshape(xs.shape), np.asarray(ty).reshape(ys.shape)
        self.xs, self.ys = xs, ys
        px = (stack.index.get("grid") or {}).get("pixel_ground_m") or [None]
        self.pixel_m = min(px) if px[0] else None
        self.cell_m = min(grid.dx_m, grid.dy_m)
        self.times = [t for _, t, _, _ in stack.bands]
        self.band_ids = [b for b, _, _, _ in stack.bands]
        self.cache: dict[int, list[int]] = {}

    def band_at(self, t: float) -> int | None:
        i = bisect.bisect_left(self.times, t)
        best = min((j for j in (i - 1, i) if 0 <= j < len(self.times)), key=lambda j: abs(self.times[j] - t))
        return self.band_ids[best] if abs(self.times[best] - t) <= self.stack.half_step_s + 1 else None

    def at(self, t: float, v: int) -> int | None:
        band = self.band_at(t)
        if band is None:
            return None
        arr = self.cache.get(band)
        if arr is None:
            arr = sample_on_points(self.ds, band, self.xs, self.ys, self.cell_m, self.pixel_m).ravel().tolist()
            self.cache[band] = arr
        val = arr[v]
        return None if val == NODATA_U8 else val


# ------------------------------------------------------------------ A*


def cell_terms(grid: Grid, max_slope: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Por celda: r_pendiente, r_contacto y si se puede pisar. Lo usan astar() y los tests.

    r_pendiente sale de la media (cuánto cuesta cruzar la celda); si se puede pisar sale
    del máximo (el límite duro no se promedia)."""
    known = np.isfinite(grid.slope)
    r_slope = np.where(known, np.clip(np.nan_to_num(grid.slope) / max_slope, 0.0, 1.0), 1.0)
    passable = ~np.isfinite(grid.peak) | (np.nan_to_num(grid.peak) < max_slope)
    if grid.contact is None:
        r_contact = np.zeros(grid.slope.shape)
    else:
        r_contact = (grid.contact != 1).astype(np.float64)
    return r_slope, r_contact, passable


def astar(grid: Grid, start: tuple[int, int], goal: tuple[int, int], t0: float,
          speed: float = SPEED_M_S, shadow: ShadowSampler | None = None,
          weights: CostWeights = CostWeights(), max_slope: float = safety.Limits().max_slope_deg):
    """Ruta de menor costo entre dos celdas. Devuelve ([(r, c)], [hora de llegada]) o None.

    Las celdas con pendiente ≥ `max_slope` (límite duro) no se pisan, salvo la de
    llegada: si una estación está en una pendiente así, la ruta llega y el límite de
    pendiente sale roto en el veredicto.
    """
    rows, cols = grid.cls.shape
    dx, dy = grid.dx_m, grid.dy_m
    dd = math.hypot(dx, dy)
    moves = [(0, 1, dx), (0, -1, dx), (1, 0, dy), (-1, 0, dy),
             (1, 1, dd), (1, -1, dd), (-1, 1, dd), (-1, -1, dd)]
    r_slope, r_contact, passable = cell_terms(grid, max_slope)
    static = (1.0 + weights.slope * r_slope + weights.contact * r_contact).ravel().tolist()
    ok = passable.ravel().tolist()
    w_shadow = weights.shadow
    stretch = (1.0 / np.cos(np.radians(np.nan_to_num(grid.slope, nan=0.0)))).ravel().tolist()

    s, g_idx = start[0] * cols + start[1], goal[0] * cols + goal[1]
    gr, gc = goal
    n = rows * cols
    g = [math.inf] * n
    tarr = [0.0] * n
    parent = [-1] * n
    closed = bytearray(n)
    g[s], tarr[s] = 0.0, t0

    def h(r: int, c: int) -> float:
        di, dj = abs(r - gr), abs(c - gc)
        m = min(di, dj)
        return (m * dd + (di - m) * dy + (dj - m) * dx) / speed

    heap = [(h(*start), 0.0, s)]
    while heap:
        _, gu, u = heapq.heappop(heap)
        if closed[u]:
            continue
        closed[u] = 1
        if u == g_idx:
            break
        r, c = divmod(u, cols)
        tu = tarr[u]
        for dr, dc, length in moves:
            rr, cc = r + dr, c + dc
            if not (0 <= rr < rows and 0 <= cc < cols):
                continue
            v = rr * cols + cc
            if closed[v]:
                continue
            if not ok[v] and v != g_idx:
                continue
            fac = static[v]
            step_t = length * stretch[v] / speed
            ta = tu + step_t
            if shadow is not None and w_shadow and shadow.at(ta, v) == SHADOW:
                fac += w_shadow
            ng = gu + step_t * fac
            if ng < g[v]:
                g[v], tarr[v], parent[v] = ng, ta, u
                heapq.heappush(heap, (ng + h(rr, cc), ng, v))

    if not closed[g_idx]:
        return None
    path, times, v = [], [], g_idx
    while v != -1:
        path.append(divmod(v, cols))
        times.append(tarr[v])
        v = parent[v]
    return path[::-1], times[::-1]


# ------------------------------------------------------------------ armado de la respuesta


def _mv(value, unit, src: dict, extra_assumptions: list[str] | None = None) -> dict:
    out = {"value": value, "unit": unit, "provenance": src["provenance"],
           "mission": src.get("mission"), "instrument": src.get("instrument")}
    for k in ("resolution", "source"):
        if src.get(k):
            out[k] = src[k]
    a = list(src.get("assumptions") or []) + list(extra_assumptions or [])
    if a:
        out["assumptions"] = a
    return out


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _hhmm_utc(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%H:%M UTC")


GEOMETRY = {"provenance": "DERIVED", "mission": None, "instrument": None,
            "source": f"Geometría esférica (R = {MARS_RADIUS_M:.0f} m)"}

MODEL = {"provenance": "MODELED", "mission": None, "instrument": None, "source": SUIT_SOURCE,
         "assumptions": [f"Caminata a {SPEED_M_S} m/s sobre el terreno",
                         "Supuestos del EMU de la ISS (docs/consumibles del traje.md)"]}


@dataclass
class LegPlan:
    latlon: list[tuple[float, float]]
    steps: list[Step]
    elev: list[float | None]
    cls: str
    max_slope: float | None
    shadow_fraction: float | None
    planned: bool
    note: str | None = None
    resolution: str | None = None
    notes: list[str] = field(default_factory=list)
    duration_s: float = 0.0
    slopes: list[float | None] = field(default_factory=list)    # por paso, al final del paso
    visible: list[bool | None] = field(default_factory=list)    # por paso, al final del paso
    cost_s: dict[str, float] = field(default_factory=dict)      # aporte de cada factor (s)


def _straight_leg(a, b, note: str, contact: ContactField | None = None) -> LegPlan:
    """Tramo en línea recta, sin terreno. Si hay DTM, igual se calcula la línea de vista
    cada ~celda, para no contar todo el tramo como sin contacto."""
    if contact is None:
        d = haversine_m(a[0], a[1], b[0], b[1])
        return LegPlan([a, b], [Step(d, 0.0)], [None, None], "unknown", None, None, False, note,
                       slopes=[None], visible=[None])
    pts = densify(a[0], a[1], b[0], b[1], max(contact.cell_m, 10.0))
    steps = [Step(haversine_m(*pts[j], *pts[j + 1]), 0.0) for j in range(len(pts) - 1)]
    vis = contact.visible_latlon(pts[1:])
    return LegPlan([a, b], steps, [None, None], "unknown", None, None, False, note,
                   slopes=[None] * len(steps), visible=vis)


def _contact_on_grid(grid: Grid, contact: ContactField) -> np.ndarray:
    xs, ys = grid.centers()
    if contact.crs != grid.crs:
        from rasterio.warp import transform
        tx, ty = transform(grid.crs, contact.crs, xs.ravel().tolist(), ys.ravel().tolist())
        xs, ys = np.asarray(tx), np.asarray(ty)
    return contact.visible_xy(xs, ys).reshape(grid.cls.shape)


def _plan_leg(a, b, t0: float, slope_ds, dtm_ds, shadow_ds, stack: ShadowStack | None,
              contact: ContactField | None = None, weights: CostWeights = CostWeights(),
              limits: safety.Limits = safety.Limits()) -> LegPlan:
    leg_m = haversine_m(a[0], a[1], b[0], b[1])
    (xa, xb), (ya, yb) = _to_xy(slope_ds.crs, [a, b])
    grid = build_grid(slope_ds, (xa, ya), (xb, yb), leg_m)
    if contact is not None:
        grid.contact = _contact_on_grid(grid, contact)
    start, goal = grid.cell_of(xa, ya), grid.cell_of(xb, yb)
    sampler = ShadowSampler(stack, shadow_ds, grid) if stack is not None and shadow_ds is not None else None
    found = astar(grid, start, goal, t0, SPEED_M_S, sampler, weights, limits.max_slope_deg)
    res = f"celdas de {grid.dx_m:.0f} × {grid.dy_m:.0f} m"
    if found is None:
        plan = _straight_leg(a, b, f"No hay paso con pendiente menor a {limits.max_slope_deg:.0f}° "
                                   "dentro de la zona evaluada.", contact)
        plan.cls, plan.resolution = "blocked", res
        return plan
    path, times = found

    cols = [c for _, c in path]
    rows = [r for r, _ in path]
    xs, ys = apply_affine(grid.transform, np.array(cols) + 0.5, np.array(rows) + 0.5)
    latlon = [(la, lo) for lo, la in _to_lonlat(grid.crs, xs, ys)]
    latlon[0], latlon[-1] = a, b

    elev: list[float | None] = [None] * len(path)
    if dtm_ds is not None:
        dx_, dy_ = (xs, ys) if dtm_ds.crs == grid.crs else _to_xy(dtm_ds.crs, latlon)
        nod = dtm_ds.nodata
        for i, v in enumerate(dtm_ds.sample(zip(dx_, dy_), indexes=1)):
            z = float(v[0])
            if math.isfinite(z) and not (nod is not None and math.isclose(z, nod, rel_tol=1e-6)):
                elev[i] = z
    steps = []
    for i in range(len(path) - 1):
        d = haversine_m(*latlon[i], *latlon[i + 1])
        z0, z1 = elev[i], elev[i + 1]
        steps.append(Step(d, (z1 - z0) if z0 is not None and z1 is not None else 0.0))

    cls_path = [int(grid.cls[r, c]) for r, c in path]
    known = [k for k in cls_path if k >= 0]
    worst = max(known) if known else None
    if worst is not None and worst >= 2:
        leg_cls = CLASSES[worst]
    elif len(known) < len(cls_path):
        leg_cls = "unknown"
    else:
        leg_cls = CLASSES[worst] if worst is not None else "unknown"
    peak = grid.peak
    slopes = [float(peak[r, c]) for r, c in path if np.isfinite(peak[r, c])]

    shadow_fraction = None
    cols_n = grid.cls.shape[1]
    shade = [None] * len(path)
    if sampler is not None:
        shade = [sampler.at(t, r * cols_n + c) for (r, c), t in zip(path, times)]
        seen = [v for v in shade if v is not None]
        if seen:
            shadow_fraction = sum(v == SHADOW for v in seen) / len(seen)

    # Desglose del costo: el mismo que minimizó astar(), paso por paso.
    r_slope, r_contact, _ = cell_terms(grid, limits.max_slope_deg)
    cost = {"base": 0.0, "slope": 0.0, "shadow": 0.0, "contact": 0.0}
    for j in range(1, len(path)):
        (r0, c0), (r1, c1) = path[j - 1], path[j]
        dt_s = times[j] - times[j - 1]
        cost["base"] += dt_s
        cost["slope"] += dt_s * weights.slope * r_slope[r1, c1]
        cost["contact"] += dt_s * weights.contact * r_contact[r1, c1]
        if shade[j] == SHADOW:
            cost["shadow"] += dt_s * weights.shadow
    if grid.contact is not None:
        vis = [None if grid.contact[r, c] < 0 else bool(grid.contact[r, c]) for r, c in path[1:]]
    else:
        vis = [None] * (len(path) - 1)
    step_slopes = [float(peak[r, c]) if np.isfinite(peak[r, c]) else None for r, c in path[1:]]

    plan = LegPlan(latlon, steps, elev, leg_cls, max(slopes) if slopes else None, shadow_fraction, True,
                   resolution=res, slopes=step_slopes, visible=vis, cost_s=cost)
    missing_z = sum(z is None for z in elev)
    if missing_z:
        plan.notes.append(f"{missing_z} de {len(elev)} puntos sin cota del DTM: ahí se tomó el terreno plano")
    return plan


def _terrain_inputs(data_dir: Path, site_id: str) -> tuple[Path | None, Path | None, dict]:
    """slope.tif y dtm.tif según terrain.json (los escribe pipeline/precompute.py)."""
    out = Path(data_dir) / "output" / site_id
    try:
        idx = json.loads((out / "terrain.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None, {}
    layers = idx.get("layers") or {}

    def ok(layer_id):
        layer = layers.get(layer_id) or {}
        p = out / layer.get("file", "")
        return p if layer.get("status") == "ok" and layer.get("file") and p.is_file() else None

    return ok("relief-slope"), ok("dtm"), layers.get("relief-slope") or {}


def _dose_rate_msv_per_h(repo_dir: Path) -> tuple[float | None, dict]:
    try:
        ref = json.loads((repo_dir / "reference" / "rad_surface_dose.json").read_text(encoding="utf-8"))
        rate = float(ref["dose_equivalent_mSv_per_day"]["value"]) / 24.0
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        return None, {"provenance": "MODELED", "mission": "MSL", "instrument": "RAD",
                      "source": "Falta reference/rad_surface_dose.json"}
    return rate, {"provenance": "MODELED", "mission": "MSL", "instrument": "RAD",
                  "source": "Hassler et al. 2014 (reference/rad_surface_dose.json)",
                  "assumptions": [f"Tasa medida en Gale ({rate * 24:.2f} mSv/día), igual en todo el recorrido",
                                  "Sin blindaje del terreno ni eventos solares"]}


def _dose_layer(data_dir: Path, site_id: str) -> tuple[Path | None, dict]:
    """dose_rate.tif según terrain.json (lo escribe pipeline/precompute.py con pipeline/radiation.py)."""
    out = data_dir / "output" / site_id
    try:
        meta = json.loads((out / "terrain.json").read_text(encoding="utf-8"))["layers"]["survival-dose"]
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        return None, {}
    p = out / meta.get("file", "")
    return (p if meta.get("status") == "ok" and meta.get("file") and p.is_file() else None), meta


def _route_dose_rate(data_dir: Path, site_id: str, repo_dir: Path,
                     legs_plan: list["LegPlan"]) -> tuple[float | None, dict]:
    """Tasa de dosis de la travesía (mSv/h): promedio de dose_rate.tif sobre los puntos de la ruta.

    Sin la capa (o con la ruta afuera), la tasa de base de RAD igual en todo el recorrido.
    """
    base_rate, base_src = _dose_rate_msv_per_h(repo_dir)
    path, meta = _dose_layer(data_dir, site_id)
    pts = [p for plan in legs_plan for p in plan.latlon]
    if path is None or not pts:
        return base_rate, base_src
    import rasterio
    with rasterio.open(path) as ds:
        xs, ys = _to_xy(ds.crs, pts)
        vals = np.array([v[0] for v in ds.sample(zip(xs, ys))], dtype=float)
        nodata = ds.nodata
    ok = np.isfinite(vals) & (vals > 0)
    if nodata is not None and not np.isnan(nodata):
        ok &= vals != nodata
    if not ok.any():
        return base_rate, {**base_src, "assumptions": list(base_src.get("assumptions", []))
                           + ["La ruta queda fuera de la capa de dosis por terreno"]}
    rate = float(vals[ok].mean()) / 1000.0          # µSv/h -> mSv/h
    src = {"provenance": "MODELED", "mission": "MSL", "instrument": "RAD",
           "resolution": meta.get("resolution"),
           "source": "dose_rate.tif (pipeline/radiation.py): base de RAD × sky-view del terreno",
           "assumptions": (meta.get("assumptions") or [])
           + ["Promedio de la dosis por celda sobre los puntos de la ruta; la espera en las "
              "estaciones usa el mismo promedio"]}
    return rate, src


SCORE_SRC = {
    "provenance": "MODELED", "mission": None, "instrument": None,
    "source": "Eslabón más débil: 100 · min(1 − usado/límite) sobre los límites duros (api/safety.py)",
    "assumptions": ["Los valores de los límites (o la parte que los arma, como la reserva o el margen "
                    "antes del atardecer) son del equipo, ver docs/seguridad.md",
                    "Cuenta márgenes, no es una probabilidad"],
}

ASSUMED = {"provenance": "ASSUMED", "mission": None, "instrument": None, "source": safety.ASSUMED_SOURCE}

LIMIT_ROUND = {"terrain": 1, "o2": 3, "battery": 1, "daylight": 1, "contact": 1, "dose": 3, "calories": 0}


def _limit_sources(slope_src: dict, dose_src: dict, contact: ContactField | None) -> dict[str, dict]:
    contact_src = {"provenance": "MODELED", "mission": "MRO", "instrument": "HiRISE DTM",
                   "source": "Línea de vista al hábitat sobre el DTM (api/contact.py) y tiempos de caminata",
                   "assumptions": CONTACT_ASSUMPTIONS + ["La salida es el hábitat"]}
    if contact is not None:
        contact_src["resolution"] = contact.resolution
    return {
        "terrain": {**slope_src, "assumptions": [
            "Peor celda pisada, con la pendiente que no se puede esquivar dentro de cada celda de trabajo "
            "(la f-ésima más alta de f × f píxeles de slope.tif)",
            "La pendiente de slope.tif es por píxel: no ve escalones más chicos que el píxel"]},
        "o2": MODEL, "battery": MODEL, "calories": MODEL,
        "daylight": {**MODEL, "assumptions": list(MODEL["assumptions"]) + [
            "Atardecer sobre horizonte plano, del index.json de la pila de sombras"]},
        "contact": contact_src, "dose": dose_src,
    }


def _limit_bound_sources(stack: ShadowStack | None, limits: safety.Limits) -> dict[str, dict]:
    """Procedencia del valor de cada límite. ASSUMED solo cuando el número entero lo eligió
    el equipo; si sale de un dato (atardecer) o de un parámetro del traje (capacidad), se dice
    eso y la parte elegida por el equipo va en `assumptions`."""
    reserve = (f"Reserva del {100 * limits.reserve_fraction:.0f} % fijada por el equipo, "
               "sin fuente citable todavía (docs/seguridad.md)")
    suit = {"provenance": "MODELED", "mission": None, "instrument": None,
            "source": "Capacidad del traje menos la reserva · EMU de la ISS (docs/consumibles del traje.md)",
            "assumptions": [reserve]}
    margin_note = (f"Margen de {limits.sunset_margin_min:.0f} min antes del atardecer fijado por el equipo, "
                   "sin fuente citable todavía (docs/seguridad.md)")
    if stack is not None:
        sun = stack.provenance()
        daylight = {**sun, "provenance": "MODELED",
                    "source": f"Atardecer − margen − salida · {sun['source']}",
                    "assumptions": list(sun.get("assumptions") or []) + [
                        "Atardecer sobre horizonte plano", margin_note]}
    else:
        daylight = {**ASSUMED, "assumptions": [margin_note]}
    return {"terrain": ASSUMED, "o2": suit, "battery": suit, "daylight": daylight,
            "contact": ASSUMED, "dose": ASSUMED, "calories": ASSUMED}


def _limit_out(r: "safety.LimitResult", used_src: dict[str, dict], limit_src: dict[str, dict]) -> dict:
    label, unit = safety.LIMIT_LABELS[r.id]
    nd = LIMIT_ROUND[r.id]
    rnd = (lambda v: None if v is None else round(v, nd))
    return {
        "id": r.id, "label": label, "status": r.status if r.defined else "undefined",
        "complete": r.complete, "note": r.note,
        "margin": None if r.margin is None else round(max(r.margin, -1.0), 3),
        "used": _mv(rnd(r.used), unit, used_src[r.id]),
        "limit": _mv(rnd(r.limit), unit, limit_src[r.id]),
    }


def _robustness_out(a: "safety.Assessment") -> dict:
    passed, total = a.robustness
    scenarios = []
    for sc in a.scenarios:
        ev = sc.evaluation
        lim = None
        if ev is not None:
            lim = min(ev.broken, key=lambda r: r.margin) if ev.broken else ev.limiting
        scenarios.append({
            "id": sc.id, "label": sc.label, "status": sc.status,
            "limiting_factor": lim.id if lim is not None else None,
            "score": None if ev is None or ev.score is None else round(ev.score),
            "note": sc.note,
        })
    return {"passed": passed, "evaluated": total, "scenarios": scenarios}


def _cost_out(legs_plan: list[LegPlan], w: CostWeights, has_contact: bool, has_shadow: bool) -> dict:
    total = {k: sum(plan.cost_s.get(k, 0.0) for plan in legs_plan) for k in ("base", "slope", "shadow", "contact")}
    planned = any(plan.planned for plan in legs_plan)
    factors = []
    for fid, label, missing in COST_FACTORS:
        if missing is None and fid == "contact" and not has_contact:
            missing = "Falta el DTM para la línea de vista."
        if missing is None and fid == "shadow" and not has_shadow:
            missing = "Falta la pila de sombras de ese sol."
        if missing is None and not planned:
            missing = "Ningún tramo se resolvió sobre el terreno."
        active = missing is None
        factors.append({"id": fid, "label": label, "weight": getattr(w, fid), "active": active,
                        "minutes": round(total[fid] / 60.0, 1) if active else None, "note": missing})
    active_min = sum(f["minutes"] or 0.0 for f in factors)
    return {
        "formula": "costo = Σ celdas Δt · (1 + Σ_k w_k · r_k)",
        "unit": "min",
        "base_minutes": round(total["base"] / 60.0, 1) if planned else None,
        "total_minutes": round(total["base"] / 60.0 + active_min, 1) if planned else None,
        "factors": factors,
    }


def plan_route(site_id: str, depart_utc: str, waypoints: list[dict], data_dir: Path, repo_dir: Path,
               params: SuitParams | None = None, weights: CostWeights = CostWeights(),
               limits: safety.Limits = safety.Limits()) -> dict:
    """Arma la respuesta de POST /api/route (contrato en docs/context.md §4)."""
    import rasterio

    p = params or SuitParams()
    t_depart = parse_utc(depart_utc)
    pts = [(float(w["lat"]), float(w["lon"])) for w in waypoints]
    slope_path, dtm_path, slope_meta = _terrain_inputs(data_dir, site_id)
    stack = stack_for_time(data_dir, site_id, t_depart)
    caveats: list[str] = []
    if slope_path is None:
        caveats.append("sin la pendiente procesada los tramos van en línea recta y el terreno no se evaluó")
    if stack is None:
        tope = f"{SOL_REUSE_MAX_DLS_DEG:g}".replace(".", ",")
        caveats.append("no se evaluó la luz: falta la pila de sombras de ese sol y no hay otra de la misma "
                       f"estación (±{tope}° Ls)")
    elif stack.reuse is not None:
        dls = f"{stack.reuse.dls:+.1f}".replace(".", ",")
        caveats.append(f"la luz se estimó con las sombras del sol {stack.tag}, de la misma estación (ΔLs {dls}°)")

    slope_ds = rasterio.open(slope_path) if slope_path else None
    dtm_ds = rasterio.open(dtm_path) if dtm_path else None
    shadow_ds = rasterio.open(stack.tif) if stack else None
    # La línea de vista tiene que cubrir la ventana del A* del tramo más largo (ver build_grid).
    longest = max(haversine_m(*pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
    contact = (ContactField.from_dtm(dtm_ds, pts[0], pts, max(MIN_MARGIN_M, MARGIN_FRACTION * longest))
               if dtm_ds is not None else None)
    if contact is None:
        caveats.append("no se evaluó el contacto con el hábitat: falta el DTM en la salida")
    try:
        legs_plan: list[LegPlan] = []
        t = t_depart
        o2_used = bat_used = 0.0
        arrivals: list[float | None] = [None]
        departures: list[float | None] = [t_depart]
        state = [(0.0, 0.0, 0.0)]  # O2 usado, batería usada, segundos desde la salida, por estación
        for i in range(len(pts) - 1):
            if slope_ds is None:
                plan = _straight_leg(pts[i], pts[i + 1], "Falta slope.tif: no se evaluó el terreno.", contact)
            else:
                try:
                    plan = _plan_leg(pts[i], pts[i + 1], t, slope_ds, dtm_ds, shadow_ds, stack,
                                     contact, weights, limits)
                except LegNotPlannable as e:
                    plan = _straight_leg(pts[i], pts[i + 1], str(e), contact)
            legs_plan.append(plan)
            seg = segment_consumption(plan.steps, SPEED_M_S, p)
            plan.duration_s = seg["duration_s"]
            o2_used += seg["o2_kg"]
            bat_used += seg["battery_wh"]
            t += seg["duration_s"]
            arrivals.append(t)
            state.append((o2_used, bat_used, t - t_depart))
            if i + 1 < len(pts) - 1:
                stay = dwell_consumption(max(0.0, float(waypoints[i + 1].get("dwell_min") or 0)) * 60.0, p)
                o2_used += stay["o2_kg"]
                bat_used += stay["battery_wh"]
                t += stay["duration_s"]
                departures.append(t)
            else:
                departures.append(None)
    finally:
        for ds in (slope_ds, dtm_ds, shadow_ds):
            if ds is not None:
                ds.close()

    # La dosis depende de por dónde pasa la ruta: se calcula con los tramos ya resueltos.
    dose_rate, dose_src = _route_dose_rate(data_dir, site_id, repo_dir, legs_plan)

    t_end = t
    elapsed = max(t_end - t_depart, 0.0)
    o2_left, bat_left = p.o2_capacity_kg - o2_used, p.battery_capacity_wh - bat_used
    standing_o2_rate = o2_kg(pandolf_watts(0.0, 0.0, p), 1.0, p)
    o2_rate = o2_used / elapsed if elapsed > 0 else standing_o2_rate
    bat_rate_wh_s = battery_wh(1.0, p)
    o2_margin = o2_left / o2_rate / 60.0 if o2_rate > 0 else math.inf
    bat_margin = bat_left / bat_rate_wh_s / 60.0 if bat_rate_wh_s > 0 else math.inf
    margin = min(o2_margin, bat_margin)
    margin_mv = _mv(round(margin, 1), "min", MODEL, ["Reserva al ritmo de consumo medio de la travesía"])

    # ---- tramos
    slope_src = {"provenance": "DERIVED", "mission": slope_meta.get("mission") or "MRO",
                 "instrument": "HiRISE DTM", "source": "slope.tif (pipeline/precompute.py)"}
    legs = []
    for i, plan in enumerate(legs_plan):
        dur_s = plan.duration_s
        a, b = plan.latlon[0], plan.latlon[-1]
        dist = sum(s.dx_m for s in plan.steps)
        if plan.planned:
            path_src = {"provenance": "DERIVED", "mission": slope_src["mission"], "instrument": "HiRISE DTM",
                        "resolution": plan.resolution, "source": "A* sobre la pendiente del DTM (api/planner.py)"}
            extra = list(plan.notes)
        else:
            path_src = {**GEOMETRY, "assumptions": ["Tramo en línea recta: no se evaluó el terreno"]}
            extra = [plan.note] if plan.note else []
        leg = {
            "from": i, "to": i + 1,
            "coordinates": [[round(lo, 7), round(la, 7)] for la, lo in plan.latlon],
            "class": plan.cls,
            "distance": _mv(round(dist, 1), "m", path_src, extra),
            "duration": _mv(round(dur_s / 60.0, 1), "min", MODEL, extra),
            "bearing": _mv(round(bearing_deg(a[0], a[1], b[0], b[1]), 1), "°", GEOMETRY,
                           ["Rumbo inicial de la estación de salida a la de llegada del tramo"]),
            "max_slope": _mv(None if plan.max_slope is None else round(plan.max_slope, 1), "°",
                             {**slope_src, "resolution": plan.resolution} if plan.planned else
                             {**slope_src, "source": plan.note or slope_src["source"]},
                             [f"Pendiente que no se puede esquivar en cada celda ({plan.resolution}): la f-ésima "
                              "más alta de sus f × f píxeles. Una franja que la cruza no se diluye; una roca "
                              "suelta no la bloquea"]
                             if plan.planned else None),
        }
        if stack is not None:
            leg["shadow_fraction"] = _mv(
                None if plan.shadow_fraction is None else round(100 * plan.shadow_fraction, 1), "%",
                stack.provenance(), ["Fracción de celdas de la ruta en sombra a la hora estimada de paso"])
        legs.append(leg)

    # ---- estaciones
    stops = []
    for i, w in enumerate(waypoints):
        o2_i, bat_i, el_i = state[i]
        stops.append({
            "index": i, "lat": pts[i][0], "lon": pts[i][1], "task": w.get("task"),
            "arrive_utc": _iso(arrivals[i]) if arrivals[i] is not None else None,
            "depart_utc": _iso(departures[i]) if departures[i] is not None else None,
            "o2_remaining": _mv(round(100 * (1 - o2_i / p.o2_capacity_kg), 1), "%", MODEL),
            "battery_remaining": _mv(round(100 * (1 - bat_i / p.battery_capacity_wh), 1), "%", MODEL),
            "dose_accumulated": _mv(None if dose_rate is None else round(dose_rate * el_i / 3600.0, 4),
                                    "mSv", dose_src),
            "margin": margin_mv,
        })

    # ---- seguridad: límites duros, puntaje, robustez (api/safety.py)
    dwells = [max(0.0, float(w.get("dwell_min") or 0)) * 60.0 for w in waypoints[1:-1]]
    track = safety.Track(
        legs=[safety.TrackLeg(plan.steps, plan.slopes, plan.visible) for plan in legs_plan],
        dwell_s=dwells,
        station_visible=[plan.visible[-1] if plan.visible else None for plan in legs_plan],
        contact_evaluated=contact is not None,
        blocked_legs=[i for i, plan in enumerate(legs_plan) if plan.cls == "blocked"],
    )
    cond = safety.Conditions(
        depart_s=t_depart, speed_m_s=SPEED_M_S, params=p,
        sunrise_s=stack.sunrise if stack is not None else None,
        sunset_s=stack.sunset if stack is not None else None,
        dose_rate_msv_h=dose_rate,
    )
    assessment = safety.assess(track, cond, limits)
    base = assessment.base
    if assessment.status == "NO_GO":
        factor = min(base.broken, key=lambda r: r.margin).id
    else:
        lim = base.limiting
        factor = lim.id if lim is not None else None
    summary = safety.summary(assessment)
    if assessment.reasons and assessment.status == "CAUTION":
        summary += " Cuidado: " + "; ".join(assessment.reasons) + "."
    if any(leg["class"] == "unknown" for leg in legs) and slope_path is not None:
        caveats.append("hay tramos con terreno sin evaluar")
    if caveats:
        summary += " Ojo: " + "; ".join(caveats) + "."

    used_src = _limit_sources(slope_src, dose_src, contact)
    limit_src = _limit_bound_sources(stack, limits)
    verdict = {
        "status": assessment.status, "limiting_factor": factor, "summary": summary, "margin": margin_mv,
        "score": _mv(None if base.score is None else round(base.score), "pts", SCORE_SRC),
        "limits": [_limit_out(r, used_src, limit_src) for r in base.limits],
        "robustness": _robustness_out(assessment),
    }
    light_source = "missing"
    if stack is not None and slope_path is not None:
        light_source = "reused" if stack.reuse is not None else "exact"
    terrain_source = "processed" if slope_path is not None else "missing"
    terrain_planned = [plan.planned for plan in legs_plan]
    if slope_path is None or not terrain_planned or not any(terrain_planned):
        terrain_status = "missing"
    elif all(terrain_planned):
        terrain_status = "complete"
    else:
        terrain_status = "partial"
    if slope_path is None or stack is None or not terrain_planned or not any(terrain_planned):
        light_status = "missing"
    elif all(terrain_planned):
        light_status = "complete"
    else:
        light_status = "partial"
    out = {
        "site": site_id,
        "depart_utc": depart_utc,
        "legs": legs,
        "stops": stops,
        "verdict": verdict,
        "cost": _cost_out(legs_plan, weights, contact is not None, stack is not None),
        "data_quality": {
            "terrain_status": terrain_status,
            "terrain_evaluated": terrain_status == "complete",
            "terrain_source": terrain_source,
            "light_status": light_status,
            "light_evaluated": light_status == "complete",
            "light_source": light_source,
            "contact_evaluated": contact is not None,
        },
    }
    if all(plan.planned and all(z is not None for z in plan.elev) for plan in legs_plan):
        out["_profile_inputs"] = ([plan.steps for plan in legs_plan], [legs_plan[0].elev[0]]
                                  + [plan.elev[-1] for plan in legs_plan])
    return out
