#!/usr/bin/env python3
"""Índice de lugares de un sitio, para el buscador de destinos del planificador.

Junta las fuentes que ya baja el pipeline y escribe <out>/<sitio>/places.json:

  - Nomenclátor IAU/USGS (sites/common.json, key `iau_names`): nombres oficiales, con el
    centro del rasgo. Lo baja download.py en raw/common/.
  - Cráteres de Robbins & Hynek 2012 (fetch_extras.py): no tienen nombre, se buscan por id y
    diámetro. Catálogo completo para cráteres de 1 km o más.
  - Waypoints del rover (sites/<sitio>.json, key `rover_waypoints`, MMGIS): dónde estuvo el
    rover en cada sol.
  - Aeródromos del helicóptero (key `heli_waypoints`, MMGIS): cada aeródromo con nombre, en el
    punto de su último aterrizaje.
  - Depósito de muestras (key `sample_depot_locations`, CSV de PDS Geosciences): un lugar por
    tubo, en la posición del rover al soltarlo.
  - Objetivos científicos con nombre (PDS Geosciences):
      `chemcam_obs`   lista de observaciones de ChemCam (msl_ccam_obs.csv)
      `supercam_obs`  lista maestra de SuperCam (m2020_scam_masterlist.csv)
      `apxs_targets*` tablas de APXS con la posición medida de cada objetivo
      `pixl_inventory` objetivos de PIXL que arma fetch_targets.py desde las etiquetas PDS
    ChemCam y SuperCam no publican la posición del objetivo sino desde dónde se midió (site y
    drive del rover): se cruza con los waypoints del rover. APXS sí publica la del objetivo.
    Un mismo nombre medido por varios instrumentos queda como un solo lugar.

Cada fuente se activa si el sitio declara ese `key` en sites/<sitio>.json: sumar un sitio con
helicóptero o depósito no necesita código.

Solo entran lugares cuyo punto cae dentro del bbox del sitio: afuera no hay DTM de 1 m y el
planificador no los puede usar como destino. Que el punto tenga terreno real lo decide el
frontend con la máscara de cobertura (coverage.geojson de precompute.py).

Los nombres informales que no publica ninguna fuente (ej. el boxwork de Gale) no se agregan a
mano con coordenadas inventadas.

    python pipeline/places.py --site jezero
    python pipeline/places.py --site gale --out /tmp/salida

Sale con 0 si escribió el índice (aunque falte alguna fuente), 2 si no hay ninguna fuente.
"""
from __future__ import annotations

import argparse
import csv
import re
import datetime as dt
import io
import json
import math
import os
import struct
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

MAX_SUGGESTED_IAU = 6   # chips de lugares sugeridos: no más que lo que entra en el panel
MAX_SUGGESTED_TARGETS = 3   # chips de objetivos científicos ("donde el rover midió química")
COORD_DECIMALS = 6      # 1e-6° ≈ 6 cm en Marte
MARS_RADIUS_M = 3396190.0
NEAR_TARGET_M = 10.0    # hasta acá, el objetivo está prácticamente donde estaba el rover

# Objetivos que no son lugares: cielo, blancos de calibración, atmósfera, oscuros.
NOT_A_PLACE = re.compile(r"sky|calib|cal target|\bscct\b|\bccct\b|\bcct\b|atmos|\bdark\b", re.I)
NOT_A_PLACE_NAME = re.compile(r"^(atm|sky|scct|ccct|cct|cal|calibration|dark|test|none|unk|n/?a)\b", re.I)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ------------------------------------------------------------------ utilidades

def norm_lon(lon):
    """Longitud este positiva en [-180, 180), el marco de sites/*.json."""
    return ((float(lon) + 180.0) % 360.0) - 180.0


def in_bbox(lat, lon, bbox):
    return bbox["lat_min"] <= lat <= bbox["lat_max"] and bbox["lon_min"] <= lon <= bbox["lon_max"]


def read_dbf(data: bytes):
    """Filas de un .dbf (dBase III) como dicts de texto. Alcanza para el nomenclátor IAU."""
    n, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        raw = data[pos:pos + 32]
        fields.append((raw[:11].split(b"\0")[0].decode("ascii"), raw[16]))
        pos += 32
    rows = []
    for i in range(n):
        rec = data[header_len + i * record_len: header_len + (i + 1) * record_len]
        if not rec or rec[0:1] == b"*":   # registro borrado
            continue
        row, off = {}, 1
        for name, length in fields:
            row[name] = rec[off:off + length].decode("utf-8", "replace").strip()
            off += length
        rows.append(row)
    return rows


def local_raw(site_id, entry):
    """Archivo crudo ya descargado, o None. Igual que precompute.find_input, sin S3."""
    manifest = DATA_DIR / "manifest.json"
    if manifest.exists():
        m = json.loads(manifest.read_text())
        files = m.get("common", []) if site_id == "common" else m.get("sites", {}).get(site_id, {}).get("files", [])
        hit = next((f for f in files if f.get("key") == entry["key"]), None)
        if hit is not None:
            path = DATA_DIR / hit["path"] if hit.get("status") == "ok" and hit.get("path") else None
            return path if path and path.exists() else None
    path = DATA_DIR / "raw" / site_id / Path(urlparse(entry["url"]).path).name
    return path if path.exists() else None


# ------------------------------------------------------------------ fuentes

def iau_places(zip_path, bbox):
    """Nombres IAU adoptados cuyo centro cae en el bbox."""
    with zipfile.ZipFile(zip_path) as z:
        dbf = next(n for n in z.namelist() if n.lower().endswith(".dbf"))
        rows = read_dbf(z.read(dbf))
    out = []
    for r in rows:
        try:
            lat, lon = float(r["center_lat"]), norm_lon(r["center_lon"])
        except (KeyError, ValueError):
            continue
        if not in_bbox(lat, lon, bbox):
            continue
        if r.get("approval") and "adopted" not in r["approval"].lower():
            continue
        feature_type = (r.get("type") or "").split(",")[0].strip()
        diameter = float(r["diameter"]) if r.get("diameter") else None
        detail = feature_type or "Rasgo con nombre IAU"
        if diameter:
            detail += f" · {diameter:.1f} km".replace(".", ",")
        out.append({
            "id": f"iau-{r.get('link', '').rstrip('/').rsplit('/', 1)[-1] or normalize_id(r['name'])}",
            "name": r["name"],
            "kind": "iau",
            "detail": detail,
            "lat": round(lat, COORD_DECIMALS), "lon": round(lon, COORD_DECIMALS),
            "provenance": "DERIVED",
            "mission": None,
            "instrument": "Nomenclátor IAU",
            "source": "Gazetteer of Planetary Nomenclature (IAU/USGS), centro del rasgo",
            "link": r.get("link") or None,
            "_size_km": diameter or 0.0,
        })
    return out


def robbins_places(geojson_path, bbox):
    """Cráteres de Robbins & Hynek 2012 cuyo centro cae en el bbox (≥ 1 km)."""
    feats = json.loads(Path(geojson_path).read_text()).get("features", [])
    out = []
    for f in feats:
        p = f.get("properties") or {}
        try:
            lat, lon = float(p["lat"]), norm_lon(p["lon_e"])
        except (KeyError, TypeError, ValueError):
            continue
        if not in_bbox(lat, lon, bbox):
            continue
        cid = str(p.get("craterid") or f.get("id"))
        diam = p.get("diamkm")
        detail = "Cráter sin nombre (catálogo de Robbins)"
        if diam is not None:
            detail = f"Cráter de {float(diam):.2f} km (catálogo de Robbins)".replace(".", ",")
        out.append({
            "id": f"robbins-{cid}",
            "name": f"Cráter {cid}",
            "kind": "crater",
            "detail": detail,
            "lat": round(lat, COORD_DECIMALS), "lon": round(lon, COORD_DECIMALS),
            "provenance": "DERIVED",
            "mission": "Mars Odyssey",
            "instrument": "THEMIS",
            "resolution": "catálogo completo para cráteres de 1 km o más",
            "source": "Robbins & Hynek 2012, mosaico diurno THEMIS IR (API OGC de USGS)",
        })
    return out


def rover_places(waypoints_path, bbox, rover, mission):
    """Waypoints MMGIS del rover en el bbox, uno por (site, drive)."""
    feats = json.loads(Path(waypoints_path).read_text()).get("features", [])
    out, seen = [], set()
    for f in feats:
        p = f.get("properties") or {}
        try:
            lat, lon, sol = float(p["lat"]), norm_lon(p["lon"]), int(p["sol"])
        except (KeyError, TypeError, ValueError):
            continue
        key = p.get("RMC") or (p.get("site"), p.get("drive"))
        if key in seen or not in_bbox(lat, lon, bbox):
            continue
        seen.add(key)
        out.append({
            "id": f"rover-{p.get('RMC') or f'{sol}-{len(out)}'}",
            "name": f"{rover} · sol {sol}",
            "kind": "rover",
            "detail": f"Waypoint del rover, site {p.get('site', '?')} drive {p.get('drive', '?')}",
            "lat": round(lat, COORD_DECIMALS), "lon": round(lon, COORD_DECIMALS),
            "provenance": "DERIVED",
            "mission": mission,
            "instrument": "MMGIS",
            "source": "Localización del equipo del rover publicada en MMGIS (mars.nasa.gov)",
            "_sol": sol,
        })
    return out


def heli_places(waypoints_path, bbox, mission):
    """Aeródromos del helicóptero (MMGIS): uno por nombre, en su último aterrizaje.

    Cada fila de MMGIS es la posición al terminar un vuelo, con `ToAirfld` = dónde aterrizó.
    El último aterrizaje en el último aeródromo es donde quedó el helicóptero.
    """
    feats = json.loads(Path(waypoints_path).read_text()).get("features", [])
    fields = {}
    for f in feats:
        p = f.get("properties") or {}
        name = (p.get("ToAirfld") or "").strip()
        try:
            lat, lon, flight, sol = float(p["Lat"]), norm_lon(p["Lon"]), int(p["Flight"]), int(p["Sol"])
        except (KeyError, TypeError, ValueError):
            continue
        if not name or not in_bbox(lat, lon, bbox):
            continue
        a = fields.setdefault(name, {"flights": [], "lat": lat, "lon": lon, "sol": sol})
        a["flights"].append(flight)
        if flight >= max(a["flights"]):
            a.update(lat=lat, lon=lon, sol=sol)
    out = []
    for name, a in fields.items():
        fl = sorted(a["flights"])
        # En MMGIS el "vuelo 0" es el despliegue desde el rover, no un vuelo.
        real = [x for x in fl if x > 0]
        parts = ["despliegue"] if 0 in fl else []
        if real:
            parts.append(f"vuelo {real[0]}" if len(real) == 1 else
                         "vuelos " + ", ".join(map(str, real[:-1])) + f" y {real[-1]}")
        landings = " y ".join(parts)
        out.append({
            "id": f"heli-{normalize_id(name)}",
            "name": name,
            "kind": "heli",
            "detail": f"Aeródromo de Ingenuity · {landings}",
            "lat": round(a["lat"], COORD_DECIMALS), "lon": round(a["lon"], COORD_DECIMALS),
            "provenance": "DERIVED",
            "mission": mission,
            "instrument": "Ingenuity",
            "source": "Waypoints del helicóptero publicados en MMGIS (mars.nasa.gov)",
            "assumptions": [f"Posición del último aterrizaje en el aeródromo (sol {a['sol']})."],
            "_last_flight": fl[-1],
            "_first_flight": fl[0],
        })
    return out


def sample_places(csv_path, bbox, mission, depot):
    """Tubos de un depósito de muestras (CSV de PDS Geosciences), uno por tubo."""
    out = []
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            try:
                lat, lon = float(r["Rover Latitude"]), norm_lon(r["Rover Longitude"])
                sol = int(r["Dropoff Sol"])
            except (KeyError, TypeError, ValueError):
                continue
            if not in_bbox(lat, lon, bbox):
                continue
            designation = (r.get("Sample Designation") or "").strip()
            name = (r.get("Sample Name") or designation).strip()
            out.append({
                "id": f"sample-{designation or normalize_id(name)}",
                "name": f"{name} ({depot})" if depot else name,
                "kind": "sample",
                "detail": f"Tubo de muestra {designation}, soltado el sol {sol}".strip(),
                "lat": round(lat, COORD_DECIMALS), "lon": round(lon, COORD_DECIMALS),
                "provenance": "DERIVED",
                "mission": mission,
                "instrument": "PDS Geosciences",
                "source": "Sample Depot bundle de PDS Geosciences Node (sample_tube_locations.csv)",
                "assumptions": ["Es la posición del rover al soltar el tubo, no la del tubo: el tubo "
                                "quedó al alcance del brazo."],
                "_sol": sol,
            })
    return out


def normalize_id(text):
    return "".join(c if c.isalnum() else "-" for c in text.lower()).strip("-")


# ------------------------------------------------------------------ objetivos científicos

def _col(row, *names):
    """Valor de la primera columna que exista, sin importar mayúsculas, espacios o guiones bajos."""
    norm = {re.sub(r"[\s_]+", "_", k.strip().lower()): v for k, v in row.items() if k}
    for n in names:
        v = norm.get(re.sub(r"[\s_]+", "_", n.lower()))
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    return None


def rover_positions(waypoints_path):
    """(site, drive) -> (lat, lon) desde los waypoints MMGIS del rover."""
    out = {}
    for f in json.loads(Path(waypoints_path).read_text()).get("features", []):
        p = f.get("properties") or {}
        try:
            out[(int(p["site"]), int(p["drive"]))] = (float(p["lat"]), norm_lon(p["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def is_target(name, target_type):
    # "SCCT_IR_black": el guion bajo es parte de la palabra para \b, se mira con espacios.
    if not name or NOT_A_PLACE_NAME.match(name.replace("_", " ")):
        return False
    return not (target_type and NOT_A_PLACE.search(target_type))


def chemcam_rows(csv_path):
    """Filas de msl_ccam_obs.csv como observaciones normalizadas."""
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as fh:
        for r in csv.DictReader(fh):
            try:
                rmc = (int(_col(r, "RMC Site")), int(_col(r, "RMC Drive")))
                sol = int(_col(r, "Sol"))
            except (TypeError, ValueError):
                continue
            dist = _col(r, "Distance (m)")
            yield {"name": _col(r, "Target"), "type": _col(r, "Target Type"), "sol": sol, "rmc": rmc,
                   "distance_m": float(dist) if dist and re.fullmatch(r"[\d.]+", dist) else None}


SCAM_RMC = re.compile(r"__(\d{3})(\d{4})")


def supercam_rows(csv_path):
    """Filas de m2020_scam_masterlist.csv. Site y drive salen del nombre del EDR
    (`..._<site 3><drive 4>SCAM...`), la distancia del foco del telescopio."""
    with open(csv_path, newline="", encoding="utf-8-sig", errors="replace") as fh:
        for r in csv.DictReader(fh):
            m = SCAM_RMC.search(_col(r, "edr_fname") or "")
            try:
                sol = int(_col(r, "sol"))
            except (TypeError, ValueError):
                continue
            if not m:
                continue
            focus = _col(r, "focus_position_mm")
            yield {"name": _col(r, "targetname"), "type": _col(r, "Target_Type"), "sol": sol,
                   "rmc": (int(m[1]), int(m[2])),
                   "distance_m": float(focus) / 1000 if focus and re.fullmatch(r"[\d.]+", focus) else None}


def label_target_rows(csv_path):
    """targets/<key>.csv de fetch_targets.py. PIXL va en el brazo: el objetivo queda al alcance
    del brazo, pero la distancia no la publica nadie, así que no se inventa (None)."""
    with open(csv_path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            try:
                yield {"name": r["target"], "type": None, "sol": int(r["sol"]),
                       "rmc": (int(r["site"]), int(r["drive"])), "distance_m": None, "arm": True}
            except (KeyError, TypeError, ValueError):
                continue


def apxs_rows(csv_path):
    """Tablas de APXS (suplementos de PDS). Northing/Easting en metros sobre la esfera de Marte,
    equirectangular con paralelo estándar en el ecuador: lat = N/R, lon = E/R (en radianes).
    Verificado contra los waypoints MMGIS de Curiosity, que traen las dos cosas."""
    with open(csv_path, newline="", encoding="utf-8-sig", errors="replace") as fh:
        for r in csv.DictReader(fh):
            try:
                n = float(_col(r, "Northing_m", "Northing"))
                e = float(_col(r, "Easting_m", "Easting"))
                sol = int(_col(r, "Sol"))
            except (TypeError, ValueError):
                continue
            context = [x.replace("_", " ") for x in (
                _col(r, "Informal waypoint/outcrop/region name", "Informal_waypoint/outcrop/region_name"),
                _col(r, "Strat_fm", "Strat_formation"),
                _col(r, "Strat_mbr", "Strat_member")) if x]
            yield {"name": _col(r, "Target"), "type": None, "sol": sol,
                   "lat": math.degrees(n / MARS_RADIUS_M), "lon": norm_lon(math.degrees(e / MARS_RADIUS_M)),
                   "context": context}


def science_targets(sources, bbox):
    """Une las observaciones de todos los instrumentos en un lugar por nombre de objetivo.

    sources: lista de (instrumento, misión, filas, posiciones del rover o None).
    Posición: la medida por APXS si la hay; si no, la del rover al medir más cerca del objetivo.
    Devuelve (lugares, cuántas observaciones no se pudieron ubicar por instrumento).
    """
    targets, unplaced = {}, {}
    for instrument, mission, rows, positions in sources:
        for r in rows:
            name = (r["name"] or "").strip()
            if not is_target(name, r.get("type")):
                continue
            arm = bool(r.get("arm"))
            if positions is None:
                lat, lon, dist, direct = r["lat"], r["lon"], None, True
            else:
                pos = positions.get(r["rmc"])
                if pos is None:
                    unplaced[instrument] = unplaced.get(instrument, 0) + 1
                    continue
                lat, lon = pos
                dist, direct = r.get("distance_m"), False
            if not in_bbox(lat, lon, bbox):
                continue
            # Mismo id, mismo lugar: ChemCam escribe "John_Klein" y las etiquetas de PIXL "John Klein".
            key = normalize_id(name)
            if not key:
                continue
            t = targets.setdefault(key, {"name": name, "instruments": {}, "sols": set(), "types": set(),
                                         "context": [], "best": None})
            t["instruments"].setdefault(instrument, mission)
            t["sols"].add(r["sol"])
            if r.get("type"):
                t["types"].add(r["type"].strip())
            for c in r.get("context") or []:
                if c not in t["context"]:
                    t["context"].append(c)
            # Mejor posición: medida directa > observación cercana (o con el brazo) > lejana.
            # Entre iguales gana la distancia conocida más chica; una desconocida va al final.
            near = arm or (dist is not None and dist <= NEAR_TARGET_M)
            rank = (0 if direct else 1 if near else 2, math.inf if dist is None else dist)
            if t["best"] is None or rank < t["best"]["rank"]:
                t["best"] = {"rank": rank, "lat": lat, "lon": lon, "dist": dist, "direct": direct,
                             "arm": arm, "instrument": instrument, "mission": mission}

    out = []
    for key, t in targets.items():
        b = t["best"]
        sols = sorted(t["sols"])
        when = f"sol {sols[0]}" if len(sols) == 1 else f"soles {sols[0]}–{sols[-1]}"
        kind_of = sorted(t["types"], key=len)[0] if t["types"] else "objetivo"
        parts = [kind_of, " + ".join(sorted(t["instruments"])), when] + t["context"][:2]
        if b["direct"]:
            assumption = "Posición del objetivo medida por el equipo del rover (tabla de APXS)."
        elif b["arm"]:
            assumption = (f"Posición del rover al medir. {b['instrument']} va en el brazo: el objetivo "
                          "queda al alcance del brazo, no exactamente acá. La distancia no se publica.")
        elif b["rank"][0] == 1:
            assumption = (f"Posición del rover al medir, con el objetivo a {b['dist']:.1f} m: "
                          "el objetivo está a esa distancia, no exactamente acá.")
        else:
            far = f"a {b['dist']:.0f} m" if b["dist"] is not None else "a distancia desconocida"
            parts.insert(0, f"observado desde acá {far}")
            assumption = (f"Es el punto desde donde se observó, no el objetivo: el objetivo queda {far} "
                          "en una dirección que este índice no calcula.")
        out.append({
            "id": f"target-{key}",
            "name": t["name"].replace("_", " "),
            "kind": "target",
            "detail": " · ".join(parts),
            "lat": round(b["lat"], COORD_DECIMALS), "lon": round(b["lon"], COORD_DECIMALS),
            "provenance": "DERIVED",
            "mission": b["mission"],
            "instrument": " + ".join(sorted(t["instruments"])),
            "source": "PDS Geosciences Node, listas de observaciones de los instrumentos"
                      + ("" if b["direct"] else "; posición del rover de MMGIS por site y drive"),
            "assumptions": [assumption],
            # Para elegir sugeridos (mark_suggested los borra antes de escribir).
            "_rank": b["rank"][0], "_instruments": len(t["instruments"]), "_sols": len(sols),
        })
    return out, unplaced


def mark_suggested(places):
    """Chips del panel, sin elegir a mano: salen de las fuentes.

    Los rasgos IAU más chicos (los más fáciles de ubicar a pie), la primera y la última
    posición del rover, el primer tubo de cada depósito, el primer y el último aeródromo
    del helicóptero y los objetivos científicos mejor ubicados y más medidos (posición de
    APXS o rover al lado, y más instrumentos y soles encima).
    """
    iau = sorted((p for p in places if p["kind"] == "iau"), key=lambda p: p["_size_km"])
    for p in iau[:MAX_SUGGESTED_IAU]:
        p["suggested"] = True
    rover = [p for p in places if p["kind"] == "rover"]
    if rover:
        # El orden del archivo MMGIS desempata dentro de un mismo sol: el último es el más nuevo.
        first = min(enumerate(rover), key=lambda ip: (ip[1]["_sol"], ip[0]))[1]
        last = max(enumerate(rover), key=lambda ip: (ip[1]["_sol"], ip[0]))[1]
        first["suggested"] = True
        first["detail"] = "Primera posición registrada del rover en el sitio · " + first["detail"]
        if last is not first:
            last["suggested"] = True
            last["detail"] = "Última posición conocida del rover · " + last["detail"]
    samples = [p for p in places if p["kind"] == "sample"]
    if samples:
        min(samples, key=lambda p: p["_sol"])["suggested"] = True
    heli = [p for p in places if p["kind"] == "heli"]
    if heli:
        min(heli, key=lambda p: p["_first_flight"])["suggested"] = True
        last = max(heli, key=lambda p: p["_last_flight"])
        last["suggested"] = True
        last["detail"] = "Donde quedó Ingenuity · " + last["detail"]
    targets = [p for p in places if p["kind"] == "target" and p["_rank"] <= 1]
    targets.sort(key=lambda p: (-p["_instruments"], p["_rank"], -p["_sols"], p["id"]))
    for p in targets[:MAX_SUGGESTED_TARGETS]:
        p["suggested"] = True
    for p in places:
        p.setdefault("suggested", False)
        for k in [k for k in p if k.startswith("_")]:
            del p[k]
    return places


# ------------------------------------------------------------------ armado

def build(site, common):
    """Devuelve el contenido de places.json. Una fuente que falta queda en `sources` con su motivo."""
    bbox = site["bbox"]
    rover_name = site.get("rover", "Rover").split(" (")[0]
    sources, places = {}, []

    def sources_ok(key):
        return sources.get(key, {}).get("status") == "ok"

    def attempt(key, desc, fn):
        try:
            got = fn()
        except FileNotFoundError as e:
            sources[key] = {"status": "missing", "desc": desc, "error": str(e)[:300]}
            return
        except Exception as e:  # una fuente rota no frena a las otras
            sources[key] = {"status": "error", "desc": desc, "error": str(e)[:300]}
            return
        sources[key] = {"status": "ok", "desc": desc, "count": len(got)}
        places.extend(got)

    def iau():
        entry = next(f for f in common["files"] if f["key"] == "iau_names")
        path = local_raw("common", entry)
        if path is None:
            raise FileNotFoundError("El nomenclátor IAU todavía no está descargado (download.py)")
        return iau_places(path, bbox)

    def robbins():
        path = DATA_DIR / "raw" / site["id"] / "landmarks" / "robbins_craters.geojson"
        if not path.exists():
            raise FileNotFoundError("Los cráteres de Robbins todavía no están (fetch_extras.py)")
        return robbins_places(path, bbox)

    def rover():
        entry = next((f for f in site["files"] if f["key"] == "rover_waypoints"), None)
        if entry is None:
            raise FileNotFoundError(f"sites/{site['id']}.json no declara rover_waypoints")
        path = local_raw(site["id"], entry)
        if path is None:
            raise FileNotFoundError("Los waypoints del rover todavía no están descargados (download.py)")
        return rover_places(path, bbox, rover_name, entry.get("mission"))

    def site_file(key):
        """Entrada y archivo local de un `key` del sitio. Sin entrada, la fuente no aplica."""
        entry = next((f for f in site["files"] if f["key"] == key), None)
        if entry is None:
            return None, None
        path = local_raw(site["id"], entry)
        if path is None:
            raise FileNotFoundError(f"{entry.get('desc', key)}: todavía no está descargado (download.py)")
        return entry, path

    def heli():
        entry, path = site_file("heli_waypoints")
        return heli_places(path, bbox, entry.get("mission"))

    def samples():
        entry, path = site_file("sample_depot_locations")
        return sample_places(path, bbox, entry.get("mission"), entry.get("name"))

    attempt("iau", "Nomenclátor IAU/USGS", iau)
    attempt("robbins", "Cráteres de Robbins & Hynek 2012", robbins)
    attempt("rover", f"Waypoints de {rover_name} (MMGIS)", rover)
    # Fuentes que solo existen en algunos sitios: si el sitio no las declara, no aparecen.
    declared = {f["key"] for f in site["files"]}
    if "heli_waypoints" in declared:
        attempt("heli", "Aeródromos del helicóptero (MMGIS)", heli)
    if "sample_depot_locations" in declared:
        attempt("samples", next(f for f in site["files"] if f["key"] == "sample_depot_locations").get(
            "name", "Depósito de muestras"), samples)

    # Objetivos científicos: una sola fuente "targets" que junta todos los instrumentos del sitio.
    readers = {"chemcam_obs": chemcam_rows, "supercam_obs": supercam_rows,
               "pixl_inventory": label_target_rows}
    science = [f for f in site["files"] if f["key"] in readers or f["key"].startswith("apxs_targets")]
    if science:
        def targets():
            sources, missing = [], []
            positions = None
            for entry in science:
                # Los inventarios no son la lista: la arma fetch_targets.py en raw/<sitio>/targets/.
                if entry["key"] == "pixl_inventory":
                    path = DATA_DIR / "raw" / site["id"] / "targets" / f"{entry['key']}.csv"
                    path = path if path.exists() else None
                else:
                    path = local_raw(site["id"], entry)
                if path is None:
                    missing.append(entry.get("instrument") or entry["key"])
                    continue
                inst = entry.get("instrument") or entry["key"]
                if entry["key"].startswith("apxs_targets"):
                    sources.append((inst, entry.get("mission"), apxs_rows(path), None))
                    continue
                if positions is None:
                    try:
                        _, wp = site_file("rover_waypoints")
                    except FileNotFoundError:
                        wp = None
                    positions = rover_positions(wp) if wp else {}
                if not positions:
                    missing.append(f"posición del rover para {inst}")
                    continue
                sources.append((inst, entry.get("mission"), readers[entry["key"]](path), positions))
            if not sources:
                raise FileNotFoundError("Las listas de objetivos todavía no están descargadas: "
                                        + ", ".join(missing))
            got, unplaced = science_targets(sources, bbox)
            notes = [f"{n} observaciones de {i} sin posición del rover" for i, n in unplaced.items()]
            notes += [f"falta {m}" for m in missing]
            if notes:
                target_notes.extend(notes)
            return got

        target_notes = []
        attempt("targets", "Objetivos científicos con nombre (" + ", ".join(
            sorted({f.get("instrument") or f["key"] for f in science})) + ")", targets)
        if target_notes and sources_ok("targets"):
            sources["targets"]["note"] = "; ".join(target_notes)

    return {
        "site": site["id"],
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bbox": bbox,
        "sources": sources,
        "places": mark_suggested(places),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Índice de lugares de un sitio (places.json)")
    ap.add_argument("--site", required=True, help="id del sitio (nombre del JSON en sites/)")
    ap.add_argument("--out", help="carpeta base de salida (default: DATA_DIR/output)")
    args = ap.parse_args(argv)

    site_path = ROOT / "sites" / f"{args.site}.json"
    if not site_path.exists():
        log(f"No existe {site_path}")
        return 2
    site = json.loads(site_path.read_text())
    common = json.loads((ROOT / "sites" / "common.json").read_text())

    index = build(site, common)
    for key, s in index["sources"].items():
        log(f"{key}: {s['status']}" + (f" ({s['count']} lugares)" if "count" in s else f" · {s.get('error')}"))
    if not any(s["status"] == "ok" for s in index["sources"].values()):
        log("Ninguna fuente disponible: no escribo places.json")
        return 2

    out = (Path(args.out).expanduser() if args.out else DATA_DIR / "output") / site["id"]
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / ".places.json.tmp"
    tmp.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    os.replace(tmp, out / "places.json")   # nginx nunca sirve un archivo a medias
    log(f"Listo: {out / 'places.json'} ({len(index['places'])} lugares)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
