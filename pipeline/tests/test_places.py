"""places.py: índice de lugares para el buscador, con fuentes a medias."""
import io
import math
import json
import struct
import zipfile

import pytest

import places

BBOX = {"lat_min": 18.3, "lat_max": 18.7, "lon_min": 77.2, "lon_max": 77.6}
SITE = {"id": "jezero", "name": "Jezero", "rover": "Perseverance (Mars 2020)", "bbox": BBOX,
        "files": [{"key": "rover_waypoints", "mission": "Mars 2020",
                   "url": "https://example.invalid/M20_waypoints.json"}]}
COMMON = {"files": [{"key": "iau_names", "url": "https://example.invalid/MARS_nomenclature_center_pts.zip"}]}


def dbf_bytes(fields, rows):
    """dBase III mínimo: campos de texto, como el nomenclátor IAU."""
    rec_len = 1 + sum(l for _, l in fields)
    head = struct.pack("<BBBBIHH20x", 3, 26, 11, 14, len(rows), 32 + 32 * len(fields) + 1, rec_len)
    desc = b"".join(n.encode().ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([l]) + b"\0" * 15 for n, l in fields)
    body = b"".join(b" " + b"".join(str(r.get(n, "")).encode().ljust(l)[:l] for n, l in fields) for r in rows)
    return head + desc + b"\r" + body + b"\x1a"


def iau_zip(path, rows):
    fields = [("name", 40), ("center_lat", 20), ("center_lon", 20), ("diameter", 20),
              ("type", 30), ("approval", 30), ("link", 60)]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("MARS_nomenclature_center_pts.dbf", dbf_bytes(fields, rows))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.getvalue())


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    d.mkdir()
    monkeypatch.setattr(places, "DATA_DIR", d)
    return d


def test_norm_lon():
    assert places.norm_lon(77.4) == pytest.approx(77.4)
    assert places.norm_lon(282.6) == pytest.approx(-77.4)


def test_nothing_downloaded_reports_each_source(data_dir):
    index = places.build(SITE, COMMON)
    assert index["places"] == []
    assert {k: v["status"] for k, v in index["sources"].items()} == \
        {"iau": "missing", "robbins": "missing", "rover": "missing",
         "landmarks": "missing", "depressions": "missing", "crism": "missing"}


def test_main_without_sources_writes_nothing(data_dir):
    assert places.main(["--site", "jezero"]) == 2
    assert not (data_dir / "output").exists()


def test_iau_inside_bbox_only_and_adopted(data_dir):
    iau_zip(data_dir / "raw" / "common" / "MARS_nomenclature_center_pts.zip", [
        {"name": "Belva", "center_lat": "18.48", "center_lon": "77.38", "diameter": "0.9",
         "type": "Crater, craters", "approval": "Adopted by IAU",
         "link": "http://planetarynames.wr.usgs.gov/Feature/15872"},
        {"name": "Jezero", "center_lat": "18.41", "center_lon": "77.69", "diameter": "47.5",
         "type": "Crater, craters", "approval": "Adopted by IAU", "link": ""},     # fuera del bbox
        {"name": "Propuesto", "center_lat": "18.5", "center_lon": "77.4", "diameter": "",
         "type": "Crater, craters", "approval": "Dropped", "link": ""},
    ])
    index = places.build(SITE, COMMON)
    assert [p["name"] for p in index["places"]] == ["Belva"]
    belva = index["places"][0]
    assert belva["id"] == "iau-15872" and belva["detail"] == "Crater · 0,9 km"
    assert belva["provenance"] == "DERIVED" and belva["instrument"] == "Nomenclátor IAU"
    assert belva["suggested"] is True
    assert not any(k.startswith("_") for k in belva)


def test_iau_without_link_gets_url_safe_id(data_dir):
    iau_zip(data_dir / "raw" / "common" / "MARS_nomenclature_center_pts.zip", [
        {"name": "Señal Alta", "center_lat": "18.48", "center_lon": "77.38", "diameter": "0.5",
         "type": "Crater, craters", "approval": "Adopted by IAU", "link": ""}])
    (p,) = places.build(SITE, COMMON)["places"]
    assert p["id"] == "iau-señal-alta"        # sin espacios ni comas: viaja en ?pts=


def test_robbins_lon_0_360_and_bbox(data_dir):
    path = data_dir / "raw" / "jezero" / "landmarks" / "robbins_craters.geojson"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"features": [
        {"properties": {"craterid": "13-000001", "lon_e": 77.4, "lat": 18.5, "diamkm": 1.25}},
        {"properties": {"craterid": "13-000002", "lon_e": 79.0, "lat": 18.5, "diamkm": 3.0}},  # pad de 1°
        {"properties": {"craterid": "13-000003"}},                                               # roto
    ]}))
    index = places.build(SITE, COMMON)
    assert [p["id"] for p in index["places"]] == ["robbins-13-000001"]
    p = index["places"][0]
    assert p["name"] == "Cráter 13-000001" and "1,25 km" in p["detail"]
    assert p["mission"] == "Mars Odyssey" and p["suggested"] is False


def test_rover_dedupe_and_first_last_suggested(data_dir):
    path = data_dir / "raw" / "jezero" / "M20_waypoints.json"
    path.parent.mkdir(parents=True)
    wp = lambda rmc, sol, lat, lon: {"properties": {"RMC": rmc, "site": 1, "drive": 0, "sol": sol,
                                                    "lat": lat, "lon": lon}}
    path.write_text(json.dumps({"features": [
        wp("3_0", 13, 18.44, 77.45), wp("3_0", 13, 18.44, 77.45),     # repetido
        wp("4_10", 50, 18.45, 77.44), wp("5_0", 50, 18.46, 77.43),
        wp("9_0", 60, 18.0, 77.4),                                     # fuera del bbox
    ]}))
    index = places.build(SITE, COMMON)
    names = [p["name"] for p in index["places"]]
    assert names == ["Perseverance · sol 13", "Perseverance · sol 50", "Perseverance · sol 50"]
    sug = [p for p in index["places"] if p["suggested"]]
    assert [p["id"] for p in sug] == ["rover-3_0", "rover-5_0"]   # el último del archivo en el sol 50
    assert sug[1]["detail"].startswith("Última posición")
    assert index["places"][0]["mission"] == "Mars 2020"


def test_manifest_error_hides_partial_file(data_dir):
    """Si el manifest dice que la descarga falló, el archivo local puede estar a medias."""
    (data_dir / "raw" / "jezero").mkdir(parents=True)
    (data_dir / "raw" / "jezero" / "M20_waypoints.json").write_text("{\"features\": [")
    (data_dir / "manifest.json").write_text(json.dumps({"common": [], "sites": {"jezero": {"files": [
        {"key": "rover_waypoints", "status": "error"}]}}}))
    assert places.build(SITE, COMMON)["sources"]["rover"]["status"] == "missing"


def test_main_writes_atomically(data_dir):
    iau_zip(data_dir / "raw" / "common" / "MARS_nomenclature_center_pts.zip", [
        {"name": "Belva", "center_lat": "18.48", "center_lon": "77.38", "approval": "Adopted by IAU"}])
    assert places.main(["--site", "jezero"]) == 0
    out = data_dir / "output" / "jezero"
    assert sorted(p.name for p in out.iterdir()) == ["places.json"]
    index = json.loads((out / "places.json").read_text())
    assert index["site"] == "jezero" and index["sources"]["iau"]["status"] == "ok"


SITE_FULL = {**SITE, "files": SITE["files"] + [
    {"key": "heli_waypoints", "mission": "Mars 2020", "url": "https://example.invalid/m20_heli_waypoints.json"},
    {"key": "sample_depot_locations", "mission": "Mars 2020", "name": "Depósito Three Forks",
     "url": "https://example.invalid/sample_tube_locations.csv"},
]}


def test_optional_sources_only_when_declared(data_dir):
    assert set(places.build(SITE, COMMON)["sources"]) == {"iau", "robbins", "rover",
                                                         "landmarks", "depressions", "crism"}
    assert places.build(SITE_FULL, COMMON)["sources"]["heli"]["status"] == "missing"


def test_heli_airfields_last_landing(data_dir):
    path = data_dir / "raw" / "jezero" / "m20_heli_waypoints.json"
    path.parent.mkdir(parents=True)
    f = lambda flight, sol, to, lat, lon: {"properties": {"Flight": flight, "Sol": sol, "ToAirfld": to,
                                                          "Lat": lat, "Lon": lon}}
    path.write_text(json.dumps({"features": [
        f(0, 43, "Wright Brothers Field", 18.4448, 77.4510),
        f(1, 58, "Wright Brothers Field", 18.4449, 77.4511),
        f(2, 61, "Airfield Chi", 18.49, 77.32),
        f(3, 70, "Airfield Chi", 18.4972, 77.3225),
        f(4, 80, "", 18.5, 77.3),                        # sin nombre
        f(5, 90, "Afuera", 17.0, 77.3),                  # fuera del bbox
    ]}))
    got = {p["name"]: p for p in places.build(SITE_FULL, COMMON)["places"]}
    assert set(got) == {"Wright Brothers Field", "Airfield Chi"}
    assert got["Wright Brothers Field"]["detail"] == "Aeródromo de Ingenuity · despliegue y vuelo 1"
    chi = got["Airfield Chi"]
    assert (chi["lat"], chi["lon"]) == (18.4972, 77.3225)          # el último aterrizaje
    assert chi["detail"].startswith("Donde quedó Ingenuity") and chi["suggested"]
    assert got["Wright Brothers Field"]["suggested"] and chi["kind"] == "heli"


def test_sample_depot_tubes(data_dir):
    path = data_dir / "raw" / "jezero" / "sample_tube_locations.csv"
    path.parent.mkdir(parents=True)
    path.write_text(
        "Sample Designation,Sample Name,Dropoff Sol,Site,Drive,Rover Latitude,Rover Longitude,"
        "Rover Elevation,Sample Tube Azimuth\n"
        "M2020-00579-17,Mageik,655,32,250,18.4525234,77.40784692,-2545.479,144\n"
        "M2020-00337-08,Malay,653,32,148,18.45262651,77.40775601,-2545.263,325\n"
        "M2020-x,Roto,,32,1,,,0,0\n")
    got = places.build(SITE_FULL, COMMON)["places"]
    assert [p["name"] for p in got] == ["Mageik (Depósito Three Forks)", "Malay (Depósito Three Forks)"]
    malay = got[1]
    assert malay["id"] == "sample-M2020-00337-08" and malay["suggested"]   # el primero que soltó
    assert "sol 653" in malay["detail"] and malay["assumptions"]
    assert not got[0]["suggested"]


# ------------------------------------------------------------------ objetivos científicos

GALE = {"id": "gale", "name": "Gale", "rover": "Curiosity (MSL)",
        "bbox": {"lat_min": -5.1, "lat_max": -4.1, "lon_min": 137.1, "lon_max": 137.7},
        "files": [
            {"key": "rover_waypoints", "mission": "MSL", "url": "https://example.invalid/MSL_waypoints.json"},
            {"key": "chemcam_obs", "instrument": "ChemCam", "mission": "MSL",
             "url": "https://example.invalid/msl_ccam_obs.csv"},
            {"key": "apxs_targets_a", "instrument": "APXS", "mission": "MSL",
             "url": "https://example.invalid/apxs.csv"},
        ]}
CCAM_HEAD = ("Sol,EDR Type,Spacecraft Clock,EDR Filename,Type of Product,Target,Sequence,Autofocus,"
             "Distance (m),RMC Site,RMC Drive,Target Type\n")


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def gale_waypoints(data_dir):
    # Par real de MMGIS (site 2, drive 0): easting/northing y lat/lon del mismo punto.
    write(data_dir / "raw" / "gale" / "MSL_waypoints.json", json.dumps({"features": [
        {"properties": {"RMC": "2_0", "site": 2, "drive": 0, "sol": 3, "lat": -4.589467, "lon": 137.441633}},
        {"properties": {"RMC": "3_10", "site": 3, "drive": 10, "sol": 40, "lat": -4.59, "lon": 137.44}},
    ]}))


def test_apxs_northing_easting_match_mmgis(tmp_path):
    p = tmp_path / "apxs.csv"
    p.write_text("Sol,Target,Northing_m,Easting_m\n3,Punto,-272039.268,8146811.223\n")
    (r,) = list(places.apxs_rows(p))
    assert r["lat"] == pytest.approx(-4.589467, abs=1e-5)
    assert r["lon"] == pytest.approx(137.441633, abs=1e-5)


def test_apxs_column_variants(tmp_path):
    p = tmp_path / "apxs.csv"
    p.write_text("sol,Target,Strat_formation,Informal_waypoint/outcrop/region_name,Northing,Easting\n"
                 "3054,Nontron_triage,Carolyn_Shoemaker,Clay-Sulfate-Transition,-280688.55,8145086.98\n")
    (r,) = list(places.apxs_rows(p))
    assert r["sol"] == 3054 and r["context"] == ["Clay-Sulfate-Transition", "Carolyn Shoemaker"]


def test_supercam_rmc_from_edr_name(tmp_path):
    p = tmp_path / "scam.csv"
    p.write_text("﻿sol,targetname,edr_fname,focus_position_mm,Target_Type\n"
                 "12,Maaz,LS__0012_0668000000_000EA2__0030092SCAM01012_000_LUJ02.fits,2500,Bedrock\n"
                 "13,Sin_EDR,,2000,Bedrock\n")
    rows = list(places.supercam_rows(p))
    assert len(rows) == 1 and rows[0]["rmc"] == (3, 92) and rows[0]["distance_m"] == 2.5


def test_targets_merge_filter_and_position(data_dir):
    gale_waypoints(data_dir)
    write(data_dir / "raw" / "gale" / "msl_ccam_obs.csv", CCAM_HEAD +
          "19,CL5,1,a,b,Jake_Matijevic,s,No,3.1,2,0,Rock\n"
          "46,CL5,1,a,b,Jake_Matijevic,s,No,2.0,2,0,Rock\n"
          "20,CL5,1,a,b,Cal Target 10,s,No,1.5,2,0,Calibration Target\n"
          "21,CL5,1,a,b,SCCT_IR_black,s,No,1.5,2,0,Rock\n"
          "22,CL5,1,a,b,Cielo,s,No,0,2,0,Passive Sky\n"
          "30,CL5,1,a,b,LD_Paniri,s,No,47.8,3,10,Distant outcrop\n"
          "31,CL5,1,a,b,Perdido,s,No,2.0,9,99,Rock\n")
    write(data_dir / "raw" / "gale" / "apxs.csv",
          "Sol,Target,Informal waypoint/outcrop/region name,Northing_m,Easting_m\n"
          "46,Jake_Matijevic,Bradbury,-272096.65,8147031.41\n")
    index = places.build(GALE, COMMON)
    got = {p["name"]: p for p in index["places"] if p["kind"] == "target"}
    assert set(got) == {"Jake Matijevic", "LD Paniri"}       # sin calibración, cielo ni SCCT
    jake = got["Jake Matijevic"]
    assert jake["instrument"] == "APXS + ChemCam"
    assert jake["lat"] == pytest.approx(math.degrees(-272096.65 / places.MARS_RADIUS_M), abs=1e-6)
    assert jake["lat"] != pytest.approx(-4.589467, abs=1e-5)   # la de APXS, no la del rover
    assert "soles 19–46" in jake["detail"] and "Bradbury" in jake["detail"]
    far = got["LD Paniri"]
    assert far["detail"].startswith("observado desde acá a 48 m") and "no es el objetivo" not in far["detail"]
    assert "no el objetivo" in far["assumptions"][0]
    assert "1 observaciones de ChemCam sin posición" in index["sources"]["targets"]["note"]


def test_targets_without_waypoints_keep_apxs(data_dir):
    write(data_dir / "raw" / "gale" / "msl_ccam_obs.csv", CCAM_HEAD + "19,CL5,1,a,b,Roca,s,No,3,2,0,Rock\n")
    write(data_dir / "raw" / "gale" / "apxs.csv",
          "Sol,Target,Northing_m,Easting_m\n46,Jake_Matijevic,-272096.65,8147031.41\n")
    index = places.build(GALE, COMMON)
    assert [p["name"] for p in index["places"] if p["kind"] == "target"] == ["Jake Matijevic"]
    assert "posición del rover para ChemCam" in index["sources"]["targets"]["note"]


def test_pixl_targets_from_fetch_targets(data_dir):
    write(data_dir / "raw" / "jezero" / "M20_waypoints.json", json.dumps({"features": [
        {"properties": {"RMC": "4_1712", "site": 4, "drive": 1712, "sol": 125, "lat": 18.45, "lon": 77.40}}]}))
    write(data_dir / "raw" / "jezero" / "targets" / "pixl_inventory.csv",
          "obs_id,sol,site,drive,target\n0125_1,125,4,1712,Naltsos\n0126_1,126,4,1712,\n")
    site = {**SITE, "files": SITE["files"] + [
        {"key": "pixl_inventory", "instrument": "PIXL", "mission": "Mars 2020",
         "url": "https://example.invalid/inventory.csv"}]}
    got = [p for p in places.build(site, COMMON)["places"] if p["kind"] == "target"]
    assert [(p["name"], p["instrument"]) for p in got] == [("Naltsos", "PIXL")]
    assert "0.0 m" not in got[0]["assumptions"][0]          # la distancia no la mide nadie
    assert "al alcance del brazo" in got[0]["assumptions"][0]
    assert "observado desde acá" not in got[0]["detail"]


def test_same_target_with_underscore_or_space_is_one_place(data_dir):
    # ChemCam escribe "John_Klein"; las etiquetas de PIXL, "John Klein": mismo id, un solo lugar.
    gale_waypoints(data_dir)
    write(data_dir / "raw" / "gale" / "msl_ccam_obs.csv", CCAM_HEAD + "182,CL5,1,a,b,John_Klein,s,No,2.5,2,0,Rock\n")
    write(data_dir / "raw" / "gale" / "targets" / "pixl_inventory.csv",
          "obs_id,sol,site,drive,target\n0200_1,200,2,0,John Klein\n")
    site = {**GALE, "files": GALE["files"][:2] + [
        {"key": "pixl_inventory", "instrument": "PIXL", "mission": "MSL",
         "url": "https://example.invalid/inventory.csv"}]}
    got = [p for p in places.build(site, COMMON)["places"] if p["kind"] == "target"]
    assert [p["id"] for p in got] == ["target-john-klein"]
    assert got[0]["instrument"] == "ChemCam + PIXL"


def test_unknown_distance_does_not_beat_known_one():
    obs = [{"name": "Roca", "type": None, "sol": 1, "rmc": (1, 1), "distance_m": None},
           {"name": "Roca", "type": None, "sol": 2, "rmc": (2, 2), "distance_m": 15.0}]
    positions = {(1, 1): (18.40, 77.30), (2, 2): (18.50, 77.40)}
    (p,), _ = places.science_targets([("ChemCam", "MSL", obs, positions)], BBOX)
    assert (p["lat"], p["lon"]) == (18.5, 77.4)
    assert p["detail"].startswith("observado desde acá a 15 m")


def test_suggested_targets_best_placed_and_most_measured(data_dir):
    gale_waypoints(data_dir)
    write(data_dir / "raw" / "gale" / "msl_ccam_obs.csv", CCAM_HEAD +
          "19,CL5,1,a,b,Jake_Matijevic,s,No,3.1,2,0,Rock\n"
          "20,CL5,1,a,b,Cerca,s,No,2.0,2,0,Rock\n"
          "30,CL5,1,a,b,LD_Paniri,s,No,47.8,3,10,Distant outcrop\n")
    write(data_dir / "raw" / "gale" / "apxs.csv",
          "Sol,Target,Northing_m,Easting_m\n46,Jake_Matijevic,-272096.65,8147031.41\n")
    got = {p["name"]: p for p in places.build(GALE, COMMON)["places"] if p["kind"] == "target"}
    assert got["Jake Matijevic"]["suggested"] and got["Cerca"]["suggested"]
    assert not got["LD Paniri"]["suggested"]                # observado de lejos: no es un destino claro
    assert not any(k.startswith("_") for p in got.values() for k in p)


# --- Cerros, hondonadas y observaciones CRISM ---------------------------------------------

def _hill_grid(n=200, cell=10.0):
    import numpy as np
    yy, xx = np.mgrid[0:n, 0:n] * cell
    z = np.zeros((n, n))
    z += 60 * np.exp(-((xx - 600) ** 2 + (yy - 600) ** 2) / (2 * 120.0 ** 2))   # cerro de 60 m
    z += 10 * np.exp(-((xx - 1500) ** 2 + (yy - 1500) ** 2) / (2 * 120.0 ** 2))  # loma de 10 m
    z -= 20 * np.exp(-((xx - 1400) ** 2 + (yy - 500) ** 2) / (2 * 40.0 ** 2))    # hondonada de 20 m
    return z


def test_find_peaks_keeps_high_hill_only():
    pytest.importorskip("scipy")
    z = _hill_grid()
    peaks = places.find_peaks(z, 10.0)
    assert len(peaks) == 1
    r, c, relief = peaks[0]
    assert (r, c) == (60, 60) and relief > 50


def test_find_peaks_on_negated_grid_finds_pit():
    pytest.importorskip("scipy")
    z = _hill_grid()
    pits = places.find_peaks(-z, 10.0, radius_m=150, min_relief_m=8)
    assert [(r, c) for r, c, _ in pits] == [(50, 140)]


def test_find_peaks_ignores_circles_touching_nodata():
    pytest.importorskip("scipy")
    import numpy as np
    z = _hill_grid()
    z[55:65, 40:50] = np.nan   # hueco dentro del círculo del cerro: no se sabe si sigue subiendo
    assert places.find_peaks(z, 10.0) == []


MARS_R = 3396190.0
EQC = f"+proj=eqc +lat_ts=0 +lon_0=0 +R={MARS_R:.0f} +units=m +no_defs"


def write_dtm(path, z, lon0=77.3, lat0=18.6, cell=10.0):
    """GeoTIFF chico como el dtm.tif de precompute.py: equirectangular de Marte, esquina NO en lon0/lat0."""
    rasterio = pytest.importorskip("rasterio")
    from rasterio.transform import from_origin
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    x0, y0 = math.radians(lon0) * MARS_R, math.radians(lat0) * MARS_R
    with rasterio.open(path, "w", driver="GTiff", width=z.shape[1], height=z.shape[0], count=1,
                       dtype="float32", crs=EQC, transform=from_origin(x0, y0, cell, cell),
                       nodata=-3.4e38) as ds:
        ds.write(np.where(np.isfinite(z), z, -3.4e38).astype("float32"), 1)


def lonlat_at(x_m, y_m, lon0=77.3, lat0=18.6):
    """lon/lat de un punto a x_m al este y y_m al sur de la esquina de write_dtm."""
    return lon0 + math.degrees(x_m / MARS_R), lat0 - math.degrees(y_m / MARS_R)


def test_dtm_places_stable_ids_and_one_read(data_dir, monkeypatch):
    pytest.importorskip("scipy")
    write_dtm(data_dir / "output" / "jezero" / "dtm.tif", _hill_grid())
    reads = []
    real = places.read_dtm_coarse
    monkeypatch.setattr(places, "read_dtm_coarse", lambda *a, **k: reads.append(1) or real(*a, **k))

    index = places.build(SITE, COMMON)
    assert len(reads) == 1                       # cerros y hondonadas comparten la lectura
    got = {p["kind"]: p for p in index["places"]}
    hill, pit = got["landmark"], got["depression"]
    assert hill["id"] == f"landmark-{hill['lat']:.4f}-{hill['lon']:.4f}"
    assert pit["id"] == f"depression-{pit['lat']:.4f}-{pit['lon']:.4f}"
    assert hill["name"] == "Cerro sin nombre 1" and hill["resolution"] == "DTM de 1 m leído a 30 m"
    assert hill["suggested"] and not pit["suggested"]
    lon, lat = lonlat_at(600, 600)
    assert hill["lon"] == pytest.approx(lon, abs=3e-4) and hill["lat"] == pytest.approx(lat, abs=3e-4)
    lon, lat = lonlat_at(1405, 505)
    assert pit["lon"] == pytest.approx(lon, abs=3e-4) and pit["lat"] == pytest.approx(lat, abs=3e-4)
    assert index["sources"]["landmarks"]["status"] == "ok"


def test_landmarks_numbered_after_bbox_filter(data_dir):
    pytest.importorskip("scipy")
    import numpy as np
    yy, xx = np.mgrid[0:200, 0:200] * 10.0
    z = 60 * np.exp(-((xx - 600) ** 2 + (yy - 600) ** 2) / (2 * 120.0 ** 2))     # cerro de 60 m, adentro
    z += 90 * np.exp(-((xx - 1400) ** 2 + (yy - 1400) ** 2) / (2 * 120.0 ** 2))  # el más alto, afuera
    write_dtm(data_dir / "output" / "jezero" / "dtm.tif", z)
    lon_cut, _ = lonlat_at(1000, 0)
    site = {**SITE, "bbox": {**BBOX, "lon_max": lon_cut}}
    hills = [p for p in places.build(site, COMMON)["places"] if p["kind"] == "landmark"]
    assert [p["name"] for p in hills] == ["Cerro sin nombre 1"]   # sin hueco por el que quedó afuera


def test_two_highest_landmarks_suggested():
    hills = [{"kind": "landmark", "id": f"landmark-{r}", "_relief": r} for r in (40, 90, 35, 60)]
    places.mark_suggested(hills)
    assert {p["id"] for p in hills if p["suggested"]} == {"landmark-90", "landmark-60"}
    assert not any(k.startswith("_") for p in hills for k in p)


# CRISM: browse MTRDR como los de PDS (ENVI .img/.hdr + etiqueta PDS3 .lbl).
CRISM_CRS = ('PROJCS["MRO Mars Equirectangular [IAU 2000] [15.00N; 0.00E]",GEOGCS["GCS_Mars_2000",'
             'DATUM["D_Mars_2000",SPHEROID["Mars_2000_sphere",3394839.813316312,0.0]],'
             'PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]],'
             'PROJECTION["Equidistant_Cylindrical"],PARAMETER["False_Easting",0.0],'
             'PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],'
             'PARAMETER["Standard_Parallel_1",15.0],UNIT["Meter",1.0]]')
CRISM_R = 3394839.813316312
PHY = {"D2300": (0.0, 1.3358e-4), "D2200": (2.5e-3, 6.8627e-05), "BD1900R2": (0.0, 6.5738e-04)}


def write_browse(folder, obs, bands, lon0=77.4, lat0=18.5, px=18.0):
    """bands: {parámetro: dn (60 × 60 uint8)}. Esquina NO de la escena en lon0/lat0."""
    import numpy as np

    folder.mkdir(parents=True, exist_ok=True)
    stem = folder / f"{obs}_07_brphyj_mtr3"
    names = list(bands)
    h, w = bands[names[0]].shape
    np.stack([bands[n] for n in names]).astype("uint8").tofile(stem.with_suffix(".img"))
    x0 = math.radians(lon0) * CRISM_R * math.cos(math.radians(15))
    y0 = math.radians(lat0) * CRISM_R
    stem.with_suffix(".hdr").write_text(
        f"ENVI\nsamples = {w}\nlines = {h}\nbands = {len(names)}\nheader offset = 0\n"
        "file type = ENVI Standard\ndata type = 1\ninterleave = bsq\nbyte order = 0\n"
        f"map info = {{Equirectangular, 1.0000, 1.0000, {x0}, {y0}, {px}, {px}, units=Meters}}\n"
        f"coordinate system string = {{{CRISM_CRS}}}\ndata ignore value = 255\n"
        f"band names = {{\n {', '.join(names)}}}\n")
    fmt = lambda vals: "( " + ", ".join(f"{v:.4E}" for v in vals) + ")"
    stem.with_suffix(".lbl").write_text(
        "PDS_VERSION_ID = PDS3\nOBJECT = IMAGE\n"
        f'  BAND_NAME            = ( {", ".join(chr(34) + n + chr(34) for n in names)})\n'
        f"  OFFSET               = {fmt(PHY[n][0] for n in names)}\n"
        f"  SCALING_FACTOR       = {fmt(PHY[n][1] for n in names)}\n"
        "END_OBJECT = IMAGE\n  LINE_PROJECTION_OFFSET       = 30832.0416667 <PIXEL>\n")


def scene(background=10):
    import numpy as np
    dn = np.full((60, 60), background, dtype="uint8")
    dn[:3, :] = dn[-3:, :] = dn[:, :3] = dn[:, -3:] = 255   # fuera de la escena
    return dn


def test_crism_hotspot_threshold_edges_and_dedup(tmp_path):
    pytest.importorskip("rasterio")
    pytest.importorskip("scipy")
    folder = tmp_path / "crism"
    d2300, d2200, bd1900 = scene(), scene(), scene()
    d2300[28:33, 38:43] = 200          # 0,027 ≥ 0,01: se marca
    d2200[4:9, 30:35] = 254            # fuerte pero pegado al borde de la escena: no
    bd1900[20, 20] = 254               # un píxel suelto: la mediana lo borra
    bd1900[38:43, 18:23] = 254         # saturado: el valor real puede ser mayor
    write_browse(folder, "frt00005c5e", {"D2300": d2300, "D2200": d2200, "BD1900R2": bd1900})
    weaker = scene()
    weaker[28:33, 38:43] = 150         # otra observación, mismo lugar, más débil: se descarta
    write_browse(folder, "frt000047a3", {"D2300": weaker, "D2200": scene(), "BD1900R2": scene()})
    (folder / "notes_br_weird.lbl").write_text("no es un browse")
    (folder / "index.json").write_text(json.dumps([
        {"pdsid": "frt00005c5e_07_if166j_mtr3", "comment": "COORD Target - 2986 Depositional Fan"}]))

    got = {p["id"]: p for p in places.crism_places(folder, BBOX)}
    assert set(got) == {"crism-frt00005c5e-d2300", "crism-frt00005c5e-bd1900r2"}
    phy = got["crism-frt00005c5e-d2300"]
    assert phy["kind"] == "orbital" and phy["provenance"] == "DERIVED" and phy["instrument"] == "CRISM"
    assert phy["detail"] == "D2300 = 0,027, lo más fuerte de FRT00005C5E · objetivo de MRO: Depositional Fan"
    assert phy["resolution"] == "18 m/px, mediana de 5 × 5 px"
    lon = 77.4 + math.degrees(40.5 * 18 / (CRISM_R * math.cos(math.radians(15))))
    lat = 18.5 - math.degrees(30.5 * 18 / CRISM_R)
    assert phy["lon"] == pytest.approx(lon, abs=1e-5) and phy["lat"] == pytest.approx(lat, abs=1e-5)
    assert got["crism-frt00005c5e-bd1900r2"]["detail"].startswith("BD1900R2 ≥ 0,167")
    assert any("no es una identificación mineral" in a for a in phy["assumptions"])


def test_crism_without_reasons_or_outside_bbox(tmp_path):
    pytest.importorskip("rasterio")
    pytest.importorskip("scipy")
    folder = tmp_path / "crism"
    dn = scene()
    dn[28:33, 38:43] = 200
    write_browse(folder, "hrl000040ff", {"D2300": dn})
    (p,) = places.crism_places(folder, BBOX)
    assert p["detail"] == "D2300 = 0,027, lo más fuerte de HRL000040FF"
    assert places.crism_places(folder, {**BBOX, "lat_min": 18.6}) == []


def test_crism_same_param_numbered_by_strength(tmp_path):
    pytest.importorskip("rasterio")
    pytest.importorskip("scipy")
    folder = tmp_path / "crism"
    weak, strong = scene(), scene()
    weak[28:33, 38:43] = 150
    strong[28:33, 38:43] = 200
    write_browse(folder, "frt000047a3", {"D2300": weak}, lon0=77.30)    # a ~6 km: no se deduplican
    write_browse(folder, "frt00005c5e", {"D2300": strong}, lon0=77.40)
    got = places.crism_places(folder, BBOX)
    assert [(p["id"], p["name"]) for p in got] == [
        ("crism-frt00005c5e-d2300", "Señal de Fe/Mg-filosilicatos 1 (D2300)"),
        ("crism-frt000047a3-d2300", "Señal de Fe/Mg-filosilicatos 2 (D2300)"),
    ]
    assert all("El número solo las ordena por intensidad" in p["assumptions"] for p in got)


def test_crism_without_browse_is_missing(tmp_path):
    (tmp_path / "crism").mkdir()
    with pytest.raises(FileNotFoundError):
        places.crism_places(tmp_path / "crism", BBOX)


def test_missing_dtm_reports_landmarks_missing(data_dir):
    index = places.build(SITE, COMMON)
    assert index["sources"]["landmarks"]["status"] == "missing"
    assert index["sources"]["depressions"]["status"] == "missing"
    assert index["sources"]["crism"]["status"] == "missing"
