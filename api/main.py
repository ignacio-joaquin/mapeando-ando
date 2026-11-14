"""API de Mapa Marciano.

Expone el estado del servidor, el inventario de datos por sitio y /api/route, que hoy
calcula los consumibles del traje sobre una ruta dada. Acá se suman las point queries
y el pathfinding.
"""
import json
import os
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .consumables import Step, SuitParams, route_consumption
from .illumination_matrix import (
    a_star_path_between_points,
    find_latest_sol_dir,
    resolve_shadow_tif,
    rectangular_window_from_points,
)
from .terrain import TerrainError, densify, haversine_m, sample_dtm

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
REPO_DIR = Path(__file__).resolve().parent.parent

app = FastAPI(title="Mapa Marciano API", version="0.1.0")


def _manifest():
    p = DATA_DIR / "manifest.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


def _commit():
    try:
        return subprocess.run(["git", "-C", str(REPO_DIR), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, timeout=5).stdout.strip() or None
    except Exception:
        return None


@app.get("/api/health")
def health():
    m = _manifest()
    return {"ok": True, "commit": _commit(), "data_ready": m is not None,
            "manifest_generated_at": m and m.get("generated_at")}


@app.get("/api/sites")
def sites():
    m = _manifest()
    if m is None:
        return {"sites": [], "note": "La descarga de datos todavía no terminó."}
    out = []
    for sid, s in m["sites"].items():
        files = s["files"]
        out.append({"id": sid, "name": s["name"], "rover": s["rover"], "center": s["center"],
                    "bbox": s["bbox"], "files_ok": sum(f["status"] == "ok" for f in files),
                    "files_total": len(files)})
    return {"sites": out}


@app.get("/api/sites/{site_id}")
def site(site_id: str):
    m = _manifest()
    if m is None or site_id not in m["sites"]:
        raise HTTPException(404, "Sitio desconocido o datos todavía no descargados")
    return m["sites"][site_id]


# ---------------------------------------------------------------- /api/route

_DEFAULTS = SuitParams()
MAX_POINTS = 500
MAX_SAMPLES = 50_000


class RoutePoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360, description="Grados este, 0–360 o −180–180")
    elev_m: Optional[float] = Field(None, description="Si falta en todos los puntos, se lee del DTM")


class SuitOverrides(BaseModel):
    """Supuestos opcionales; lo que no se pasa toma el default del EMU de la ISS."""
    astronaut_kg: float = Field(_DEFAULTS.astronaut_kg, gt=0, le=300)
    suit_kg: float = Field(_DEFAULTS.suit_kg, ge=0, le=500)
    gravity_g: float = Field(_DEFAULTS.gravity_g, gt=0, le=1.5)
    terrain_factor: float = Field(_DEFAULTS.terrain_factor, ge=1.0, le=3.0)
    o2_kj_per_l: float = Field(_DEFAULTS.o2_kj_per_l, gt=0)
    o2_capacity_kg: float = Field(_DEFAULTS.o2_capacity_kg, gt=0)
    o2_leak_kg_per_h: float = Field(_DEFAULTS.o2_leak_kg_per_h, ge=0)
    battery_capacity_wh: float = Field(_DEFAULTS.battery_capacity_wh, gt=0)
    battery_efficiency: float = Field(_DEFAULTS.battery_efficiency, gt=0, le=1)
    base_power_w: float = Field(_DEFAULTS.base_power_w, ge=0)


class RouteRequest(BaseModel):
    site_id: Optional[str] = Field(None, description="Obligatorio si los puntos no traen elev_m")
    points: list[RoutePoint] = Field(min_length=2, max_length=MAX_POINTS)
    speed_m_s: float = Field(0.8, gt=0, le=3.0)
    cargo_kg: float = Field(_DEFAULTS.cargo_kg, ge=0, le=500, description="Carga extra transportada (M2)")
    sample_step_m: float = Field(10.0, ge=1.0, le=200.0, description="Paso de muestreo del DTM")
    suit: SuitOverrides = Field(default_factory=SuitOverrides)


class IlluminationPoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class IlluminationWindowRequest(BaseModel):
    site_id: str = Field(..., description="Sitio cuyo `shadow_hourly.tif` se consulta")
    sol_tag: Optional[str] = Field(None, description="Directorio de sol, por ejemplo 20261115T000000Z")
    ltst: Optional[str] = Field(None, description="Hora local solar, por ejemplo 12:30")
    p1: IlluminationPoint
    p2: IlluminationPoint
    band: Optional[int] = Field(None, ge=1, description="Banda del GeoTIFF; si falta, se resuelve desde ltst")
    pixel_size_m: float = Field(5.0, gt=0, le=100.0, description="Distancia en metros entre dos píxeles adyacentes")


def _dtm_path(site_id: str) -> Path:
    m = _manifest()
    if m is None or site_id not in m["sites"]:
        raise HTTPException(404, "Sitio desconocido o datos todavía no descargados")
    dtm = next((f for f in m["sites"][site_id]["files"] if f["key"] == "dtm" and f["status"] == "ok"), None)
    if dtm is None:
        raise HTTPException(503, f"El DTM de {site_id} no está disponible")
    return DATA_DIR / dtm["path"]


def _segments_from_request(req: RouteRequest) -> tuple[list[list[Step]], list[float], str]:
    pts = req.points
    given = [p.elev_m is not None for p in pts]
    if all(given):
        segments = [[Step(haversine_m(a.lat, a.lon, b.lat, b.lon), b.elev_m - a.elev_m)]
                    for a, b in zip(pts, pts[1:])]
        return segments, [p.elev_m for p in pts], "request"
    if any(given):
        raise HTTPException(422, "elev_m tiene que venir en todos los puntos o en ninguno")
    if not req.site_id:
        raise HTTPException(422, "Sin elev_m hace falta site_id para leer el DTM")
    path = _dtm_path(req.site_id)

    legs = [densify(a.lat, a.lon, b.lat, b.lon, req.sample_step_m) for a, b in zip(pts, pts[1:])]
    if sum(len(l) for l in legs) > MAX_SAMPLES:
        raise HTTPException(422, f"La ruta necesita más de {MAX_SAMPLES} muestras: subí sample_step_m")
    try:
        z = sample_dtm(path, [ll for leg in legs for ll in leg])
    except TerrainError as e:
        raise HTTPException(422, str(e))

    segments, vertex_elev, k = [], [], 0
    for leg in legs:
        zs = z[k:k + len(leg)]
        k += len(leg)
        vertex_elev.append(zs[0])
        segments.append([Step(haversine_m(*leg[j], *leg[j + 1]), zs[j + 1] - zs[j])
                         for j in range(len(leg) - 1)])
    vertex_elev.append(z[-1])
    return segments, vertex_elev, f"dtm:{req.site_id}"


@app.post("/api/route")
def route(req: RouteRequest):
    """Consumibles del traje por tramo sobre una ruta ya armada (lista de puntos).
    Cada tramo va de points[i] a points[i+1]. Todo el resultado es MODELED."""
    params = SuitParams(cargo_kg=req.cargo_kg, **req.suit.model_dump())
    segments, elev, elev_source = _segments_from_request(req)
    result = route_consumption(segments, req.speed_m_s, params)
    for i, seg in enumerate(result["segments"]):
        a, b = req.points[i], req.points[i + 1]
        seg["from"] = {"lat": a.lat, "lon": a.lon, "elev_m": elev[i]}
        seg["to"] = {"lat": b.lat, "lon": b.lon, "elev_m": elev[i + 1]}
    result["elevation_source"] = elev_source
    return result


@app.post("/api/illumination/window")
def illumination_window(req: IlluminationWindowRequest):
    """Devuelve una submatriz rectangular de iluminación entre dos coordenadas.

    La grilla queda en filas/columnas con resolución 5 m por píxel por defecto, y cada
    celda vale True si está iluminada y False si está en sombra.
    """
    try:
        tif_path, band = resolve_shadow_tif(req.site_id, req.sol_tag, req.ltst, DATA_DIR)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    band = req.band or band
    try:
        window = rectangular_window_from_points(
            tif_path,
            {"lat": req.p1.lat, "lon": req.p1.lon},
            {"lat": req.p2.lat, "lon": req.p2.lon},
            band=band,
            pixel_size_m=req.pixel_size_m,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    sol_tag = req.sol_tag or find_latest_sol_dir(req.site_id, DATA_DIR).name
    return {
        "site_id": req.site_id,
        "sol_tag": sol_tag,
        "ltst": req.ltst,
        "band": band,
        "pixel_size_m": window["pixel_size_m"],
        "adjacent_distance_m": window["adjacent_distance_m"],
        "shape": window["shape"],
        "window": window["window"],
        "values": window["values"],
    }


@app.post("/api/illumination/path")
def illumination_path(req: IlluminationWindowRequest):
    """Genera el mapa de iluminación para la hora pedida y luego ejecuta A* sobre ese mapa.

    La banda del GeoTIFF se resuelve a partir de `ltst` o de `band`; la ventana entre
    `p1` y `p2` se recorta de esa banda exacta; luego el A* minimiza la cantidad de
    celdas en sombra dentro de ese mapa.
    """
    try:
        tif_path, band = resolve_shadow_tif(req.site_id, req.sol_tag, req.ltst, DATA_DIR)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    band = req.band or band
    try:
        path = a_star_path_between_points(
            tif_path,
            {"lat": req.p1.lat, "lon": req.p1.lon},
            {"lat": req.p2.lat, "lon": req.p2.lon},
            band=band,
            pixel_size_m=req.pixel_size_m,
            allow_diagonal=False,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    sol_tag = req.sol_tag or find_latest_sol_dir(req.site_id, DATA_DIR).name
    return path["path"]
