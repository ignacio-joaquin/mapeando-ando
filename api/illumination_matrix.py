"""Utilidades para consultar una ventana rectangular de iluminado/sombra.

La API toma el GeoTIFF `shadow_hourly.tif` y lo recorta entre dos puntos
geográficos, devolviendo la submatriz resultante con una distancia de 5 m entre
píxeles adyacentes.
"""
from __future__ import annotations

import datetime as dt
import heapq
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.transform import rowcol

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

DEFAULT_PIXEL_SIZE_M = 5.0
LIT_VALUE = 1
SHADOW_VALUE = 0
NODATA_VALUE = 255


def _as_point(point: tuple[float, float] | list[float] | dict[str, float]) -> tuple[float, float]:
    if isinstance(point, dict):
        if "lat" not in point or "lon" not in point:
            raise ValueError("El punto debe incluir lat y lon")
        return float(point["lat"]), float(point["lon"])
    if len(point) != 2:
        raise ValueError("El punto debe ser (lat, lon) o {'lat': ..., 'lon': ...}")
    return float(point[0]), float(point[1])


def band_to_bool_mask(array: np.ndarray, nodata: int = NODATA_VALUE) -> np.ndarray:
    """Convierte un bloque de una banda del raster en una máscara booleana."""
    mask = np.asarray(array)
    lit = mask == LIT_VALUE
    nodata_mask = mask == nodata
    return np.where(nodata_mask, False, lit)


def find_latest_sol_dir(site_id: str, data_dir: str | Path | None = None) -> Path:
    """Devuelve el último directorio de sol disponible para un sitio."""
    base = Path(data_dir or DATA_DIR) / "output" / site_id / "illumination"
    entries = sorted([p for p in base.iterdir() if p.is_dir()]) if base.exists() else []
    if not entries:
        raise FileNotFoundError(f"No hay salidas de iluminación para {site_id} en {base}")
    return entries[-1]


def _sol_tag_to_utc(sol_tag: str) -> str:
    if sol_tag.endswith("Z"):
        return dt.datetime.strptime(sol_tag, "%Y%m%dT%H%M%SZ").strftime("%Y-%m-%dT%H:%M:%S")
    return sol_tag


def generate_illumination_for_site(
    site_id: str,
    sol_tag: str | None = None,
    start_utc: str | None = None,
    data_dir: str | Path | None = None,
) -> Path:
    """Genera el archivo `shadow_hourly.tif` para un sitio si aún no existe."""
    target_dir = Path(data_dir or DATA_DIR) / "output" / site_id
    script = Path(__file__).resolve().parents[1] / "pipeline" / "illumination.py"
    if not script.exists():
        raise FileNotFoundError(f"No existe el script de iluminación: {script}")

    start = start_utc or (_sol_tag_to_utc(sol_tag) if sol_tag else dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"))
    cmd = [
        sys.executable,
        str(script),
        "--site",
        site_id,
        "--start",
        start,
        "--out",
        str(target_dir),
    ]
    proc = subprocess.run(cmd, cwd=str(script.parent.parent), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Fallo al generar iluminación para {site_id}: {proc.stderr or proc.stdout or 'sin salida'}")

    if sol_tag is not None:
        tagged = target_dir / "illumination" / sol_tag
        tif = tagged / "shadow_hourly.tif"
        if tif.exists():
            return tif

    latest = find_latest_sol_dir(site_id, target_dir.parent.parent if data_dir is None else data_dir)
    tif = latest / "shadow_hourly.tif"
    if not tif.exists():
        raise FileNotFoundError(f"La generación no produjo {tif}")
    return tif


def resolve_shadow_tif(
    site_id: str,
    sol_tag: str | None = None,
    ltst: str | None = None,
    data_dir: str | Path | None = None,
) -> tuple[Path, int]:
    """Busca el `shadow_hourly.tif` correspondiente a un sitio y sol.

    Devuelve `(ruta_tif, banda)`; si `ltst` se pasa, la banda se calcula a partir de la
    hora local solar verdadera (HH:MM) y la resolución de 60 min por banda.
    """
    base = Path(data_dir or DATA_DIR) / "output" / site_id / "illumination"
    target = base / sol_tag if sol_tag else find_latest_sol_dir(site_id, data_dir or DATA_DIR)
    tif = target / "shadow_hourly.tif"
    if not tif.exists():
        try:
            tif = generate_illumination_for_site(site_id, sol_tag=sol_tag, data_dir=data_dir)
        except Exception as exc:  # pragma: no cover - depende del entorno de datos reales
            raise FileNotFoundError(f"No existe {target / 'shadow_hourly.tif'} y no se pudo generar: {exc}") from exc
    band = 1
    if ltst is not None:
        band = find_band_for_ltst(tif, ltst)
    return tif, band


def rectangular_window_from_points(
    tif_path: str | Path,
    p1: tuple[float, float] | list[float] | dict[str, float],
    p2: tuple[float, float] | list[float] | dict[str, float],
    *,
    band: int = 1,
    pixel_size_m: float = DEFAULT_PIXEL_SIZE_M,
) -> dict[str, Any]:
    """Recorta una ventana rectangular entre dos puntos geográficos.

    El orden de los puntos no importa. Cada píxel en la ventana representa
    `pixel_size_m` metros entre dos vecinos.
    """
    lat1, lon1 = _as_point(p1)
    lat2, lon2 = _as_point(p2)
    tif_path = Path(tif_path)

    with rasterio.open(tif_path) as ds:
        if band < 1 or band > ds.count:
            raise ValueError(f"band index out of range: {band} (count={ds.count})")
        arr = ds.read(band)
        r1, c1 = rowcol(ds.transform, lon1, lat1)
        r2, c2 = rowcol(ds.transform, lon2, lat2)

        r0, r1b = sorted((r1, r2))
        c0, c1b = sorted((c1, c2))
        r0 = max(0, r0)
        c0 = max(0, c0)
        r1b = min(arr.shape[0] - 1, r1b)
        c1b = min(arr.shape[1] - 1, c1b)

        crop = band_to_bool_mask(arr[r0:r1b + 1, c0:c1b + 1])
        return {
            "matrix": crop,
            "pixel_size_m": float(pixel_size_m),
            "adjacent_distance_m": float(pixel_size_m),
            "shape": [int(crop.shape[0]), int(crop.shape[1])],
            "window": {
                "row_start": int(r0),
                "row_end": int(r1b),
                "col_start": int(c0),
                "col_end": int(c1b),
            },
            "points": {
                "p1": {"lat": lat1, "lon": lon1},
                "p2": {"lat": lat2, "lon": lon2},
            },
            "values": crop.astype(bool).tolist(),
        }


def a_star_min_dark_cells(
    matrix: np.ndarray,
    start: tuple[int, int],
    goal: tuple[int, int],
    *,
    allow_diagonal: bool = False,
) -> dict[str, Any]:
    """Busca la ruta entre `start` y `goal` minimizando la cantidad de celdas no iluminadas.

    `matrix` usa `True` para iluminado y `False` para sombra. La ruta es un camino de
    4-vecinos (o 8-vecinos si `allow_diagonal=True`) con costo 0 si la celda es iluminada
    y costo 1 si es sombra. El criterio es minimizar la suma de celdas en sombra sobre
    la ruta, con una heurística de Manhattan.
    """
    grid = np.asarray(matrix, dtype=bool)
    if grid.ndim != 2:
        raise ValueError("La matriz debe ser bidimensional")

    rows, cols = grid.shape
    start_r, start_c = int(start[0]), int(start[1])
    goal_r, goal_c = int(goal[0]), int(goal[1])

    if not (0 <= start_r < rows and 0 <= start_c < cols):
        raise ValueError(f"start fuera de rango: {start}")
    if not (0 <= goal_r < rows and 0 <= goal_c < cols):
        raise ValueError(f"goal fuera de rango: {goal}")

    if start == goal:
        shadow_points = 1 if (not grid[start_r, start_c]) else 0
        return {
            "path": [start],
            "cost": shadow_points,
            "shadow_points": shadow_points,
            "total_steps": 0,
        }

    def heuristic(pos: tuple[int, int]) -> int:
        return abs(pos[0] - goal_r) + abs(pos[1] - goal_c)

    def neighbors(pos: tuple[int, int]) -> list[tuple[int, int]]:
        r, c = pos
        deltas = [(1, 0), (-1, 0), (0, 1), (0, -1)]
        if allow_diagonal:
            deltas.extend([(1, 1), (1, -1), (-1, 1), (-1, -1)])
        out: list[tuple[int, int]] = []
        for dr, dc in deltas:
            rr, cc = r + dr, c + dc
            if 0 <= rr < rows and 0 <= cc < cols:
                out.append((rr, cc))
        return out

    open_heap: list[tuple[int, int, tuple[int, int]]] = [(heuristic(start), 0, start)]
    came_from: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
    g_cost: dict[tuple[int, int], int] = {start: 0}

    while open_heap:
        _, current_cost, current = heapq.heappop(open_heap)
        if current == (goal_r, goal_c):
            break
        if current_cost > g_cost.get(current, 10**18):
            continue

        for nxt in neighbors(current):
            step_cost = 0 if grid[nxt] else 1
            tentative = current_cost + step_cost
            if tentative < g_cost.get(nxt, 10**18):
                came_from[nxt] = current
                g_cost[nxt] = tentative
                heapq.heappush(open_heap, (tentative + heuristic(nxt), tentative, nxt))

    if (goal_r, goal_c) not in came_from:
        raise ValueError(f"No existe un camino entre {start} y {goal}")

    path: list[tuple[int, int]] = []
    current: tuple[int, int] | None = (goal_r, goal_c)
    while current is not None:
        path.append(current)
        current = came_from[current]
    path.reverse()
    shadow_points = sum(1 for r, c in path[1:] if not grid[r, c])
    cost = int(g_cost.get((goal_r, goal_c), 0))
    return {
        "path": path,
        "cost": cost,
        "shadow_points": shadow_points,
        "total_steps": len(path) - 1,
    }


def a_star_path_between_points(
    tif_path: str | Path,
    p1: tuple[float, float] | list[float] | dict[str, float],
    p2: tuple[float, float] | list[float] | dict[str, float],
    *,
    band: int = 1,
    pixel_size_m: float = DEFAULT_PIXEL_SIZE_M,
    allow_diagonal: bool = False,
) -> dict[str, Any]:
    """Devuelve la ruta A* entre dos puntos geográficos minimizando celdas en sombra.

    Primero construye el mapa de iluminación de esa banda exacta y luego ejecuta A*
    sobre esa submatriz cortada entre los dos puntos.
    """
    lat1, lon1 = _as_point(p1)
    lat2, lon2 = _as_point(p2)
    tif_path = Path(tif_path)

    with rasterio.open(tif_path) as ds:
        if band < 1 or band > ds.count:
            raise ValueError(f"band index out of range: {band} (count={ds.count})")

        arr = ds.read(band)
        r1, c1 = rowcol(ds.transform, lon1, lat1)
        r2, c2 = rowcol(ds.transform, lon2, lat2)

        r0, rmax = sorted((r1, r2))
        c0, cmax = sorted((c1, c2))
        r0 = max(0, r0)
        c0 = max(0, c0)
        rmax = min(arr.shape[0] - 1, rmax)
        cmax = min(arr.shape[1] - 1, cmax)

        matrix = band_to_bool_mask(arr[r0:rmax + 1, c0:cmax + 1])
        start = (r1 - r0, c1 - c0)
        goal = (r2 - r0, c2 - c0)
        result = a_star_min_dark_cells(matrix, start, goal, allow_diagonal=allow_diagonal)

        path_geo: list[dict[str, float | int]] = []
        for rr, cc in result["path"]:
            row = r0 + rr
            col = c0 + cc
            lon, lat = rasterio.transform.xy(ds.transform, row, col, offset="center")
            path_geo.append({
                "row": int(row),
                "col": int(col),
                "lat": float(lat),
                "lon": float(lon),
            })

        return {
            "band": band,
            "pixel_size_m": float(pixel_size_m),
            "adjacent_distance_m": float(pixel_size_m),
            "map": matrix.astype(bool).tolist(),
            "map_shape": [int(matrix.shape[0]), int(matrix.shape[1])],
            "path": path_geo,
            "cost": result["cost"],
            "shadow_points": result["shadow_points"],
            "total_steps": result["total_steps"],
            "matrix_shape": [int(matrix.shape[0]), int(matrix.shape[1])],
            "start": {"lat": lat1, "lon": lon1},
            "goal": {"lat": lat2, "lon": lon2},
        }


def find_band_for_ltst(tif_path: str | Path, ltst: str) -> int:
    """Devuelve la banda a partir de un horario LTST como HH:MM.

    Asume paso de 60 min por banda, como en la salida de `shadow_hourly.tif`.
    """
    try:
        hh, mm = [int(x) for x in ltst.split(":", 1)]
    except ValueError as exc:
        raise ValueError("ltst debe venir en formato HH:MM") from exc
    minute = hh * 60 + mm
    band = minute // 60 + 1
    with rasterio.open(tif_path) as ds:
        if band < 1 or band > ds.count:
            raise ValueError(f"El horario {ltst} no existe en esta pila")
    return band


def read_index(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))
