"""Planificador 4D de POST /api/route: A* sobre la grilla del sitio, con costo según la
hora estimada de llegada a cada celda.

Modelo de costo (decisión del equipo, docs/context.md §5):

    costo de un paso = tiempo de caminata × factor de pendiente × factor de sombra
    tiempo           = largo sobre el terreno (horizontal / cos pendiente) / velocidad
    pendiente        = media de la celda; mismos cortes que SLOPE_CLASSES de web/:
                       < 10° ×1 · 10–20° ×1.5 · 20–30° ×3 · ≥ 30° no se pisa · sin dato ×2
    sombra           = banda de shadow_hourly.tif más cercana a la hora de llegada a
                       la celda: en sombra ×2; al sol o sin dato ×1

Todos los factores son ≥ 1, así que la distancia octile / velocidad nunca sobreestima
lo que falta: la heurística es admisible y consistente, y el A* da la ruta de menor
costo de la grilla. Aproximación declarada: la hora de llegada a cada celda es la de
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

from .consumables import SOURCE as SUIT_SOURCE
from .consumables import (Step, SuitParams, battery_wh, dwell_consumption, o2_kg, pandolf_watts,
                          segment_consumption)
from .illumination import (NODATA_U8, SHADOW, ShadowStack, apply_affine, parse_utc, sample_on_points,
                           stack_for_time)
from .terrain import MARS_LONGLAT, MARS_RADIUS_M, _norm_lon, haversine_m

SPEED_M_S = 0.8          # el mismo default de /api/route/consumables
RESERVE_MIN = 30.0       # reserva mínima al llegar, igual que el planificador de ejemplo

SLOPE_CUTS = (10.0, 20.0, 30.0)  # = SLOPE_CLASSES (web/src/map/layers.ts) y RAMPAS (pipeline/tiles.py)
CLASSES = ("ok", "caution", "limit", "blocked")
SLOPE_FACTOR = (1.0, 1.5, 3.0, math.inf)
UNKNOWN_SLOPE_FACTOR = 2.0
SHADOW_FACTOR = 2.0

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
    """Ventana de trabajo de un tramo: pendiente media por celda y su georreferencia."""
    slope: np.ndarray        # grados, NaN = sin dato
    cls: np.ndarray          # índice en CLASSES, -1 = sin dato
    transform: object        # Affine celda → CRS del raster
    crs: object
    dx_m: float
    dy_m: float

    def cell_of(self, x: float, y: float) -> tuple[int, int]:
        c, r = apply_affine(~self.transform, x, y)
        return int(math.floor(r)), int(math.floor(c))

    def centers(self) -> tuple[np.ndarray, np.ndarray]:
        rows, cols = self.cls.shape
        cc, rr = np.meshgrid(np.arange(cols) + 0.5, np.arange(rows) + 0.5)
        return apply_affine(self.transform, cc, rr)


def build_grid(ds, a_xy: tuple[float, float], b_xy: tuple[float, float], leg_m: float) -> Grid:
    """Lee la pendiente alrededor de un tramo y la promedia a celdas de trabajo."""
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
        vals[:rh, :w] = np.where(valid, a, 0.0)
        mask[:rh, :w] = valid
        i0 = rs // f
        sums[i0:i0 + ph // f] += vals.reshape(ph // f, f, nc, f).sum(axis=(1, 3))
        counts[i0:i0 + ph // f] += mask.reshape(ph // f, f, nc, f).sum(axis=(1, 3))

    slope = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
    cls = np.full(slope.shape, -1, dtype=np.int8)
    known = np.isfinite(slope)
    cls[known] = np.searchsorted(SLOPE_CUTS, slope[known], side="right")
    transform = ds.window_transform(Window(c0, r0, w, h)) * Affine.scale(f)
    return Grid(slope, cls, transform, ds.crs, px_e * f, px_n * f)


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


def astar(grid: Grid, start: tuple[int, int], goal: tuple[int, int], t0: float,
          speed: float = SPEED_M_S, shadow: ShadowSampler | None = None):
    """Ruta de menor costo entre dos celdas. Devuelve ([(r, c)], [hora de llegada]) o None.

    Las celdas ≥ 30° no se pisan, salvo la de salida y la de llegada (si una estación
    está en una pendiente así, la ruta sale `blocked` y el veredicto lo dice).
    """
    rows, cols = grid.cls.shape
    dx, dy = grid.dx_m, grid.dy_m
    dd = math.hypot(dx, dy)
    moves = [(0, 1, dx), (0, -1, dx), (1, 0, dy), (-1, 0, dy),
             (1, 1, dd), (1, -1, dd), (-1, 1, dd), (-1, -1, dd)]
    factor_by_cls = np.array(SLOPE_FACTOR + (UNKNOWN_SLOPE_FACTOR,))  # índice -1 = sin dato
    sfac = factor_by_cls[grid.cls].ravel().tolist()
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
            fac = sfac[v]
            if fac == math.inf:
                if v != g_idx:
                    continue
                fac = SLOPE_FACTOR[2]
            step_t = length * stretch[v] / speed
            ta = tu + step_t
            if shadow is not None and shadow.at(ta, v) == SHADOW:
                fac *= SHADOW_FACTOR
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


def _straight_leg(a, b, note: str) -> LegPlan:
    d = haversine_m(a[0], a[1], b[0], b[1])
    return LegPlan([a, b], [Step(d, 0.0)], [None, None], "unknown", None, None, False, note)


def _plan_leg(a, b, t0: float, slope_ds, dtm_ds, shadow_ds, stack: ShadowStack | None) -> LegPlan:
    leg_m = haversine_m(a[0], a[1], b[0], b[1])
    (xa, xb), (ya, yb) = _to_xy(slope_ds.crs, [a, b])
    grid = build_grid(slope_ds, (xa, ya), (xb, yb), leg_m)
    start, goal = grid.cell_of(xa, ya), grid.cell_of(xb, yb)
    sampler = ShadowSampler(stack, shadow_ds, grid) if stack is not None and shadow_ds is not None else None
    found = astar(grid, start, goal, t0, SPEED_M_S, sampler)
    res = f"celdas de {grid.dx_m:.0f} × {grid.dy_m:.0f} m"
    if found is None:
        plan = _straight_leg(a, b, "No hay paso con pendiente menor a 30° dentro de la zona evaluada.")
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
    slopes = [float(grid.slope[r, c]) for r, c in path if np.isfinite(grid.slope[r, c])]

    shadow_fraction = None
    if sampler is not None:
        cols_n = grid.cls.shape[1]
        vals = [sampler.at(t, r * cols_n + c) for (r, c), t in zip(path, times)]
        seen = [v for v in vals if v is not None]
        if seen:
            shadow_fraction = sum(v == SHADOW for v in seen) / len(seen)

    plan = LegPlan(latlon, steps, elev, leg_cls, max(slopes) if slopes else None, shadow_fraction, True,
                   resolution=res)
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


def plan_route(site_id: str, depart_utc: str, waypoints: list[dict], data_dir: Path, repo_dir: Path,
               params: SuitParams | None = None) -> dict:
    """Arma la respuesta de POST /api/route (contrato en docs/context.md §4)."""
    import rasterio

    p = params or SuitParams()
    t_depart = parse_utc(depart_utc)
    pts = [(float(w["lat"]), float(w["lon"])) for w in waypoints]
    slope_path, dtm_path, slope_meta = _terrain_inputs(data_dir, site_id)
    stack = stack_for_time(data_dir, site_id, t_depart)
    dose_rate, dose_src = _dose_rate_msv_per_h(repo_dir)
    caveats: list[str] = []
    if slope_path is None:
        caveats.append("sin la pendiente procesada los tramos van en línea recta y el terreno no se evaluó")
    if stack is None:
        caveats.append("no se evaluó la luz: falta la pila de sombras de ese sol")

    slope_ds = rasterio.open(slope_path) if slope_path else None
    dtm_ds = rasterio.open(dtm_path) if dtm_path else None
    shadow_ds = rasterio.open(stack.tif) if stack else None
    try:
        legs_plan: list[LegPlan] = []
        t = t_depart
        o2_used = bat_used = 0.0
        arrivals: list[float | None] = [None]
        departures: list[float | None] = [t_depart]
        state = [(0.0, 0.0, 0.0)]  # O2 usado, batería usada, segundos desde la salida, por estación
        for i in range(len(pts) - 1):
            if slope_ds is None:
                plan = _straight_leg(pts[i], pts[i + 1], "Falta slope.tif: no se evaluó el terreno.")
            else:
                try:
                    plan = _plan_leg(pts[i], pts[i + 1], t, slope_ds, dtm_ds, shadow_ds, stack)
                except LegNotPlannable as e:
                    plan = _straight_leg(pts[i], pts[i + 1], str(e))
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

    t_end = t
    elapsed = max(t_end - t_depart, 0.0)
    o2_left, bat_left = p.o2_capacity_kg - o2_used, p.battery_capacity_wh - bat_used
    standing_o2_rate = o2_kg(pandolf_watts(0.0, 0.0, p), 1.0, p)
    o2_rate = o2_used / elapsed if elapsed > 0 else standing_o2_rate
    bat_rate_wh_s = battery_wh(1.0, p)
    o2_margin = o2_left / o2_rate / 60.0 if o2_rate > 0 else math.inf
    bat_margin = bat_left / bat_rate_wh_s / 60.0 if bat_rate_wh_s > 0 else math.inf
    limiting = "o2" if o2_margin <= bat_margin else "battery"
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
                             [f"Pendiente media por celda ({plan.resolution}): no ve escalones más chicos"]
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

    # ---- veredicto: terreno, luz, reserva
    blocked = next((leg for leg in legs if leg["class"] == "blocked"), None)
    if blocked is not None:
        status, factor = "NO_GO", "terrain"
        summary = (f"No hay paso entre la estación {blocked['from']} y la {blocked['to']}: "
                   "pendiente de 30° o más.")
    elif stack is not None and stack.sunrise is not None and t_depart < stack.sunrise:
        status, factor = "NO_GO", "daylight"
        summary = f"Sale antes del amanecer ({_hhmm_utc(stack.sunrise)})."
    elif stack is not None and stack.sunset is not None and t_end > stack.sunset:
        status, factor = "NO_GO", "daylight"
        summary = f"Llega después del atardecer ({_hhmm_utc(stack.sunset)})."
    elif margin < RESERVE_MIN:
        status, factor = "NO_GO", limiting
        recurso = "El O2" if limiting == "o2" else "La batería"
        # Margen negativo: el recurso que limita (el que se agota primero) no alcanza.
        if margin <= 0:
            summary = f"{recurso} se agota antes de terminar la travesía."
        else:
            summary = f"{recurso} no deja la reserva mínima de {RESERVE_MIN:.0f} min al llegar."
    else:
        status, factor = "GO", limiting
        recurso = "el O2" if limiting == "o2" else "la batería"
        summary = f"Alcanza. Lo que se acaba primero es {recurso}."
    if any(leg["class"] == "unknown" for leg in legs) and slope_path is not None:
        caveats.append("hay tramos con terreno sin evaluar")
    if caveats:
        summary += " Ojo: " + "; ".join(caveats) + "."

    out = {"site": site_id, "depart_utc": depart_utc, "legs": legs, "stops": stops,
           "verdict": {"status": status, "limiting_factor": factor, "summary": summary, "margin": margin_mv}}
    if all(plan.planned and all(z is not None for z in plan.elev) for plan in legs_plan):
        out["_profile_inputs"] = ([plan.steps for plan in legs_plan], [legs_plan[0].elev[0]]
                                  + [plan.elev[-1] for plan in legs_plan])
    return out
