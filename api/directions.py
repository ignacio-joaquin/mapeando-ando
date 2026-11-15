"""Indicaciones por landmarks para cada tramo de POST /api/route (`legs[].directions`).

En Marte no hay GPS ni brújula magnética: un astronauta se orienta con lo que ve. Para cada
tramo ya resuelto por el planificador:

1. Se parte la polilínea del A* en *trechos* casi rectos: un giro de más de TURN_DEG es un corte.
2. Candidatos: los lugares de `places.json` (pipeline/places.py) que se pueden ver de lejos:
   cráteres (IAU y Robbins ≥ 1 km), rasgos en relieve con nombre IAU (montes, domos, colinas,
   mesas) y cerros sin nombre que places.py saca del DTM (`kind: landmark`). Los waypoints del
   rover, tubos, objetivos científicos, hondonadas y huellas CRISM no se ven desde lejos: no entran.
3. Línea de vista desde la altura de los ojos (EYE_M) cada SAMPLE_STEP_M del trecho hasta el
   punto que se mira: el borde del cráter que da hacia el caminante (o el borde hacia donde se
   camina si se está adentro) o la cima del rasgo. Terreno: DTM de 1 m promediado cerca y DEM
   MOLA-HRSC de 200 m lejos, con la curvatura de Marte.
4. Puntaje del candidato por trecho = fracción visible × tamaño aparente × estabilidad del
   rumbo relativo (penaliza si se mueve más de STABILITY_DEG). Gana el mejor si se ve en al
   menos MIN_VISIBLE del trecho.
5. Texto según dónde queda: al frente, al costado, atrás, o un giro al empezar el trecho.
   Si nada se ve, el respaldo por rumbo, marcado como tal. Nunca se inventa un landmark.

Todo es geometría sobre datos que ya están en disco (DERIVED). Solo lee: nunca corre el pipeline.
Degradar, no romper: sin places.json o sin terreno, cada trecho va con el respaldo y lo dice.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from .terrain import MARS_LONGLAT, MARS_RADIUS_M, _norm_lon

EYE_M = 1.7               # altura de los ojos sobre el suelo
SAMPLE_STEP_M = 50.0      # observadores a lo largo del trecho
MAX_OBSERVERS = 24        # tope de observadores por trecho
RAY_SAMPLES = 96          # muestras de terreno por línea de vista
SIMPLIFY_M = 25.0         # tolerancia para enderezar el zigzag de las celdas del A*
TURN_DEG = 30.0           # un cambio de rumbo mayor es un giro: empieza otro trecho
MIN_STRETCH_M = 80.0      # un trecho más corto se une al anterior
MIN_VISIBLE = 0.5         # fracción mínima del trecho desde la que se ve el landmark
MIN_ANGULAR_DEG = 0.5     # tamaño aparente mínimo para contarlo como visible
STABILITY_DEG = 20.0      # desvío del rumbo relativo que empieza a penalizar
ALIKE_DEG = 15.0          # dos candidatos hacia el mismo lado (±) se pueden confundir
SUN_MIN_EL = 3.0          # más bajo, el Sol se confunde con el horizonte (o ya no está)
SUN_MAX_EL = 65.0         # más alto, la sombra es corta y el Sol no marca dirección
STOP_SIDE_DEG = (60.0, 120.0)   # la señal de parada queda al costado al final del trecho
HABITAT_WEIGHT_DEG = 30.0 # peso del mástil del hábitat frente al tamaño aparente de los rasgos
PROMINENCE_CAP_DEG = 20.0 # tope del tamaño aparente en el puntaje
FRONT_DEG = 15.0
SIDE_DEG = (60.0, 120.0)
MAX_RANGE_M = 40_000.0    # más allá, ni el borde de Jezero sirve de referencia
MAX_CANDIDATES = 25       # candidatos con línea de vista completa por trecho
MIN_CRATER_KM = 1.0       # el catálogo de Robbins es completo desde 1 km
NEAR_MARGIN_M = 6_000.0   # ventana del DTM alrededor de la ruta
FAR_MARGIN_M = MAX_RANGE_M
NEAR_CELL_M = 10.0        # el DTM se promedia a esto (o más, para no pasar de MAX_SIDE)
MAX_SIDE = 1500

LANDMARK_KINDS = ("iau", "crater", "landmark")
HILL_RADIUS_M = 500.0     # = LANDMARK_RADIUS_M de pipeline/places.py: el cerro es el más alto en ese radio
# Tipo de rasgo IAU (primera palabra del `detail` de places.json) -> cómo se nombra y se mira.
IAU_FEATURES: dict[str, tuple[str, str]] = {
    "crater": ("crater", "el cráter {name}"),
    "craters": ("crater", "el cráter {name}"),
    "mons": ("peak", "el monte {name}"),
    "montes": ("peak", "los montes {name}"),
    "tholus": ("peak", "el domo {name}"),
    "tholi": ("peak", "los domos {name}"),
    "collis": ("peak", "la colina {name}"),
    "colles": ("peak", "las colinas {name}"),
    "mensa": ("peak", "la mesa {name}"),
    "mensae": ("peak", "las mesas {name}"),
}
SIDES = ("norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste")
COMPASS = ("N", "NE", "E", "SE", "S", "SO", "O", "NO")


# ------------------------------------------------------------------ geometría


def haversine(lat1, lon1, lat2, lon2):
    """Distancia sobre la esfera de Marte (m). Acepta escalares o arrays."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * MARS_RADIUS_M * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def bearing(lat1, lon1, lat2, lon2):
    """Rumbo inicial 0–360° (0 = norte, 90 = este)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    y = np.sin(dl) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return np.degrees(np.arctan2(y, x)) % 360.0


def destination(lat, lon, brg_deg, dist_m):
    """Punto a `dist_m` de (lat, lon) con rumbo `brg_deg`."""
    p1, l1 = np.radians(lat), np.radians(lon)
    b, d = np.radians(brg_deg), np.asarray(dist_m) / MARS_RADIUS_M
    p2 = np.arcsin(np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(b))
    l2 = l1 + np.arctan2(np.sin(b) * np.sin(d) * np.cos(p1), np.cos(d) - np.sin(p1) * np.sin(p2))
    return np.degrees(p2), np.degrees(l2)


def wrap180(deg):
    return (np.asarray(deg) + 180.0) % 360.0 - 180.0


def compass(deg: float) -> str:
    return COMPASS[int(round(deg / 45.0)) % 8]


def side_name(deg: float) -> str:
    return SIDES[int(round(deg / 45.0)) % 8]


def fmt_distance(m: float) -> str:
    """350 m, 1,2 km: como se lee en voz alta."""
    if m < 1000:
        return f"{int(round(m / 10.0) * 10)} m"
    return f"{m / 1000:.1f} km".replace(".", ",")


# ------------------------------------------------------------------ terreno


class Field:
    """Elevación en una grilla regular lat/lon (planetocéntrica, este positivo). NaN = sin dato."""

    def __init__(self, z: np.ndarray, lat_max: float, lon_min: float, dlat: float, dlon: float,
                 label: str, cell_m: float):
        self.z = z
        self.lat_max, self.lon_min, self.dlat, self.dlon = lat_max, lon_min, dlat, dlon
        self.label = label
        self.cell_m = cell_m

    def at(self, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
        r = np.floor((self.lat_max - lats) / self.dlat).astype(np.intp)
        c = np.floor((_wrap_lon(lons) - self.lon_min) / self.dlon).astype(np.intp)
        h, w = self.z.shape
        inside = (r >= 0) & (r < h) & (c >= 0) & (c < w)
        out = np.full(np.shape(lats), np.nan)
        out[inside] = self.z[r[inside], c[inside]]
        return out

    @classmethod
    def from_raster(cls, path: Path, lat_min: float, lat_max: float, lon_min: float, lon_max: float,
                    cell_m: float, label: str) -> "Field | None":
        """Lee la ventana del raster que cubre el rectángulo (promediada con las overviews del
        COG) y la pasa a una grilla lat/lon, para que después todo sea indexar arrays."""
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.transform import from_origin
        from rasterio.warp import reproject, transform_bounds
        from rasterio.windows import from_bounds

        with rasterio.open(path) as ds:
            left, bottom, right, top = transform_bounds(MARS_LONGLAT, ds.crs, lon_min, lat_min, lon_max, lat_max,
                                                        densify_pts=21)
            win = from_bounds(left, bottom, right, top, ds.transform).round_offsets().round_lengths()
            win = win.intersection(rasterio.windows.Window(0, 0, ds.width, ds.height))
            if win.width <= 0 or win.height <= 0:
                return None
            unit_m = 1.0 if ds.crs and ds.crs.is_projected else math.pi / 180 * MARS_RADIUS_M
            px_m = abs(ds.transform.a) * unit_m
            f = max(1, int(cell_m // px_m), math.ceil(max(win.width, win.height) / MAX_SIDE))
            oh, ow = max(1, int(win.height // f)), max(1, int(win.width // f))
            src = ds.read(1, window=win, out_shape=(oh, ow), resampling=Resampling.average, masked=True)
            src = np.ma.filled(src.astype(np.float64), np.nan)
            if ds.nodata is not None:
                src[np.isclose(src, ds.nodata)] = np.nan
            src_t = ds.window_transform(win) * rasterio.Affine.scale(win.width / ow, win.height / oh)
            src_crs = ds.crs
        cell_deg = px_m * f / (math.pi / 180 * MARS_RADIUS_M)
        coslat = max(math.cos(math.radians((lat_min + lat_max) / 2)), 0.1)
        dlat, dlon = cell_deg, cell_deg / coslat
        h = max(1, min(MAX_SIDE, math.ceil((lat_max - lat_min) / dlat)))
        w = max(1, min(MAX_SIDE, math.ceil((lon_max - lon_min) / dlon)))
        dlat, dlon = (lat_max - lat_min) / h, (lon_max - lon_min) / w
        dst = np.full((h, w), np.nan)
        reproject(src, dst, src_transform=src_t, src_crs=src_crs, src_nodata=np.nan,
                  dst_transform=from_origin(lon_min, lat_max, dlon, dlat), dst_crs=MARS_LONGLAT,
                  dst_nodata=np.nan, resampling=Resampling.bilinear)
        if not np.isfinite(dst).any():
            return None
        return cls(dst, lat_max, lon_min, dlat, dlon, label, px_m * f)


def _wrap_lon(lon):
    return (np.asarray(lon, dtype=np.float64) + 180.0) % 360.0 - 180.0


class Terrain:
    """Elevación combinada: el primer campo con dato gana (DTM cerca, DEM lejos)."""

    def __init__(self, fields: Sequence[Field]):
        self.fields = [f for f in fields if f is not None]

    def __bool__(self) -> bool:
        return bool(self.fields)

    def z(self, lats, lons) -> np.ndarray:
        lats = np.asarray(lats, dtype=np.float64)
        lons = np.asarray(lons, dtype=np.float64)
        out = np.full(lats.shape, np.nan)
        for f in self.fields:
            miss = ~np.isfinite(out)
            if not miss.any():
                break
            out[miss] = f.at(lats[miss], lons[miss])
        return out

    @property
    def resolution(self) -> str:
        return " + ".join(f"{f.label} promediado a {f.cell_m:.0f} m" for f in self.fields)


# ------------------------------------------------------------------ landmarks


@dataclass(frozen=True)
class Landmark:
    id: str
    name: str
    catalog: str          # IAU | Robbins | DEM (contrato)
    lat: float
    lon: float
    radius_m: float
    shape: str            # crater | peak
    label: str            # cómo se nombra en el texto, con artículo


_KM = re.compile(r"(\d+(?:[.,]\d+)?)\s*km")


def _size_km(place: dict) -> float | None:
    """El diámetro: `size_km` si places.json algún día lo trae; si no, el número del `detail`
    ("Cráter de 1,23 km", "Crater, craters · 49,0 km"), que lo escribe places.py."""
    v = place.get("size_km")
    if isinstance(v, (int, float)) and v > 0:
        return float(v)
    m = _KM.search(place.get("detail") or "")
    return float(m.group(1).replace(",", ".")) if m else None


def landmarks_from_places(places: Sequence[dict]) -> list[Landmark]:
    out: list[Landmark] = []
    for p in places:
        kind = p.get("kind")
        if kind not in LANDMARK_KINDS:
            continue
        if kind == "landmark":
            # Cerro sin nombre del DTM: se mira su cima. "Cerro sin nombre 3" -> "el cerro sin nombre 3".
            name = str(p["name"])
            out.append(Landmark(p["id"], name, "DEM", float(p["lat"]), float(p["lon"]), HILL_RADIUS_M, "peak",
                                "el " + name[:1].lower() + name[1:]))
            continue
        size = _size_km(p)
        if kind == "crater":
            if size is None or size < MIN_CRATER_KM:
                continue
            cid = str(p["name"]).replace("Cráter ", "")
            size_txt = f"{size:.1f}".replace(".", ",")
            out.append(Landmark(p["id"], p["name"], "Robbins", float(p["lat"]), float(p["lon"]),
                                size * 500.0, "crater", f"el cráter sin nombre de {size_txt} km (Robbins {cid})"))
            continue
        ftype = (p.get("feature_type") or (p.get("detail") or "").split("·")[0]).split(",")[0].strip().lower()
        spec = IAU_FEATURES.get(ftype)
        if spec is None:
            continue   # valles, llanuras, fosas: no son un punto hacia donde caminar
        shape, label = spec
        if shape == "crater" and not size:
            continue
        radius = (size or 1.0) * 500.0
        out.append(Landmark(p["id"], p["name"], "IAU", float(p["lat"]), float(p["lon"]), radius, shape,
                            label.format(name=p["name"])))
    return out


def load_landmarks(places_path: Path) -> list[Landmark] | None:
    """None = no hay índice de lugares (el pipeline no corrió places.py para el sitio)."""
    try:
        data = json.loads(Path(places_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return landmarks_from_places(data.get("places") or [])


# ------------------------------------------------------------------ trechos


@dataclass
class Stretch:
    i0: int               # índice en la polilínea del tramo
    i1: int
    start_m: float        # distancia desde el inicio del tramo
    length_m: float
    heading: float        # rumbo del inicio al final del trecho
    turn_deg: float = 0.0  # giro respecto del trecho anterior (+ = derecha)


def _cumdist(latlon: Sequence[tuple[float, float]]) -> np.ndarray:
    lat = np.array([p[0] for p in latlon])
    lon = np.array([p[1] for p in latlon])
    d = haversine(lat[:-1], lon[:-1], lat[1:], lon[1:]) if len(latlon) > 1 else np.zeros(0)
    return np.concatenate([[0.0], np.cumsum(d)])


def _simplify(latlon: Sequence[tuple[float, float]], tol_m: float) -> list[int]:
    """Douglas-Peucker en metros locales: índices de los vértices que quedan."""
    n = len(latlon)
    if n <= 2:
        return list(range(n))
    lat0 = latlon[0][0]
    k = math.pi / 180 * MARS_RADIUS_M
    xy = np.array([((lo - latlon[0][1]) * k * math.cos(math.radians(lat0)), (la - lat0) * k) for la, lo in latlon])
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = xy[a], xy[b]
        seg = q - p
        L = float(np.hypot(*seg))
        pts = xy[a + 1:b]
        if L == 0:
            dist = np.hypot(*(pts - p).T)
        else:
            dist = np.abs(seg[0] * (pts[:, 1] - p[1]) - seg[1] * (pts[:, 0] - p[0])) / L
        j = int(np.argmax(dist))
        if dist[j] > tol_m:
            m = a + 1 + j
            keep[m] = True
            stack += [(a, m), (m, b)]
    return [int(i) for i in np.flatnonzero(keep)]


def stretches(latlon: Sequence[tuple[float, float]]) -> list[Stretch]:
    """Trechos casi rectos del tramo. Un giro de más de TURN_DEG empieza un trecho nuevo."""
    cum = _cumdist(latlon)
    idx = _simplify(latlon, SIMPLIFY_M)

    def hdg(i, j):
        return float(bearing(latlon[i][0], latlon[i][1], latlon[j][0], latlon[j][1]))

    cuts = [idx[0]]
    for k in range(1, len(idx) - 1):
        prev, here, nxt = cuts[-1], idx[k], idx[k + 1]
        if cum[here] - cum[prev] < 1e-6:
            continue
        if abs(float(wrap180(hdg(here, nxt) - hdg(prev, here)))) > TURN_DEG:
            cuts.append(here)
    cuts.append(idx[-1])
    # Trechos muy cortos se unen al anterior (o al siguiente si es el primero).
    merged = [cuts[0]]
    for c in cuts[1:-1]:
        if cum[c] - cum[merged[-1]] >= MIN_STRETCH_M:
            merged.append(c)
    if len(merged) > 1 and cum[cuts[-1]] - cum[merged[-1]] < MIN_STRETCH_M:
        merged.pop()
    merged.append(cuts[-1])

    out: list[Stretch] = []
    for a, b in zip(merged[:-1], merged[1:]):
        out.append(Stretch(a, b, float(cum[a]), float(cum[b] - cum[a]), hdg(a, b)))
    for k in range(1, len(out)):
        out[k].turn_deg = float(wrap180(out[k].heading - out[k - 1].heading))
    return out


def observers(latlon: Sequence[tuple[float, float]], s: Stretch) -> tuple[np.ndarray, np.ndarray]:
    """Puntos del trecho cada SAMPLE_STEP_M sobre la polilínea (con tope), sin los extremos exactos."""
    cum = _cumdist(latlon)
    n = int(min(MAX_OBSERVERS, max(2, math.ceil(s.length_m / SAMPLE_STEP_M))))
    at = s.start_m + s.length_m * (np.arange(n) + 0.5) / n
    lat = np.array([p[0] for p in latlon])
    lon = np.array([p[1] for p in latlon])
    return np.interp(at, cum, lat), np.interp(at, cum, lon)


# ------------------------------------------------------------------ visibilidad


@dataclass
class Sighting:
    landmark: Landmark
    target_lat: float
    target_lon: float
    side: str | None              # "oeste" si se mira un borde desde adentro del cráter
    visible: np.ndarray           # por observador
    rel_bearing: np.ndarray       # por observador, grados (+ = derecha)
    angular_deg: np.ndarray       # tamaño aparente por observador
    unknown: int = 0              # observadores sin dato de terreno en la línea de vista
    distance_m: float = 0.0       # distancia mediana al punto que se mira
    elev_deg: float = 0.0         # altura aparente mediana sobre los ojos
    score: float = 0.0
    fraction: float = 0.0
    stability: float = 0.0
    prominence: float = 0.0       # tamaño aparente mediano cuando se ve (grados)
    alike: list = field(default_factory=list)   # otros candidatos parecidos en la misma dirección

    @property
    def median_rel(self) -> float:
        v = self.rel_bearing[self.visible]
        return float(np.median(v)) if v.size else float(np.median(self.rel_bearing))


def line_of_sight(terrain: Terrain, olat, olon, oz, tlat, tlon, tz) -> np.ndarray:
    """1 = se ve, 0 = tapado, -1 = sin dato. Observador a altura `oz` (ya con los ojos) y
    objetivo a `tz`, uno por fila. Descuenta la curvatura de Marte (abultamiento d1·d2/2R)."""
    olat, olon, oz = map(np.atleast_1d, (olat, olon, oz))
    tlat, tlon, tz = map(np.atleast_1d, (tlat, tlon, tz))
    d = haversine(olat, olon, tlat, tlon)
    f = np.linspace(0.0, 0.97, RAY_SAMPLES + 1)[1:][None, :]   # sin el último 3 %: el propio borde
    dlon = wrap180(tlon - olon)
    slat = olat[:, None] + (tlat - olat)[:, None] * f
    slon = olon[:, None] + dlon[:, None] * f
    zs = terrain.z(slat, slon)
    d1 = d[:, None] * f
    bulge = d1 * (d[:, None] - d1) / (2 * MARS_RADIUS_M)
    ray = oz[:, None] + (tz - oz)[:, None] * f
    blocked = np.any(zs + bulge > ray, axis=1)
    unknown = np.any(~np.isfinite(zs), axis=1) | ~np.isfinite(oz) | ~np.isfinite(tz)
    out = np.where(blocked, 0, 1).astype(np.int8)
    out[unknown & ~blocked] = -1
    out[~np.isfinite(oz) | ~np.isfinite(tz)] = -1
    return out


def sight(terrain: Terrain, lm: Landmark, olat: np.ndarray, olon: np.ndarray, oz: np.ndarray,
          heading: float) -> Sighting | None:
    """Qué tan bien se ve `lm` desde los observadores de un trecho."""
    mid = len(olat) // 2
    d_center = haversine(olat, olon, lm.lat, lm.lon)
    inside = lm.shape == "crater" and float(d_center[mid]) < lm.radius_m * 0.95
    side = None
    rim_top = float("nan")
    if lm.shape == "crater" and not inside:
        # El borde que da hacia el caminante: lo que asoma sobre el horizonte.
        b = bearing(lm.lat, lm.lon, olat, olon)
        tlat, tlon = destination(lm.lat, lm.lon, b, lm.radius_m)
        aim_lat, aim_lon = np.full_like(olat, lm.lat), np.full_like(olon, lm.lon)
    elif inside:
        # Adentro del cráter: el tramo de borde hacia donde se camina, si se ve.
        angles = np.arange(0.0, 360.0, 22.5)
        rl, rn = destination(lm.lat, lm.lon, angles, lm.radius_m)
        rz = _rim_z(terrain, lm, angles)
        vis = line_of_sight(terrain, np.full(angles.shape, olat[mid]), np.full(angles.shape, olon[mid]),
                            np.full(angles.shape, oz[mid]), rl, rn, rz)
        rel = np.abs(wrap180(bearing(olat[mid], olon[mid], rl, rn) - heading))
        cand = np.flatnonzero(vis == 1)
        if cand.size == 0:
            return None
        k = int(cand[np.argmin(rel[cand])])
        side = side_name(float(angles[k]))
        rim_top = float(rz[k])
        tlat, tlon = np.full_like(olat, rl[k]), np.full_like(olon, rn[k])
        aim_lat, aim_lon = tlat, tlon
    else:
        tlat, tlon = np.full_like(olat, lm.lat), np.full_like(olon, lm.lon)
        aim_lat, aim_lon = tlat, tlon

    if lm.shape == "peak":
        tz = np.full_like(olat, _peak_z(terrain, lm))
    elif inside:
        tz = np.full_like(olat, rim_top)
    else:
        tz = _rim_band_max(terrain, tlat, tlon, lm)
    tz = tz + 2.0   # lo que asoma es lo más alto del rasgo, no el suelo a sus pies

    vis = line_of_sight(terrain, olat, olon, oz, tlat, tlon, tz)
    d_aim = haversine(olat, olon, aim_lat, aim_lon)
    d_t = haversine(olat, olon, tlat, tlon)
    elev = np.degrees(np.arctan2(tz - oz, np.maximum(d_t, 1.0)))
    width = 2 * np.degrees(np.arctan2(lm.radius_m, np.maximum(d_aim, 1.0))) if (lm.shape == "crater" and not inside) \
        else np.zeros_like(olat)
    angular = np.fmax(elev, width)
    seen = (vis == 1) & (angular >= MIN_ANGULAR_DEG)
    rel = wrap180(bearing(olat, olon, aim_lat, aim_lon) - heading)
    ref = seen if seen.any() else np.ones_like(seen)
    return Sighting(lm, float(aim_lat[mid]), float(aim_lon[mid]), side, seen, rel, angular,
                    unknown=int(np.sum(vis < 0)), distance_m=float(np.median(d_aim[ref])),
                    elev_deg=float(np.median(elev[ref])))


def _rim_band_max(terrain: Terrain, tlat, tlon, lm: Landmark) -> np.ndarray:
    """Cresta del borde que da hacia cada observador (ver _rim_z)."""
    return _rim_z(terrain, lm, bearing(lm.lat, lm.lon, tlat, tlon))


def _rim_z(terrain: Terrain, lm: Landmark, angles: np.ndarray) -> np.ndarray:
    """Cresta del borde: el máximo del terreno en una franja ±10 % del radio, por ángulo.
    NaN donde no hay dato en toda la franja."""
    rs = lm.radius_m * np.array([0.9, 0.95, 1.0, 1.05, 1.1])
    pl, pn = destination(lm.lat, lm.lon, angles[:, None], rs[None, :])
    z = terrain.z(pl, pn)
    z = np.where(np.isfinite(z), z, -np.inf)
    out = z.max(axis=1)
    return np.where(np.isfinite(out), out, np.nan)


def _peak_z(terrain: Terrain, lm: Landmark) -> float:
    r = min(lm.radius_m, 1000.0)
    angles = np.arange(0.0, 360.0, 45.0)
    pl, pn = destination(lm.lat, lm.lon, angles[:, None], np.array([0.0, r / 2, r])[None, :])
    z = terrain.z(pl, pn)
    return float(np.nanmax(z)) if np.isfinite(z).any() else float("nan")


def _circ_spread(deg: np.ndarray) -> float:
    """Desvío circular (grados) de un conjunto de rumbos."""
    if deg.size < 2:
        return 0.0
    a = np.radians(deg)
    r = math.hypot(float(np.mean(np.cos(a))), float(np.mean(np.sin(a))))
    return float(np.degrees(math.sqrt(max(0.0, -2 * math.log(max(r, 1e-9))))))


def score(s: Sighting) -> Sighting:
    n = s.visible.size
    s.fraction = float(np.sum(s.visible)) / n if n else 0.0
    if not s.visible.any():
        s.score = 0.0
        return s
    spread = _circ_spread(s.rel_bearing[s.visible])
    s.stability = 1.0 if spread <= STABILITY_DEG else STABILITY_DEG / spread
    # Más de PROMINENCE_CAP_DEG ya es "enorme": un cráter grande y cerca no tiene que ganarle
    # por ancho a una referencia al frente.
    s.prominence = min(float(np.median(s.angular_deg[s.visible])), PROMINENCE_CAP_DEG)
    s.score = s.fraction * s.prominence * s.stability * facing_weight(s.median_rel)
    return s


def facing_weight(rel: float) -> float:
    """Mirar hacia adelante es más fácil que girar la cabeza, y girarla que darse vuelta con el
    casco puesto: un landmark al frente vale más que uno al costado, y ese más que uno atrás."""
    a = abs(rel)
    if a < SIDE_DEG[0]:
        return 1.0
    if a <= SIDE_DEG[1]:
        return 0.7
    return 0.4


def look_alikes(s: Sighting, pool: Sequence[Sighting]) -> list[Sighting]:
    """Candidatos que se confunden con `s`: se ven hacia el mismo lado (±ALIKE_DEG) y con un
    tamaño aparente parecido (entre la mitad y el doble)."""
    out = []
    for o in pool:
        if o is s or o.landmark.id == s.landmark.id:
            continue
        if abs(float(wrap180(o.median_rel - s.median_rel))) > ALIKE_DEG:
            continue
        if s.prominence > 0 and 0.5 <= o.prominence / s.prominence <= 2.0:
            out.append(o)
    return out


def best_sighting(terrain: Terrain, landmarks: Sequence[Landmark], olat, olon, oz,
                  heading: float, extra: Sequence[Sighting] = ()) -> tuple[Sighting | None, bool, list[Sighting]]:
    """(mejor avistaje, ¿se pudo evaluar algún candidato?). Sin terreno en las líneas de
    vista no se puede afirmar que no se ve nada: no es lo mismo que "no hay referencia".

    También devuelve todos los que se ven en al menos MIN_VISIBLE del trecho (`pool`): un
    candidato con parecidos hacia el mismo lado pierde puntaje, porque se puede confundir.
    `extra` son avistajes ya armados (el mástil del hábitat) que compiten igual que el resto."""
    mid = len(olat) // 2
    d = np.array([float(haversine(olat[mid], olon[mid], lm.lat, lm.lon)) for lm in landmarks])
    radius = np.array([lm.radius_m for lm in landmarks])
    near_edge = np.maximum(d - radius, 0.0)
    ok = near_edge <= MAX_RANGE_M
    # Tamaño aparente a ojo (sin terreno), para quedarse con los mejores antes de la línea de vista.
    rough = np.degrees(2 * np.arctan2(radius, np.maximum(d, 1.0)))
    rough[d < radius] = 90.0     # adentro del cráter: el borde rodea al caminante
    order = [int(i) for i in np.argsort(-rough) if ok[i]][:MAX_CANDIDATES]
    evaluated = not order    # sin candidatos al alcance: no hay nada que ver, y eso sí se sabe
    pool: list[Sighting] = []
    for i in order:
        s = sight(terrain, landmarks[i], olat, olon, oz, heading)
        if s is None:
            evaluated = True     # se miró el borde entero desde adentro y no se ve
            continue
        evaluated |= s.unknown < s.visible.size
        score(s)
        if s.fraction >= MIN_VISIBLE:
            pool.append(s)
    for s in extra:
        score(s)
        evaluated = True
        if s.fraction >= MIN_VISIBLE:
            pool.append(s)
    for s in pool:
        s.alike = look_alikes(s, pool)
        s.score /= 1 + len(s.alike)
    best = max(pool, key=lambda s: s.score, default=None)
    return best, evaluated, pool


# ------------------------------------------------------------------ reloj, cuerpo y Sol


def clock(rel_deg: float) -> int:
    """Posición de reloj (1–12) de un rumbo relativo a la marcha: 12 = al frente, 3 = derecha."""
    h = int(round(float(wrap180(rel_deg)) / 30.0)) % 12
    return 12 if h == 0 else h


def at_clock(rel_deg: float) -> str:
    c = clock(rel_deg)
    return "a la 1" if c == 1 else f"a las {c}"


def body_side(rel_deg: float) -> str:
    """Dónde queda algo respecto del cuerpo, para el Sol: "de frente", "sobre el hombro derecho"."""
    a = float(wrap180(rel_deg))
    hand = "derecho" if a > 0 else "izquierdo"
    side = "derecha" if a > 0 else "izquierda"
    if abs(a) <= 20:
        return "de frente"
    if abs(a) <= 70:
        return f"adelante a la {side}"
    if abs(a) <= 110:
        return f"sobre el hombro {hand}"
    if abs(a) <= 160:
        return f"atrás a la {side}"
    return "en la espalda"


@dataclass(frozen=True)
class SunPos:
    az: float
    el: float
    src: dict


SUN_MARS24 = {
    "provenance": "MODELED", "mission": None, "instrument": "Mars24",
    "source": "Posición del Sol con Mars24 (Allison & McEwen 2000): declinación por Ls y hora solar local",
    "assumptions": ["Sin la pila de sombras de ese sol: aproximación analítica, sin efemérides SPICE",
                    "Horizonte plano; el Sol se mueve unos 15° por hora: vale para la hora de paso"],
}


def sun_mars24(t: float, lat: float, lon: float) -> SunPos:
    """Azimut (0 = norte, 90 = este) y elevación del Sol con Mars24, sin SPICE."""
    from .mars_time import declination_deg, ls_deg, ltst_hours
    d = math.radians(declination_deg(ls_deg(t)))
    h = math.radians((ltst_hours(t, lon) - 12.0) * 15.0)
    p = math.radians(lat)
    el = math.asin(math.sin(p) * math.sin(d) + math.cos(p) * math.cos(d) * math.cos(h))
    az = math.atan2(-math.cos(d) * math.sin(h), math.sin(d) * math.cos(p) - math.cos(d) * math.cos(h) * math.sin(p))
    return SunPos(math.degrees(az) % 360.0, math.degrees(el), SUN_MARS24)


def sun_from_stack(stack, t: float) -> SunPos | None:
    """Azimut y elevación del Sol de la pila de sombras (SPICE, por hora), interpolados entre
    las dos horas que rodean `t`. None si la pila no cubre `t` o no trae el azimut."""
    if stack is None or not stack.covers(t):
        return None
    by_band = {int(b["band"]): b for b in stack.index.get("shadow_hourly", {}).get("bands", [])}
    pts = sorted((bt, by_band.get(band)) for band, bt, _, _ in stack.bands)
    pts = [(bt, b) for bt, b in pts if b is not None and b.get("sun_az_deg") is not None]
    if len(pts) < 2 or not (pts[0][0] <= t <= pts[-1][0]):
        return None
    k = next(i for i in range(1, len(pts)) if pts[i][0] >= t)
    (t0, b0), (t1, b1) = pts[k - 1], pts[k]
    f = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
    az0, az1 = float(b0["sun_az_deg"]), float(b1["sun_az_deg"])
    az = (az0 + float(wrap180(az1 - az0)) * f) % 360.0
    el = float(b0["sun_el_deg"]) + (float(b1["sun_el_deg"]) - float(b0["sun_el_deg"])) * f
    prov = stack.provenance()
    src = {"provenance": prov["provenance"], "mission": "NASA NAIF", "instrument": "SPICE",
           "source": f"Azimut y elevación del Sol de la pila {stack.tag} (pipeline/illumination.py), "
                     "interpolados entre horas",
           "assumptions": [a for a in prov.get("assumptions", []) if "sol" in a.lower() or "estación" in a.lower()]
           + ["El Sol se mueve unos 15° por hora: vale para la hora de paso estimada"]}
    return SunPos(az, el, src)


def sun_at(stack, t: float | None, lat: float, lon: float) -> SunPos | None:
    if t is None:
        return None
    return sun_from_stack(stack, t) or sun_mars24(t, lat, lon)


def sun_usable(sun: SunPos | None) -> bool:
    return sun is not None and SUN_MIN_EL <= sun.el <= SUN_MAX_EL


def sun_phrase(sun: SunPos, heading: float) -> str:
    """"el Sol sobre el hombro derecho y tu sombra hacia las 9"."""
    rel = sun.az - heading
    return f"el Sol {body_side(rel)} y tu sombra hacia {at_clock(rel + 180.0)[2:].strip()}"


def sun_check(sun: SunPos | None, heading: float) -> dict | None:
    if sun is None:
        return None
    if sun.el < SUN_MIN_EL:
        return None    # de noche o rozando el horizonte: no hay nada que confirmar
    if sun.el > SUN_MAX_EL:
        text = (f"A esta hora el Sol está muy alto ({sun.el:.0f}°): la sombra es corta y no sirve "
                "para orientarse.")
    else:
        text = f"Tenés {sun_phrase(sun, heading)}."
    return {"kind": "sun", "text": text, **sun.src}


# ------------------------------------------------------------------ hábitat

HABITAT_SRC_BASE = {"provenance": "DERIVED", "mission": "MRO", "instrument": "HiRISE DTM",
                    "source": "Línea de vista al mástil del hábitat (api/contact.py), desde el punto A marcado"}


def habitat_sighting(contact, habitat: tuple[float, float], olat, olon, heading: float) -> Sighting | None:
    """El mástil del hábitat como referencia: se ve desde donde hay línea de vista (la misma
    que usa el límite de contacto por radio)."""
    if contact is None:
        return None
    vis = contact.visible_latlon(list(zip(olat.tolist(), olon.tolist())))
    seen = np.array([v is True for v in vis])
    d = haversine(olat, olon, habitat[0], habitat[1])
    if float(np.median(d)) < 100.0:
        return None    # está al lado: no orienta
    rel = wrap180(bearing(olat, olon, habitat[0], habitat[1]) - heading)
    lm = Landmark("habitat", "Hábitat", "habitat", habitat[0], habitat[1], 5.0, "peak", "el mástil del hábitat")
    # El mástil es chico pero inconfundible (y en la vuelta es justo adonde se va): pesa como un
    # rasgo de HABITAT_WEIGHT_DEG de tamaño aparente.
    return Sighting(lm, habitat[0], habitat[1], None, seen, rel, np.full(seen.shape, HABITAT_WEIGHT_DEG),
                    unknown=sum(v is None for v in vis), distance_m=float(np.median(d)), elev_deg=0.0)


def habitat_src(contact) -> dict:
    from .contact import ASSUMPTIONS
    src = {**HABITAT_SRC_BASE, "assumptions": ASSUMPTIONS}
    if contact is not None:
        src["resolution"] = contact.resolution
    return src


# ------------------------------------------------------------------ texto


def _contract(prep: str, name: str) -> str:
    """"a el" -> "al", "de el" -> "del"."""
    if name.startswith("el ") and prep in ("a", "de"):
        return ("al " if prep == "a" else "del ") + name[3:]
    return f"{prep} {name}"


def _target_name(s: Sighting) -> str:
    if s.side:
        return f"el borde {s.side} {_contract('de', s.landmark.label)}"
    return s.landmark.label


def _position(rel: float) -> str:
    """Tipo de indicación según dónde queda el landmark respecto de la marcha."""
    a = abs(rel)
    if a < SIDE_DEG[0]:
        return "toward"
    if a <= SIDE_DEG[1]:
        return "keep_right" if rel > 0 else "keep_left"
    return "away"


def which_one(s: Sighting) -> str:
    """Cómo distinguir `s` de sus parecidos hacia el mismo lado. "" si no tiene."""
    if not s.alike:
        return ""
    group = [s, *s.alike]
    n = len(group)
    count = "los dos" if n == 2 else f"los {n}"
    big = "más alto" if s.landmark.shape == "peak" or s.side else "más grande"
    small = "más bajo" if s.landmark.shape == "peak" or s.side else "más chico"
    others = [o.prominence for o in s.alike]
    if s.prominence >= 1.25 * max(others):
        return f", el {big} de {count} que se ven hacia ahí"
    if s.prominence <= 0.8 * min(others):
        return f", el {small} de {count} que se ven hacia ahí"
    order = sorted(group, key=lambda o: o.median_rel)
    if order[0] is s:
        return f", el de más a la izquierda de {count} que se ven hacia ahí"
    if order[-1] is s:
        return f", el de más a la derecha de {count} que se ven hacia ahí"
    return f", el del medio de {count} que se ven hacia ahí"


def height_words(elev_deg: float) -> str:
    """Altura aparente en medidas de mano con el brazo estirado (dedo ≈ 2°, puño ≈ 10°)."""
    if elev_deg < 1.0:
        return "apenas sobre el horizonte"
    if elev_deg < 6.0:
        n = max(1, round(elev_deg / 2.0))
        return f"a {'un dedo' if n == 1 else f'{n} dedos'} sobre el horizonte"
    n = max(1, round(elev_deg / 10.0))
    return f"a {'un puño' if n == 1 else f'{n} puños'} sobre el horizonte"


def look_check(s: Sighting, src: dict) -> dict:
    lm = s.landmark
    if lm.catalog == "habitat":
        text = f"El mástil queda a unos {fmt_distance(s.distance_m)}."
    elif lm.shape == "crater" and not s.side:
        text = (f"Se ve como una loma baja (el borde) a unos {fmt_distance(s.distance_m)}, "
                f"{height_words(s.elev_deg)}.")
    else:
        text = f"Queda a unos {fmt_distance(s.distance_m)}, {height_words(s.elev_deg)}."
    return {"kind": "landmark", "text": text, **src,
            "assumptions": list(src.get("assumptions", [])) + [
                "Con el brazo estirado, un dedo tapa unos 2° y un puño unos 10°"]}


def walk_words(length_m: float, minutes: float | None) -> str:
    if minutes is None or not math.isfinite(minutes):
        return fmt_distance(length_m)
    m = max(1, int(round(minutes / 5.0) * 5)) if minutes >= 10 else max(1, round(minutes))
    return f"unos {m} min ({fmt_distance(length_m)})"


def turn_words(turn_deg: float) -> str:
    """"Girá a la izquierda, hacia las 10": el reloj marca para dónde mirar después del giro."""
    hand = "derecha" if turn_deg > 0 else "izquierda"
    return f"Girá a la {hand}, hacia {at_clock(turn_deg)[2:].strip()}"


def main_text(kind: str, s: Sighting, walk: str, turn_deg: float) -> str:
    name = _target_name(s) + which_one(s)
    where = at_clock(s.median_rel)
    if turn_deg:
        # El landmark marca dónde termina el giro: no hace falta además la hora del giro.
        hand = "derecha" if turn_deg > 0 else "izquierda"
        return f"Girá a la {hand} hasta tener {name} {where} y caminá {walk}."
    if kind == "toward":
        return f"Caminá {walk} hacia {name}, {where}."
    if kind in ("keep_left", "keep_right"):
        return f"Caminá {walk} con {name} {where}."
    return f"Caminá {walk} con {name} {where}, a tu espalda."


def fallback_text(walk: str, heading: float, turn_deg: float, reason: str, sun: SunPos | None) -> tuple[str, str]:
    """(kind, texto) del respaldo: por el Sol si sirve a esa hora, si no por rumbo."""
    lead = f"{reason}. {turn_words(turn_deg)} y " if turn_deg else f"{reason}: "
    if sun_usable(sun):
        return "fallback_sun", f"{lead}caminá {walk} con {sun_phrase(sun, heading)}."
    return ("fallback_bearing",
            f"{lead}mantené el rumbo {round(heading) % 360:03d}° ({compass(heading)}) durante {walk}.")


def until_text(s: Sighting, last: bool) -> str:
    verb = "Llegaste" if last else "Pará"
    return f"{verb} cuando {_target_name(s)} te quede {at_clock(s.median_rel)}."


# ------------------------------------------------------------------ salida


GEOMETRY = {"provenance": "DERIVED", "mission": None, "instrument": "largo de la ruta",
            "source": f"Distancia sobre la ruta del planificador (esfera R = {MARS_RADIUS_M:.0f} m)"}
DURATION = {"provenance": "MODELED", "mission": None, "instrument": "modelo del traje",
            "source": "Duración del tramo (api/consumables.py) repartida por distancia",
            "assumptions": ["Ritmo parejo dentro del tramo"]}


def _mv(value, unit, src: dict) -> dict:
    return {"value": value, "unit": unit, **src}


def visibility_source(terrain: Terrain | None, note: str | None = None) -> dict:
    if terrain is None or not terrain:
        return {"provenance": "DERIVED", "mission": None, "instrument": "línea de vista",
                "source": note or "Falta el terreno para calcular la línea de vista"}
    # El badge dice "línea de vista"; de qué terreno sale (DTM HiRISE de MRO, DEM MOLA-HRSC
    # de MGS + Mars Express) va en la resolución y la fuente, que se ven en el tooltip.
    return {
        "provenance": "DERIVED",
        "mission": None,
        "instrument": "línea de vista",
        "resolution": terrain.resolution,
        "source": "Línea de vista sobre " + " y ".join(f.label for f in terrain.fields) + ", cada "
                  f"{SAMPLE_STEP_M:.0f} m del trecho (api/directions.py)",
        "assumptions": [
            f"Ojos a {EYE_M} m del suelo; se mira la parte más alta del rasgo (borde o cima)",
            "Se descuenta la curvatura de Marte",
            "El terreno promediado no ve obstáculos más chicos que su celda (rocas, dunas chicas)",
            f"Cuenta como visible si asoma al menos {MIN_ANGULAR_DEG}° sobre la línea de vista",
            f"Un candidato con parecidos a ±{ALIKE_DEG:.0f}° pierde puntaje y se nombra frente a ellos",
        ],
    }


def _landmark_out(s: Sighting) -> dict:
    lm = s.landmark
    out = {"id": lm.id, "name": lm.name, "source": lm.catalog, "lat": round(lm.lat, 6), "lon": round(lm.lon, 6)}
    if s.side:
        out["target"] = {"lat": round(s.target_lat, 6), "lon": round(s.target_lon, 6)}
    return out


@dataclass
class LegInput:
    latlon: Sequence[tuple[float, float]]
    t_start: float | None = None      # hora de salida del tramo (epoch s)
    duration_s: float | None = None   # del modelo del traje


@dataclass
class Context:
    terrain: Terrain | None = None
    landmarks: Sequence[Landmark] | None = None
    missing_reason: str | None = None
    stack: object = None              # ShadowStack para el Sol (SPICE); sin ella, Mars24
    contact: object = None            # ContactField: línea de vista al hábitat
    habitat: tuple[float, float] | None = None


def _stop_signal(ctx: Context, s: Stretch, latlon, main: Sighting | None, last: bool) -> dict | None:
    """Qué se ve al costado justo al final del trecho: la señal para saber que hay que parar."""
    cum = _cumdist(latlon)
    at = max(s.start_m, s.start_m + s.length_m - 10.0)
    lat = np.array([np.interp(at, cum, [p[0] for p in latlon])])
    lon = np.array([np.interp(at, cum, [p[1] for p in latlon])])
    best: Sighting | None = None
    if ctx.terrain and ctx.landmarks:
        oz = ctx.terrain.z(lat, lon) + EYE_M
        if np.isfinite(oz).all():
            d = np.array([float(haversine(lat[0], lon[0], lm.lat, lm.lon)) for lm in ctx.landmarks])
            near = [ctx.landmarks[i] for i in np.argsort(d)[:MAX_CANDIDATES] if d[i] - ctx.landmarks[i].radius_m <= MAX_RANGE_M]
            for lm in near:
                sg = sight(ctx.terrain, lm, lat, lon, oz, s.heading)
                if sg is None or not sg.visible[0]:
                    continue
                if not (STOP_SIDE_DEG[0] <= abs(float(sg.rel_bearing[0])) <= STOP_SIDE_DEG[1]):
                    continue
                score(sg)
                if best is None or sg.prominence > best.prominence:
                    best = sg
    if best is None and ctx.habitat is not None:
        hs = habitat_sighting(ctx.contact, ctx.habitat, lat, lon, s.heading)
        if hs is not None and hs.visible[0] and STOP_SIDE_DEG[0] <= abs(float(hs.rel_bearing[0])) <= STOP_SIDE_DEG[1]:
            score(hs)
            best = hs
    if best is None:
        return None
    return {"text": until_text(best, last), "landmark": _landmark_out(best)}


def leg_directions(leg, terrain: Terrain | None = None, landmarks: Sequence[Landmark] | None = None,
                   missing_reason: str | None = None, ctx: Context | None = None) -> list[dict]:
    """Indicaciones de un tramo, en orden: una por trecho, con confirmaciones y señal de parada.

    `leg` puede ser la polilínea sola (sin horario: no hay Sol ni duración) o un LegInput."""
    if not isinstance(leg, LegInput):
        leg = LegInput(leg)
    ctx = ctx or Context(terrain, landmarks, missing_reason)
    latlon = leg.latlon
    if len(latlon) < 2:
        return []
    leg_len = float(_cumdist(latlon)[-1]) or 1.0
    can_see = ctx.terrain is not None and bool(ctx.terrain) and ctx.landmarks is not None
    vis_src = visibility_source(ctx.terrain, ctx.missing_reason)
    hab_src = habitat_src(ctx.contact)
    parts = stretches(latlon)
    out: list[dict] = []
    warned_high_sun = False   # "el Sol está muy alto" se dice una vez por tramo, no en cada trecho
    for k, s in enumerate(parts):
        last = k == len(parts) - 1
        olat, olon = observers(latlon, s)
        mid = len(olat) // 2
        minutes = None
        t_mid = None
        if leg.duration_s is not None:
            minutes = leg.duration_s * s.length_m / leg_len / 60.0
            if leg.t_start is not None:
                t_mid = leg.t_start + leg.duration_s * (s.start_m + s.length_m / 2) / leg_len
        sun = sun_at(ctx.stack, t_mid, float(olat[mid]), float(olon[mid]))
        walk = walk_words(s.length_m, minutes)

        extra = []
        hab = None
        if ctx.habitat is not None:
            hab = habitat_sighting(ctx.contact, ctx.habitat, olat, olon, s.heading)
            if hab is not None:
                extra.append(hab)
        best, evaluated = None, False
        if can_see or extra:
            oz = ctx.terrain.z(olat, olon) + EYE_M if can_see else np.full(olat.shape, np.nan)
            if np.isfinite(oz).any():
                best, evaluated, _ = best_sighting(ctx.terrain, ctx.landmarks, olat, olon, oz, s.heading, extra)
            elif extra:
                best, evaluated, _ = best_sighting(ctx.terrain, [], olat, olon, oz, s.heading, extra)

        item: dict = {
            "distance": _mv(round(s.length_m, 1), "m", GEOMETRY),
            "duration": _mv(None if minutes is None else round(minutes, 1), "min", DURATION),
            "clock": None,
            "relative_bearing_deg": None,
        }
        checks: list[dict] = []
        if best is None:
            if evaluated:
                reason = "Sin referencia visible"
            elif can_see:
                reason = "No se pudo evaluar qué se ve (falta terreno en este trecho)"
            else:
                reason = ctx.missing_reason or "Sin landmarks evaluados"
            kind, text = fallback_text(walk, s.heading, s.turn_deg, reason, sun)
            item.update(kind=kind, text=text, landmark=None, visible_fraction=_mv(None, None, vis_src))
        else:
            kind = "turn" if s.turn_deg else _position(best.median_rel)
            src = hab_src if best.landmark.catalog == "habitat" else vis_src
            item.update(kind=kind, text=main_text(kind, best, walk, s.turn_deg), landmark=_landmark_out(best),
                        visible_fraction=_mv(round(best.fraction, 2), None, src),
                        clock=clock(best.median_rel), relative_bearing_deg=round(best.median_rel))
            checks.append(look_check(best, src))
        if item["kind"] != "fallback_sun":
            high = sun is not None and sun.el > SUN_MAX_EL
            c = None if (high and warned_high_sun) else sun_check(sun, s.heading)
            if c:
                checks.append(c)
                warned_high_sun |= high
        # El hábitat como confirmación, si se ve y no es ya la referencia principal.
        if hab is not None and hab.visible[mid] and not (best is not None and best.landmark.catalog == "habitat"):
            checks.append({"kind": "habitat",
                           "text": f"El mástil del hábitat se ve {at_clock(float(hab.rel_bearing[mid]))}"
                                   f"{', a tu espalda' if clock(float(hab.rel_bearing[mid])) in (5, 6, 7) else ''}.",
                           **hab_src})
        item["checks"] = checks[:3]
        item["until"] = _stop_signal(ctx, s, latlon, best, last)
        if sun is not None:
            item["sun"] = {"azimuth_deg": round(sun.az, 1), "elevation_deg": round(sun.el, 1), **sun.src}
        out.append(item)
    return out


# ------------------------------------------------------------------ entrada desde disco


def _bbox(points: Sequence[tuple[float, float]], margin_m: float) -> tuple[float, float, float, float]:
    lats = [p[0] for p in points]
    lons = [_norm_lon(p[1]) for p in points]
    dlat = margin_m / (math.pi / 180 * MARS_RADIUS_M)
    coslat = max(math.cos(math.radians(max(abs(min(lats)), abs(max(lats))) + dlat)), 0.1)
    return min(lats) - dlat, max(lats) + dlat, min(lons) - dlat / coslat, max(lons) + dlat / coslat


def dem_path(data_dir: Path, site_id: str) -> Path | None:
    """DEM global de 200 m recortado al sitio (pipeline/download.py, key dem200_crop)."""
    try:
        m = json.loads((Path(data_dir) / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    for f in (m.get("sites", {}).get(site_id, {}).get("files") or []):
        if f.get("key") == "dem200_crop" and f.get("status") == "ok" and f.get("path"):
            p = Path(data_dir) / f["path"]
            return p if p.is_file() else None
    return None


def route_directions(data_dir: Path, site_id: str, dtm_path: Path | None,
                     legs: Sequence, stack=None, contact=None, habitat: tuple[float, float] | None = None,
                     open_field: Callable[..., Field | None] = Field.from_raster) -> list[list[dict]]:
    """Indicaciones de cada tramo de la ruta. Lee el terreno una vez para toda la ruta.

    `legs`: LegInput (o polilíneas solas). `stack` da el Sol de SPICE; sin ella, Mars24.
    `contact` y `habitat` suman el mástil del hábitat como referencia."""
    legs = [lg if isinstance(lg, LegInput) else LegInput(lg) for lg in legs]
    landmarks = load_landmarks(Path(data_dir) / "output" / site_id / "places.json")
    reason = None
    if landmarks is None:
        reason = "Sin catálogo de landmarks (falta places.json)"
    pts = [p for leg in legs for p in leg.latlon]
    fields = []
    if pts and landmarks:
        if dtm_path is not None:
            fields.append(open_field(dtm_path, *_bbox(pts, NEAR_MARGIN_M), NEAR_CELL_M, "HiRISE DTM"))
        dem = dem_path(data_dir, site_id)
        if dem is not None:
            fields.append(open_field(dem, *_bbox(pts, FAR_MARGIN_M), 200.0, "DEM MOLA-HRSC"))
    terrain = Terrain(fields) if fields else None
    if landmarks is not None and not terrain:
        reason = "Sin terreno para la línea de vista (falta el DTM y el DEM)"
    ctx = Context(terrain, landmarks, reason, stack, contact, habitat)
    return [leg_directions(leg, ctx=ctx) for leg in legs]
