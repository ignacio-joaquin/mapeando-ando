"""API de Mapa Marciano.

Expone el estado del servidor, el inventario de datos por sitio, la point query,
la zona con contacto al hábitat (/api/sites/{site}/viewshed),
las condiciones actuales (/api/sites/{site}/conditions),
/api/route (planificador 4D, api/planner.py), /api/route/consumables (consumibles
del traje sobre una ruta ya armada) y /api/illumination/window (sol/sombra precomputados).
"""
import json
import math
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .consumables import Step, SuitParams, route_consumption
from .illumination import IlluminationNotReady, parse_utc, read_window, stack_for_tag
from .planner import _terrain_inputs as terrain_inputs
from .planner import CostWeights, plan_route
from .safety import Limits
from .terrain import MARS_RADIUS_M, TerrainError, densify, haversine_m, sample_dtm
from .viewshed import HabitatOutsideDtm
from .viewshed import viewshed as compute_viewshed

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


# ---------------------------------------------- /api/sites/{site}/conditions

# Qué instrumento mide cada condición en cada rover. Sirve para decir de dónde
# va a salir el dato aunque todavía falte; no es un valor.
_CONDITION_SOURCES = {
    "Perseverance": {"mission": "Mars 2020", "temperature": "MEDA", "pressure": "MEDA",
                     "dust_opacity": "MEDA RDS"},
    "Curiosity": {"mission": "MSL", "temperature": "REMS", "pressure": "REMS",
                  "dust_opacity": "Mastcam"},
}

_CONDITIONS = (
    ("temperature", "Temperatura del aire", "°C"),
    ("pressure", "Presión", "Pa"),
    ("dust_opacity", "Opacidad de polvo (τ)", None),
)


def _site_config(site_id: str) -> Optional[dict]:
    """sites/<id>.json del repo, o None si no es un sitio. Solo lee."""
    if not re.fullmatch(r"[a-z0-9_-]+", site_id) or site_id == "common":
        return None
    p = REPO_DIR / "sites" / f"{site_id}.json"
    if not p.is_file():
        return None
    return json.loads(p.read_text())


@app.get("/api/sites/{site_id}/conditions")
def site_conditions(site_id: str):
    """Condiciones actuales: última observación atmosférica del rover y alertas
    de clima espacial (DONKI).

    Todavía no hay paso del pipeline que baje MEDA/REMS ni DONKI: cada valor
    sale con `value: null` y `when: null`, y `note` dice qué falta. Nunca se
    rellena con un valor de ejemplo.
    """
    cfg = _site_config(site_id)
    if cfg is None:
        raise HTTPException(404, "Sitio desconocido")
    rover = str(cfg.get("rover") or "")
    src = next((v for k, v in _CONDITION_SOURCES.items() if rover.startswith(k)), None)
    observations = []
    for cid, label, unit in _CONDITIONS:
        observations.append({
            "id": cid,
            "label": label,
            "value": {
                "value": None, "unit": unit, "provenance": "OBSERVED",
                "mission": src and src["mission"], "instrument": src and src[cid],
                "source": "Falta el paso del pipeline que baje la última observación",
            },
            "when": None,
        })
    return {
        "site": site_id,
        "observations": observations,
        "alerts": [],
        "alerts_status": "missing",
        "note": "Todavía no se bajan las observaciones del rover ni las alertas de DONKI: "
                "los valores faltan y no se reemplazan por ejemplos.",
    }


# ---------------------------------------------------- /api/route/consumables

_DEFAULTS = SuitParams()
MAX_POINTS = 500
MAX_SAMPLES = 50_000


class RoutePoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360, description="Grados este, 0–360 o −180–180")
    elev_m: Optional[float] = Field(None, description="Si falta en todos los puntos, se lee del DTM")
    dwell_min: float = Field(0.0, ge=0, le=600, description="Tiempo que el astronauta se queda en este punto")


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


class ConsumablesRequest(BaseModel):
    site_id: Optional[str] = Field(None, description="Obligatorio si los puntos no traen elev_m")
    points: list[RoutePoint] = Field(min_length=2, max_length=MAX_POINTS)
    speed_m_s: float = Field(0.8, gt=0, le=3.0)
    cargo_kg: float = Field(_DEFAULTS.cargo_kg, ge=0, le=500, description="Carga extra transportada (M2)")
    sample_step_m: float = Field(10.0, ge=1.0, le=200.0, description="Paso de muestreo del DTM")
    suit: SuitOverrides = Field(default_factory=SuitOverrides)


def _dtm_path(site_id: str) -> Path:
    m = _manifest()
    if m is None or site_id not in m["sites"]:
        raise HTTPException(404, "Sitio desconocido o datos todavía no descargados")
    dtm = next((f for f in m["sites"][site_id]["files"] if f["key"] == "dtm" and f["status"] == "ok"), None)
    if dtm is None:
        raise HTTPException(503, f"El DTM de {site_id} no está disponible")
    return DATA_DIR / dtm["path"]


def _segments_from_request(req: ConsumablesRequest) -> tuple[list[list[Step]], list[float], str]:
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


@app.post("/api/route/consumables")
def route_consumables(req: ConsumablesRequest):
    """Consumibles del traje por tramo sobre una ruta ya armada (lista de puntos).
    Cada tramo va de points[i] a points[i+1]. Un punto intermedio puede traer `dwell_min`:
    la permanencia se suma al tramo que llega a ese punto, igual que en /api/route. En la
    salida y en la llegada final no cuenta. Todo el resultado es MODELED.

    Antes vivía en /api/route; se mudó para dejarle esa ruta al planificador 4D,
    cuyo contrato (docs/context.md §4) ya consume web/."""
    params = SuitParams(cargo_kg=req.cargo_kg, **req.suit.model_dump())
    segments, elev, elev_source = _segments_from_request(req)
    dwell_s = [p.dwell_min * 60.0 for p in req.points[1:-1]] + [0.0]
    result = route_consumption(segments, req.speed_m_s, params, dwell_s)
    for i, seg in enumerate(result["segments"]):
        a, b = req.points[i], req.points[i + 1]
        seg["from"] = {"lat": a.lat, "lon": a.lon, "elev_m": elev[i]}
        seg["to"] = {"lat": b.lat, "lon": b.lon, "elev_m": elev[i + 1]}
    result["elevation_source"] = elev_source
    result["profile"] = _profile(segments, elev)
    return result


def _profile(segments: list[list[Step]], vertex_elev: list[float],
             step_slopes: list[list[float | None]] | None = None) -> dict:
    """Perfil de elevación de la ruta: la serie que ya se muestreó, expuesta.

    `_segments_from_request` densifica cada tramo cada `sample_step_m` y lee el
    DTM en cada punto; hasta ahora esa serie se usaba para integrar el consumo y
    se descartaba. Devolverla no cuesta un muestreo más.

    Por muestra: distancia acumulada desde la salida, elevación y pendiente del
    sub-paso que termina ahí. La pendiente del primer punto es la del primer
    sub-paso, para que la serie tenga el mismo largo que las otras dos.

    `step_slopes` (lo pasa el planificador 4D): la pendiente de cada sub-paso tal
    como la juzga el veredicto, la máxima de la celda (`grid.peak`). Si viene, el
    perfil se colorea con ella y no con el desnivel entre muestras: un escalón de
    2 m a 30° dentro de una celda bloquea el paso, pero promediado entre muestras
    da 5° y se pintaba verde, y el gráfico contradecía al NO-GO. Sin ese dato
    (consumibles, o una celda sin pendiente), queda el desnivel entre muestras.
    """
    dist = [0.0]
    elev = [vertex_elev[0] if vertex_elev else 0.0]
    slope = []
    acumulada = 0.0
    for i, seg in enumerate(segments):
        pendientes = step_slopes[i] if step_slopes is not None else [None] * len(seg)
        for s, celda in zip(seg, pendientes):
            acumulada += s.dx_m
            dist.append(acumulada)
            elev.append(elev[-1] + s.dz_m)
            if celda is not None:
                slope.append(celda)
            else:
                slope.append(math.degrees(math.atan2(s.dz_m, s.dx_m)) if s.dx_m else 0.0)
    slope.insert(0, slope[0] if slope else 0.0)

    # Dónde empieza cada tramo dentro de la serie, para marcar las estaciones.
    cortes, k = [0], 0
    for seg in segments:
        k += len(seg)
        cortes.append(k)

    return {
        "distance_m": [round(d, 1) for d in dist],
        "elevation_m": [round(z, 2) for z in elev],
        "slope_deg": [round(s, 2) for s in slope],
        "leg_starts": cortes,
    }


# Distancia del muestreo con el que se estima la pendiente. La pendiente depende
# de sobre qué largo se mide: a 5 m da la rugosidad que le importa a quien camina,
# a 50 m daría la del terreno general. Va en el supuesto del badge.
SLOPE_BASELINE_M = 5.0


def _value(value, unit, provenance, *, mission=None, instrument=None,
           resolution=None, source=None, assumptions=None):
    """Valor con procedencia, el formato de docs/context.md §4. `value=None` = falta."""
    out = {"value": value, "unit": unit, "provenance": provenance,
           "mission": mission, "instrument": instrument}
    if resolution:
        out["resolution"] = resolution
    if source:
        out["source"] = source
    if assumptions:
        out["assumptions"] = assumptions
    return out


def _dtm_entry(site_id: str):
    """Entrada del DTM en el manifest, o None si todavía no está. No levanta:
    el inspector tiene que poder contestar aunque la descarga no haya terminado."""
    m = _manifest()
    if m is None or site_id not in m["sites"]:
        return None
    return next((f for f in m["sites"][site_id]["files"]
                 if f["key"] == "dtm" and f["status"] == "ok"), None)


def _slope_deg(dtm_path: Path, lat: float, lon: float) -> float:
    """Pendiente en grados por diferencias finitas sobre el DTM.

    Se muestrean cuatro vecinos a ±SLOPE_BASELINE_M en el terreno y se arma el
    gradiente. No usa `slope.tif` a propósito: así el inspector funciona con solo
    el DTM descargado, sin depender del precómputo. Puede diferir en unas décimas
    de la capa de pendiente del mapa, que se calcula con el método de Horn sobre
    toda la grilla; para eso está el supuesto en el badge.
    """
    dlat = math.degrees(SLOPE_BASELINE_M / MARS_RADIUS_M)
    coslat = max(math.cos(math.radians(lat)), 1e-6)
    dlon = dlat / coslat

    norte, sur, este, oeste = sample_dtm(
        dtm_path,
        [(lat + dlat, lon), (lat - dlat, lon), (lat, lon + dlon), (lat, lon - dlon)],
    )
    dz_dy = (norte - sur) / (2 * SLOPE_BASELINE_M)
    dz_dx = (este - oeste) / (2 * SLOPE_BASELINE_M)
    return math.degrees(math.atan(math.hypot(dz_dx, dz_dy)))


# Capas de refugio (pipeline/shelter.py) que el inspector muestrea en un punto:
# id de capa (web/src/map/layers.ts), etiqueta, unidad y decimales.
SHELTER_POINT_LAYERS = (
    ("survival-shelter-minutes", "Minutos al refugio", "min", 1),
    ("survival-shelter-strong-minutes", "Minutos al refugio fuerte", "min", 1),
    ("survival-shelter-skyview", "Cielo visible", "fracción", 3),
)


def _shelter_layers(site_id: str, lat: float, lon: float) -> list:
    """Minutos al refugio y cielo visible en el punto, de los COG de shelter.py.

    Lista vacía si el pipeline todavía no corrió; `value: null` si el punto cae
    fuera de la capa o en su nodata (p. ej. el borde del DTM, sin horizonte completo).
    """
    index_path = DATA_DIR / "output" / site_id / "shelter.json"
    try:
        index = json.loads(index_path.read_text())
    except (OSError, ValueError):
        return []
    out = []
    for layer_id, label, unit, decimals in SHELTER_POINT_LAYERS:
        layer = index.get("layers", {}).get(layer_id)
        if not layer or layer.get("status") != "ok":
            continue
        try:
            value = round(sample_dtm(index_path.parent / layer["file"], [(lat, lon)])[0], decimals)
        except TerrainError:
            value = None
        except (OSError, ValueError):
            continue
        out.append({"id": layer_id, "label": label, **_value(
            value, unit, layer.get("provenance", "DERIVED"),
            mission=layer.get("mission"), instrument=layer.get("instrument"),
            resolution=layer.get("resolution"), source=layer.get("method"),
            assumptions=layer.get("assumptions"))})
    return out


@app.get("/api/sites/{site_id}/point")
def point(site_id: str, lat: float, lon: float):
    """Qué hay en un punto: elevación y pendiente, cada una con su procedencia.

    Degrada en vez de romper. Si el DTM no está descargado, si el punto cae fuera
    del raster o si cae en nodata, devuelve `value: null` y una nota que explica
    por qué. Nunca estima un valor para llenar el hueco.
    """
    m = _manifest()
    if m is not None and site_id not in m["sites"]:
        raise HTTPException(404, f"No conozco el sitio '{site_id}'.")

    entry = _dtm_entry(site_id)
    meta = entry or {}
    px = (meta.get("raster") or {}).get("pixel_size")
    fuente = {
        "mission": meta.get("mission") or "MRO",
        "instrument": "HiRISE DTM",
        # La resolución sale del raster, no hardcodeada: Gale no es Jezero.
        "resolution": f"{abs(px):g} m/px" if px else None,
        "source": meta.get("desc"),
    }

    def vacio(nota):
        return {
            "site": site_id, "lat": lat, "lon": lon,
            "elevation": _value(None, "m", "OBSERVED", **fuente),
            "slope": _value(None, "°", "DERIVED", **fuente),
            "layers": [],
            "note": nota,
        }

    if entry is None:
        return vacio("El DTM de este sitio todavía no está descargado.")

    path = DATA_DIR / entry["path"]
    try:
        elev = sample_dtm(path, [(lat, lon)])[0]
    except TerrainError as e:
        return vacio(str(e))
    except (OSError, ValueError) as e:
        raise HTTPException(503, f"No se pudo leer el DTM: {e}")

    try:
        slope = _slope_deg(path, lat, lon)
    except TerrainError:
        # El punto está dentro pero algún vecino no: sin pendiente, con elevación.
        slope = None

    return {
        "site": site_id, "lat": lat, "lon": lon,
        "elevation": _value(round(elev, 2), "m", "OBSERVED", **fuente),
        "slope": _value(
            None if slope is None else round(slope, 2), "°", "DERIVED", **fuente,
            assumptions=[
                f"Diferencias finitas sobre el DTM a ±{SLOPE_BASELINE_M:g} m",
                "El valor depende de ese largo: a mayor distancia, pendiente más suave",
            ] + ([] if slope is not None else ["El punto está en el borde del DTM"]),
        ),
        # Refugio sale de pipeline/shelter.py. Peligro, dosis y sombras se suman acá
        # cuando el pipeline las precompute: se muestrean de su COG igual que la elevación.
        "layers": _shelter_layers(site_id, lat, lon),
    }


# ------------------------------------------------------- /api/sites/{site}/viewshed


@app.get("/api/sites/{site_id}/viewshed")
def viewshed(site_id: str, lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-360, le=360)):
    """Desde dónde hay línea de vista (contacto por radio) con un hábitat en (lat, lon).

    La misma geometría que el límite de minutos sin contacto de /api/route, en una
    grilla de ~25 m hasta 3 km del hábitat. Depende de dónde se pone el hábitat, por
    eso se calcula en el pedido y no en el pipeline (~0,5 s).

    Degrada: sin el DTM procesado o con el hábitat fuera del DTM responde 200 con
    `geojson: null` y una `note`. Nunca dibuja una zona que no se calculó.
    """
    m = _manifest()
    if m is None or site_id not in m["sites"]:
        raise HTTPException(404, "Sitio desconocido o datos todavía no descargados")
    base = {"site": site_id, "habitat": {"lat": lat, "lon": lon}, "geojson": None, "note": None}
    _, dtm_path, _ = terrain_inputs(DATA_DIR, site_id)
    if dtm_path is None:
        return {**base, "note": "Falta el DTM procesado del sitio (pipeline/precompute.py): "
                                "no se puede calcular la línea de vista al hábitat."}
    try:
        return {**base, **compute_viewshed(dtm_path, lat, lon)}
    except HabitatOutsideDtm as e:
        return {**base, "note": str(e)}
    except OSError as e:
        raise HTTPException(503, f"No se pudo leer el DTM: {e}")


# ------------------------------------------------------------------ /api/route


class PlannerWaypoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360, description="Grados este, 0–360 o −180–180")
    task: Optional[str] = Field(None, max_length=200)
    dwell_min: float = Field(0, ge=0, le=600)


# ---------------------------------------------------- ajustes del planificador
# Lo que el usuario puede tocar del algoritmo de /api/route: límites duros del
# veredicto, pesos del costo del A* y supuestos del traje. Los defaults salen de
# las dataclasses (safety.Limits, planner.CostWeights, SuitParams): acá solo van
# los rangos permitidos, la unidad y el texto para la UI. GET /api/route/params
# los publica para que web/ arme el formulario sin copiar ningún número.

_LIMITS = Limits()
_WEIGHTS = CostWeights()


def _knob(default: float, title: str, unit: str | None, step: float, help: str, **bounds):
    return Field(default, title=title, description=help,
                 json_schema_extra={"unit": unit, "step": step}, **bounds)


class LimitsSettings(BaseModel):
    """Límites duros: si uno se rompe, la ruta es NO-GO.

    La pendiente máxima no está acá a propósito: es el corte único de 25° (docs/context.md
    §5) que comparten el A*, la clase del tramo (planner.SLOPE_CUTS), la leyenda, los tiles
    de pendiente y peligro y los refugios. Si el usuario la moviera, el veredicto y el mapa
    dirían cosas distintas. Mandarla en `params` es 422 (extra="forbid").
    """
    model_config = ConfigDict(extra="forbid", title="Límites del veredicto")
    reserve_fraction: float = _knob(_LIMITS.reserve_fraction, "Reserva al volver", "fracción", 0.05,
                                    "O2 y batería que tienen que sobrar al terminar (0,2 = 20 %).", ge=0, le=0.9)
    sunset_margin_min: float = _knob(_LIMITS.sunset_margin_min, "Margen antes del atardecer", "min", 5,
                                     "Volver al menos esto antes de que se ponga el Sol.", ge=0, le=240)
    max_no_contact_min: float = _knob(_LIMITS.max_no_contact_min, "Máximo sin contacto", "min", 1,
                                      "Minutos seguidos sin línea de vista al hábitat.", ge=0, le=600)
    dose_budget_msv: float = _knob(_LIMITS.dose_budget_msv, "Presupuesto de dosis", "mSv", 0.05,
                                   "Dosis de radiación máxima por EVA.", gt=0, le=50)


class WeightsSettings(BaseModel):
    """Pesos del costo del A*: cuánto evita la ruta cada cosa. 0 = no le importa."""
    model_config = ConfigDict(extra="forbid", title="Pesos de la ruta")
    slope: float = _knob(_WEIGHTS.slope, "Evitar pendiente", None, 0.5,
                         "Cuánto prefiere la ruta el terreno plano.", ge=0, le=20)
    shadow: float = _knob(_WEIGHTS.shadow, "Evitar sombra", None, 0.5,
                          "Cuánto evita la sombra (frío) a la hora de paso.", ge=0, le=20)
    contact: float = _knob(_WEIGHTS.contact, "Mantener contacto", None, 0.5,
                           "Cuánto prefiere quedar a la vista del hábitat.", ge=0, le=20)


class SuitSettings(BaseModel):
    """Supuestos del traje (EMU de la ISS por defecto). La carga no va acá: es `cargo_kg`."""
    model_config = ConfigDict(extra="forbid", title="Traje")
    astronaut_kg: float = _knob(_DEFAULTS.astronaut_kg, "Astronauta", "kg", 1, "Masa sin traje.", gt=0, le=300)
    suit_kg: float = _knob(_DEFAULTS.suit_kg, "Traje", "kg", 1, "EMU completo con mochila (PLSS).", ge=0, le=500)
    terrain_factor: float = _knob(_DEFAULTS.terrain_factor, "Factor de terreno", None, 0.1,
                                  "η de Pandolf: 1 = pavimento, 1,1 = regolito compacto, más = suelto.",
                                  ge=1.0, le=3.0)
    o2_capacity_kg: float = _knob(_DEFAULTS.o2_capacity_kg, "Capacidad de O2", "kg", 0.01,
                                  "O2 primario de la mochila.", gt=0, le=5)
    o2_leak_kg_per_h: float = _knob(_DEFAULTS.o2_leak_kg_per_h, "Fuga de O2", "kg/h", 0.001,
                                    "Pérdida del traje.", ge=0, le=1)
    battery_capacity_wh: float = _knob(_DEFAULTS.battery_capacity_wh, "Batería", "Wh", 10,
                                       "Energía nominal.", gt=0, le=5000)
    battery_efficiency: float = _knob(_DEFAULTS.battery_efficiency, "Eficiencia de batería", "fracción", 0.05,
                                      "Parte de la energía nominal que llega a la carga.", gt=0, le=1)
    base_power_w: float = _knob(_DEFAULTS.base_power_w, "Consumo base", "W", 5,
                                "Ventilador, bomba, radio y electrónica.", ge=0, le=500)


class PlannerParams(BaseModel):
    """Ajustes opcionales de POST /api/route. Lo que no se manda queda en su default."""
    model_config = ConfigDict(extra="forbid")
    limits: LimitsSettings = Field(default_factory=LimitsSettings)
    weights: WeightsSettings = Field(default_factory=WeightsSettings)
    suit: SuitSettings = Field(default_factory=SuitSettings)

    def changed(self) -> list[str]:
        """Qué se apartó del default, en palabras: va en el resumen del veredicto."""
        out = []
        for group in (self.limits, self.weights, self.suit):
            for name, f in type(group).model_fields.items():
                v = getattr(group, name)
                if v != f.default:
                    unit = (f.json_schema_extra or {}).get("unit")
                    out.append(f"{f.title} {v:g}{' ' + unit if unit and unit != 'fracción' else ''}")
        return out


class PlannerRequest(BaseModel):
    """Contrato de docs/context.md §4 (RouteRequest en web/src/api/schemas.ts)."""
    site: str = Field(min_length=1, max_length=64)
    depart_utc: str = Field(description="ISO 8601 en UTC, por ejemplo 2026-11-15T12:00:00.000Z")
    waypoints: list[PlannerWaypoint] = Field(min_length=2, max_length=20)
    cargo_kg: float = Field(_DEFAULTS.cargo_kg, ge=0, le=500,
                            description="Equipo que se lleva encima además del traje (kg, masa en la Tierra)")
    params: Optional[PlannerParams] = Field(None, description="Ajustes del algoritmo; sin esto, los defaults")

    @model_validator(mode="before")
    @classmethod
    def _contrato_viejo(cls, data):
        if isinstance(data, dict) and "points" in data and "waypoints" not in data:
            raise ValueError("Ese es el contrato de consumibles: usá POST /api/route/consumables")
        return data


def _settings_group(model: type[BaseModel], gid: str) -> dict:
    fields = []
    for name, f in model.model_fields.items():
        bounds = {}
        for m in f.metadata:
            for k in ("ge", "gt", "le", "lt"):
                if getattr(m, k, None) is not None:
                    bounds[k] = getattr(m, k)
        extra = f.json_schema_extra or {}
        fields.append({"id": name, "label": f.title, "help": f.description, "unit": extra.get("unit"),
                       "step": extra.get("step"), "default": f.default,
                       "min": bounds.get("ge", bounds.get("gt")), "max": bounds.get("le", bounds.get("lt"))})
    return {"id": gid, "label": model.model_config.get("title"), "fields": fields}


@app.get("/api/route/params")
def route_params():
    """Qué se puede ajustar del planificador, con default, rango y unidad.

    No lee datos: responde aunque la descarga no haya terminado. Los valores
    son del equipo y del EMU de la ISS; ver docs/seguridad.md.
    """
    return {"groups": [_settings_group(LimitsSettings, "limits"),
                       _settings_group(WeightsSettings, "weights"),
                       _settings_group(SuitSettings, "suit")]}


@app.post("/api/route")
def route(req: PlannerRequest):
    """Planificador 4D: A* sobre la pendiente del sitio con costo según la hora de
    llegada a cada celda (sombra de la pila precomputada). Modelo en api/planner.py.

    Sitio desconocido o sin manifest: 404, y web/ pasa al planificador de ejemplo.
    Con datos a medias responde igual: los tramos sin terreno van en línea recta
    como `unknown` y el veredicto dice qué no se evaluó.
    """
    m = _manifest()
    if m is None or req.site not in m["sites"]:
        raise HTTPException(404, "Sitio desconocido o datos todavía no descargados")
    try:
        parse_utc(req.depart_utc)
    except ValueError:
        raise HTTPException(422, "depart_utc tiene que ser una fecha ISO 8601, por ejemplo 2026-11-15T12:00:00Z")
    try:
        # La carga va aparte (cargo_kg, el selector de equipo); el resto del traje, en params.
        suit = req.params.suit.model_dump() if req.params is not None else {}
        kw = {}
        if req.params is not None:
            kw = {
                "weights": CostWeights(**req.params.weights.model_dump()),
                "limits": Limits(**req.params.limits.model_dump()),
                "custom": req.params.changed(),
            }
        out = plan_route(req.site, req.depart_utc, [w.model_dump() for w in req.waypoints], DATA_DIR, REPO_DIR,
                         params=SuitParams(cargo_kg=req.cargo_kg, **suit), **kw)
    except OSError as e:
        raise HTTPException(503, f"No se pudo leer un raster del sitio: {e}")
    inputs = out.pop("_profile_inputs", None)
    straight = out.pop("_profile_straight_legs", [])
    if inputs is not None:
        out["profile"] = _profile(*inputs)
        # Tramos sin camino: el perfil muestra la línea recta A→B medida, no una ruta.
        out["profile"]["straight_legs"] = straight
    return out


# ------------------------------------------------------- /api/illumination/window


class IlluminationPoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360)


class IlluminationWindowRequest(BaseModel):
    site_id: str = Field(min_length=1, max_length=64)
    sol_tag: Optional[str] = Field(None, pattern=r"^\d{8}T\d{4}Z$",
                                   description="Carpeta del sol, por ejemplo 20261115T0649Z; si falta, el último")
    ltst: Optional[str] = Field(None, description="Hora solar local HH:MM, múltiplo del paso de la pila")
    band: Optional[int] = Field(None, ge=1, description="Banda del GeoTIFF, en lugar de ltst")
    p1: IlluminationPoint
    p2: IlluminationPoint


@app.post("/api/illumination/window")
def illumination_window(req: IlluminationWindowRequest):
    """Sol/sombra precomputados en el rectángulo entre dos puntos, para una hora.

    Solo lee la pila que escribe pipeline/illumination.py. Celdas: true al sol,
    false en sombra, null sin dato. El tamaño de celda sale de la grilla real.
    """
    if (req.ltst is None) == (req.band is None):
        raise HTTPException(422, "Mandá ltst o band (uno de los dos)")
    m = _manifest()
    if m is None or req.site_id not in m["sites"]:
        raise HTTPException(404, "Sitio desconocido o datos todavía no descargados")
    try:
        stack = stack_for_tag(DATA_DIR, req.site_id, req.sol_tag)
    except IlluminationNotReady as e:
        raise HTTPException(503, str(e))
    try:
        band = req.band if req.band is not None else stack.band_for_ltst(req.ltst)
        return read_window(stack, band, (req.p1.lat, req.p1.lon), (req.p2.lat, req.p2.lon))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except OSError as e:
        raise HTTPException(503, f"No se pudo leer la pila de sombras: {e}")
