"""precompute.py: datos que faltan, pendiente sobre píxeles anisótropos y una corrida completa.

La corrida completa necesita las herramientas de GDAL (gdal_translate, gdaldem, gdal_contour,
ogr2ogr): se saltea si no están instaladas.
"""
import json
import math
import shutil

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

import precompute

R = 3396190.0
# La misma proyección que los DTM de USGS: equirectangular con paralelo estándar en el ecuador.
EQC_LATTS0 = "+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs"
LAT0, LON0 = 18.55, 77.45  # borde noroeste, cerca de Jezero
NODATA = -3.4028226550889045e38
JEZERO_DTM = "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"


def write_dtm(path, z, px=1.0):
    h, w = z.shape
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32",
                       crs=EQC_LATTS0, nodata=NODATA,
                       transform=from_origin(R * math.radians(LON0), R * math.radians(LAT0), px, px)) as ds:
        ds.write(z.astype(np.float32), 1)
    return path


def row_lat_deg(rows, px=1.0):
    return LAT0 - np.degrees((rows + 0.5) * px / R)


def tilted_plane(n, deg, direction, px=1.0):
    """Plano con pendiente real `deg` sobre el suelo, subiendo hacia el este ('e') o el sur ('s')."""
    rows, cols = np.mgrid[0:n, 0:n].astype(float)
    if direction == "e":
        # en eqc con lat_ts=0, un paso de columna mide px·cos(lat) sobre el suelo
        ground = cols * px * np.cos(np.radians(row_lat_deg(rows, px)))
    else:
        ground = rows * px
    return -2500.0 + math.tan(math.radians(deg)) * ground


def read_slope(path):
    with rasterio.open(path) as ds:
        return ds.read(1), ds.nodata


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(precompute, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(precompute, "ENV_FILE", tmp_path / "no-existe.env")
    monkeypatch.delenv("BUCKET", raising=False)
    (tmp_path / "data").mkdir()
    return tmp_path / "data"


def write_manifest(data_dir, status, path="raw/jezero/dtm.tif"):
    (data_dir / "manifest.json").write_text(json.dumps({"sites": {"jezero": {"files": [
        {"key": "dtm", "status": status, "path": path}]}}}))


# ------------------------------------------------------------------ datos que faltan

class TestDataNotReady:
    def test_unknown_site(self, data_dir):
        assert precompute.main(["--site", "olympus-mons"]) == 2

    def test_nothing_downloaded_and_no_bucket(self, data_dir):
        assert precompute.main(["--site", "jezero"]) == 2
        assert not (data_dir / "output").exists()

    def test_partial_download_is_not_used(self, data_dir):
        # el manifest dice que la descarga falló: el archivo local puede estar truncado
        write_manifest(data_dir, "error", f"raw/jezero/{JEZERO_DTM}")
        (data_dir / "raw" / "jezero").mkdir(parents=True)
        (data_dir / "raw" / "jezero" / JEZERO_DTM).write_bytes(b"a medio bajar")
        site = precompute.load_site("jezero")
        with pytest.raises(precompute.DataNotReady):
            precompute.find_input(site, "dtm")

    def test_partial_download_falls_back_to_s3(self, data_dir, monkeypatch):
        write_manifest(data_dir, "error", f"raw/jezero/{JEZERO_DTM}")
        (data_dir / "raw" / "jezero").mkdir(parents=True)
        (data_dir / "raw" / "jezero" / JEZERO_DTM).write_bytes(b"a medio bajar")
        monkeypatch.setenv("BUCKET", "bucket-de-prueba")
        src = precompute.find_input(precompute.load_site("jezero"), "dtm")
        assert src == f"/vsis3/bucket-de-prueba/raw/jezero/{JEZERO_DTM}"

    def test_manifest_ok_wins(self, data_dir):
        write_manifest(data_dir, "ok", "raw/jezero/otro_nombre.tif")
        (data_dir / "raw" / "jezero").mkdir(parents=True)
        (data_dir / "raw" / "jezero" / "otro_nombre.tif").write_bytes(b"x")
        assert precompute.find_input(precompute.load_site("jezero"), "dtm") == \
            str(data_dir / "raw" / "jezero" / "otro_nombre.tif")

    def test_raw_without_manifest(self, data_dir):
        (data_dir / "raw" / "jezero").mkdir(parents=True)
        (data_dir / "raw" / "jezero" / JEZERO_DTM).write_bytes(b"x")
        assert precompute.find_input(precompute.load_site("jezero"), "dtm") == \
            str(data_dir / "raw" / "jezero" / JEZERO_DTM)

    def test_bucket_from_env_file(self, data_dir, tmp_path, monkeypatch):
        env = tmp_path / "mapeando.env"
        env.write_text('OTRA=1\nexport BUCKET="bucket-de-prueba"\n')
        monkeypatch.setattr(precompute, "ENV_FILE", env)
        assert precompute.find_input(precompute.load_site("jezero"), "dtm") == \
            f"/vsis3/bucket-de-prueba/raw/jezero/{JEZERO_DTM}"


# ------------------------------------------------------------------ pendiente

class TestSlope:
    @pytest.mark.parametrize("direction", ["e", "s"])
    @pytest.mark.parametrize("deg", [5.0, 20.0, 30.0, 45.0])
    def test_plane_on_eqc_lat_ts0(self, tmp_path, deg, direction):
        """A 18,5° N un píxel de 1 m de la proyección mide 0,948 m sobre el suelo hacia el este.
        gdaldem daría 28,7° para 30° reales hacia el este; acá tiene que dar 30°."""
        dtm = write_dtm(tmp_path / "dtm.tif", tilted_plane(120, deg, direction))
        info = precompute.compute_slope(dtm, tmp_path / "slope.tif")
        s, nodata = read_slope(tmp_path / "slope.tif")
        inner = s[1:-1, 1:-1]
        assert np.allclose(inner, deg, atol=0.01), (inner.min(), inner.max())
        assert info["pixel_ground_m"][0] == pytest.approx(math.cos(math.radians(LAT0 - 60 / R * 180 / math.pi)),
                                                          abs=1e-3)
        assert info["pixel_ground_m"][1] == pytest.approx(1.0, abs=1e-6)

    def test_edges_have_no_data(self, tmp_path):
        dtm = write_dtm(tmp_path / "dtm.tif", tilted_plane(40, 10.0, "e"))
        precompute.compute_slope(dtm, tmp_path / "slope.tif")
        s, nodata = read_slope(tmp_path / "slope.tif")
        for edge in (s[0], s[-1], s[:, 0], s[:, -1]):
            assert (edge == nodata).all()

    def test_hole_in_dtm_stays_a_hole(self, tmp_path):
        z = tilted_plane(40, 10.0, "e")
        z[20, 20] = NODATA
        dtm = write_dtm(tmp_path / "dtm.tif", z)
        precompute.compute_slope(dtm, tmp_path / "slope.tif")
        s, nodata = read_slope(tmp_path / "slope.tif")
        assert (s[19:22, 19:22] == nodata).all()
        mask = np.ones_like(s, bool)
        mask[19:22, 19:22] = False
        mask[0], mask[-1], mask[:, 0], mask[:, -1] = False, False, False, False
        assert np.allclose(s[mask], 10.0, atol=0.01)

    def test_strips_do_not_leave_seams(self, tmp_path, monkeypatch):
        rng = np.random.default_rng(0)
        z = -2500 + np.cumsum(rng.normal(size=(60, 50)), axis=0)
        dtm = write_dtm(tmp_path / "dtm.tif", z)
        precompute.compute_slope(dtm, tmp_path / "one.tif")
        monkeypatch.setattr(precompute, "STRIP_PX", 50 * 7)  # franjas de 7 filas
        precompute.compute_slope(dtm, tmp_path / "strips.tif")
        assert np.array_equal(read_slope(tmp_path / "one.tif")[0], read_slope(tmp_path / "strips.tif")[0])


# ------------------------------------------------------------------ corrida completa

GDAL_TOOLS = ("gdalinfo", "gdal_translate", "gdaldem", "gdal_contour", "ogr2ogr", "gdalwarp",
              "gdal2tiles.py", "gdal_edit.py")
# Colores de las clases de pendiente (web/src/map/layers.ts, SLOPE_CLASSES) y transparente.
LEGEND_RGBA = {(47, 125, 79, 255), (224, 162, 74, 255), (224, 122, 74, 255), (224, 86, 74, 255), (0, 0, 0, 0)}
needs_gdal = pytest.mark.skipif(not all(shutil.which(t) for t in GDAL_TOOLS),
                                reason="sin las herramientas de línea de comandos de GDAL")


def tile_pixel(folder, z, lon, lat):
    """RGBA del píxel de un tile XYZ (esquema Web Mercator de MapLibre) que cae en (lon, lat)."""
    n = 2 ** z
    fx = (lon + 180) / 360 * n
    fy = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    x, y = int(fx), int(fy)
    with rasterio.open(folder / str(z) / str(x) / f"{y}.png") as ds:
        a = ds.read()
    return tuple(int(v) for v in a[:, int((fy - y) * 256), int((fx - x) * 256)])


def tile_colors(folder):
    colors = set()
    for png in folder.rglob("*.png"):
        with rasterio.open(png) as ds:
            a = ds.read()
        colors |= {tuple(int(v) for v in c) for c in a.reshape(a.shape[0], -1).T}
    return colors


def crater(n=300, px=1.0):
    """Cráter de 100 m de radio y 60 m de profundidad, con un hueco sin dato."""
    yy, xx = np.mgrid[0:n, 0:n] * px
    rr = np.hypot(xx - n * px / 2, yy - n * px / 2)
    z = -2500 - 60 * np.clip(1 - (rr / 100.0) ** 2, 0, None)
    z[10:20, 10:20] = NODATA
    return z


@needs_gdal
def test_full_run(data_dir):
    write_dtm(data_dir / "raw" / "jezero" / "dtm.tif", crater())
    write_manifest(data_dir, "ok")
    assert precompute.main(["--site", "jezero"]) == 0

    out = data_dir / "output" / "jezero"
    # sin carpetas de trabajo sueltas: nginx sirve todo lo que quede acá
    assert sorted(p.name for p in out.iterdir()) == \
        ["contours.geojson", "coverage.geojson", "dose", "dose_rate.tif", "dtm.tif", "hazard",
         "hazard.tif", "hillshade", "hillshade.tif", "roughness.tif", "skyview.tif", "slope",
         "slope.tif", "terrain.json", "terrain_factor.tif"]

    index = json.loads((out / "terrain.json").read_text())
    assert {k: v["status"] for k, v in index["layers"].items()} == {
        "dtm": "ok", "relief-slope": "ok", "relief-hillshade": "ok", "relief-contours": "ok",
        "survival-hazard": "ok", "terrain-roughness": "ok", "terrain-factor": "ok",
        "survival-dose": "ok", "survival-skyview": "ok", "coverage": "ok"}
    dose = index["layers"]["survival-dose"]
    assert dose["unit"] == "µSv/h" and dose["display"] == "budget" and dose["instrument"] == "RAD"
    assert any("dem200" in w for w in index["warnings"])  # el test no tiene DEM de 200 m: sigue con aviso
    hazard = index["layers"]["survival-hazard"]
    assert hazard["provenance"] == "DERIVED" and hazard["instrument"] == "HiRISE DTM" and hazard["resolution"]
    assert "error" not in index["layers"]["terrain-roughness"]
    assert index["radius_m"] == R
    assert index["source"]["mission"] == "MRO HiRISE"
    assert any("0.948" in w for w in index["warnings"])  # píxel anisótropo declarado

    for name in ("dtm.tif", "slope.tif", "hillshade.tif", "hazard.tif", "roughness.tif", "terrain_factor.tif"):
        with rasterio.open(out / name) as ds:
            assert ds.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG", name
            assert (ds.width, ds.height) == (300, 300)

    for layer_id, folder in (("relief-slope", "slope"), ("relief-hillshade", "hillshade"),
                             ("survival-hazard", "hazard"), ("survival-dose", "dose")):
        t = index["layers"][layer_id]["tiles"]
        assert t["status"] == "ok" and t["template"] == f"{folder}/{{z}}/{{x}}/{{y}}.png"
        assert (out / folder / str(t["maxzoom"])).is_dir() and t["minzoom"] <= t["maxzoom"]
        w, s, e, n = t["bounds"]
        assert w == pytest.approx(LON0) and n == pytest.approx(LAT0)
        assert e == pytest.approx(LON0 + math.degrees(300 / R)) and s == pytest.approx(LAT0 - math.degrees(300 / R))

    # La pendiente se pinta solo con los colores de la leyenda, y en el lugar correcto:
    # fondo plano del cráter verde, pared norte (~45°) roja.
    slope_tiles = out / "slope"
    assert tile_colors(slope_tiles) <= LEGEND_RGBA
    zmax = index["layers"]["relief-slope"]["tiles"]["maxzoom"]
    c_lon, c_lat = LON0 + math.degrees(150 / R), LAT0 - math.degrees(150 / R)
    assert tile_pixel(slope_tiles, zmax, c_lon, c_lat) == (47, 125, 79, 255)
    assert tile_pixel(slope_tiles, zmax, c_lon, c_lat + math.degrees(90 / R)) == (224, 86, 74, 255)

    # Tiles de dosis: solo los cuatro tonos de la escala fija (= leyenda de survival-dose).
    dose_rgba = {(*map(int, c.split()), 255) for _, _, c in precompute.tiles.RAMPAS["dosis"]} | {(0, 0, 0, 0)}
    assert tile_colors(out / "dose") <= dose_rgba

    # La dosis va en su propia grilla de 100 m (no la del DTM), también en COG.
    for name in ("skyview.tif", "dose_rate.tif"):
        with rasterio.open(out / name) as ds:
            assert ds.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
            assert ds.res == (100.0, 100.0)

    # El peligro también, con los colores de su leyenda (los mismos que la pendiente) y sin
    # colores intermedios: es un raster por clases. Fondo del cráter bajo, pared no transitable.
    hazard_tiles = out / "hazard"
    assert tile_colors(hazard_tiles) <= LEGEND_RGBA
    zmax = index["layers"]["survival-hazard"]["tiles"]["maxzoom"]
    assert tile_pixel(hazard_tiles, zmax, c_lon, c_lat) == (47, 125, 79, 255)
    assert tile_pixel(hazard_tiles, zmax, c_lon, c_lat + math.degrees(90 / R)) == (224, 86, 74, 255)

    gj = json.loads((out / "contours.geojson").read_text())
    elevs = {f["properties"]["elev"] for f in gj["features"]}
    assert elevs and all(e % precompute.CONTOUR_INTERVAL_M == 0 for e in elevs)
    lon, lat = gj["features"][0]["geometry"]["coordinates"][0]
    assert LON0 < lon < LON0 + 0.01 and LAT0 - 0.01 < lat < LAT0  # lon/lat de Marte, no metros


@needs_gdal
def test_prueba_crops_the_center_outside_output(data_dir, monkeypatch):
    write_dtm(data_dir / "raw" / "jezero" / "dtm.tif", crater())
    write_manifest(data_dir, "ok")
    monkeypatch.setattr(precompute, "PRUEBA_PX", 50)
    assert precompute.main(["--site", "jezero", "--prueba"]) == 0
    assert not (data_dir / "output").exists()  # nginx sirve output/: la prueba no va ahí
    with rasterio.open(data_dir / "prueba" / "jezero" / "dtm.tif") as ds:
        assert (ds.width, ds.height) == (50, 50)
    index = json.loads((data_dir / "prueba" / "jezero" / "terrain.json").read_text())
    assert index["mode"] == "prueba" and index["source"]["srcwin"] == [125, 125, 50, 50]


@needs_gdal
def test_a_failed_layer_does_not_stop_the_others(data_dir, monkeypatch):
    write_dtm(data_dir / "raw" / "jezero" / "dtm.tif", crater())
    write_manifest(data_dir, "ok")
    real_run = precompute.run

    def run(cmd):
        if cmd[0] == "gdal_contour":
            raise precompute.subprocess.CalledProcessError(1, cmd)
        real_run(cmd)

    monkeypatch.setattr(precompute, "run", run)
    assert precompute.main(["--site", "jezero"]) == 1
    out = data_dir / "output" / "jezero"
    index = json.loads((out / "terrain.json").read_text())
    assert index["layers"]["relief-contours"]["status"] == "error"
    assert index["layers"]["relief-slope"]["status"] == "ok"
    assert index["layers"]["survival-hazard"]["status"] == "ok"  # no depende de las curvas
    assert not (out / "contours.geojson").exists() and not (out / ".work").exists()


# ------------------------------------------------------------------ ortoimagen

@needs_gdal
def test_sin_ortho_no_aparece_la_capa(data_dir):
    """Sin --ortho no se registra base-ortho: el mapa no muestra una capa fantasma."""
    write_dtm(data_dir / "raw" / "jezero" / "dtm.tif", crater())
    write_manifest(data_dir, "ok")
    assert precompute.main(["--site", "jezero"]) == 0
    index = json.loads((data_dir / "output" / "jezero" / "terrain.json").read_text())
    assert "base-ortho" not in index["layers"]


@needs_gdal
def test_ortho_sin_descargar_no_frena_el_relieve(data_dir):
    """Con --ortho pero sin la imagen bajada: la capa queda en error y el resto sale igual."""
    write_dtm(data_dir / "raw" / "jezero" / "dtm.tif", crater())
    write_manifest(data_dir, "ok")  # el manifest solo tiene el DTM
    assert precompute.main(["--site", "jezero", "--ortho"]) == 1
    index = json.loads((data_dir / "output" / "jezero" / "terrain.json").read_text())
    assert index["layers"]["base-ortho"]["status"] == "error"
    assert index["layers"]["relief-slope"]["status"] == "ok"
    assert index["layers"]["relief-hillshade"]["tiles"]["status"] == "ok"


def test_ortho_and_relief_have_separate_max_zoom(data_dir, monkeypatch):
    """--max-zoom es del relieve y --ortho-max-zoom de la ortoimagen: uno no pisa al otro.

    No necesita GDAL: se reemplazan las llamadas a las herramientas y se mira qué tope de
    zoom le llega a cada teselado.
    """
    write_dtm(data_dir / "raw" / "jezero" / "dtm.tif", crater(n=60))
    (data_dir / "raw" / "jezero" / "ortho.tif").write_bytes(b"")  # no se lee: el teselado es falso
    (data_dir / "manifest.json").write_text(json.dumps({"sites": {"jezero": {"files": [
        {"key": "dtm", "status": "ok", "path": "raw/jezero/dtm.tif"},
        {"key": "ortho", "status": "ok", "path": "raw/jezero/ortho.tif"}]}}}))

    def run(cmd):
        # gdal_translate copia el archivo; el resto de GDAL falla y esas capas quedan en error.
        if cmd[0] != "gdal_translate":
            raise precompute.subprocess.CalledProcessError(1, cmd)
        shutil.copy(cmd[-2], cmd[-1])

    zooms = {}

    def raster_a_tiles(src, outdir, max_zoom=None, **kwargs):
        zooms[outdir.name] = max_zoom
        return {"template": f"{outdir.name}/{{z}}/{{x}}/{{y}}.png", "minzoom": 0,
                "maxzoom": max_zoom or 16, "bounds": [0, 0, 0, 0], "count": 0}

    monkeypatch.setattr(precompute, "run", run)
    monkeypatch.setattr(precompute, "raster_size", lambda path: [60, 60])
    monkeypatch.setattr(precompute, "gdal_version", lambda: None)
    monkeypatch.setattr(precompute.tiles, "faltan_herramientas", lambda: [])
    monkeypatch.setattr(precompute.tiles, "raster_a_tiles", raster_a_tiles)

    precompute.main(["--site", "jezero", "--ortho", "--max-zoom", "15"])
    # El peligro sale del DTM como la pendiente: usa el tope del relieve.
    assert zooms == {"slope": 15, "hazard": 15, "dose": 15, "ortho": 17}  # la ortoimagen, con el default de --ortho-max-zoom

    zooms.clear()
    precompute.main(["--site", "jezero", "--ortho", "--ortho-max-zoom", "18"])
    assert zooms == {"slope": None, "hazard": None, "dose": None, "ortho": 18}  # el relieve, con el zoom que deduce gdal2tiles


# ------------------------------------------------------------------ cobertura

def point_in_ring(lon, lat, ring):
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def covered(fc, lon, lat):
    """Igual que web/src/map/coverage.ts: adentro del anillo exterior y fuera de los huecos."""
    for f in fc["features"]:
        rings = f["geometry"]["coordinates"]
        if point_in_ring(lon, lat, rings[0]) and not any(point_in_ring(lon, lat, h) for h in rings[1:]):
            return True
    return False


class TestCoverage:
    def test_full_dtm_is_one_polygon_in_lonlat(self, tmp_path):
        dtm = write_dtm(tmp_path / "dtm.tif", np.full((100, 100), -2500.0))
        fc = precompute.coverage_geojson(*precompute.coverage_mask(dtm, cell=10))
        assert len(fc["features"]) == 1
        ring = fc["features"][0]["geometry"]["coordinates"][0]
        lons, lats = [c[0] for c in ring], [c[1] for c in ring]
        assert min(lons) == pytest.approx(LON0) and max(lats) == pytest.approx(LAT0)
        assert max(lons) == pytest.approx(LON0 + math.degrees(100 / R), abs=1e-6)
        assert covered(fc, LON0 + math.degrees(50 / R), LAT0 - math.degrees(50 / R))
        assert not covered(fc, LON0 - 0.001, LAT0 - math.degrees(50 / R))  # al oeste del DTM

    def test_hole_is_left_out(self, tmp_path):
        z = np.full((100, 100), -2500.0)
        z[40:60, 40:60] = NODATA
        dtm = write_dtm(tmp_path / "dtm.tif", z)
        mask, transform, crs = precompute.coverage_mask(dtm, cell=10)
        assert mask[4:6, 4:6].sum() == 0 and mask.sum() == 100 - 4
        fc = precompute.coverage_geojson(mask, transform, crs)
        assert not covered(fc, LON0 + math.degrees(50 / R), LAT0 - math.degrees(50 / R))
        assert covered(fc, LON0 + math.degrees(15 / R), LAT0 - math.degrees(15 / R))

    def test_one_bad_pixel_drops_the_whole_cell(self, tmp_path):
        z = np.full((30, 30), -2500.0)
        z[12, 17] = NODATA
        mask, _, _ = precompute.coverage_mask(write_dtm(tmp_path / "dtm.tif", z), cell=10)
        assert mask.tolist() == [[1, 1, 1], [1, 0, 1], [1, 1, 1]]

    def test_partial_edge_cells_are_out(self, tmp_path):
        mask, _, _ = precompute.coverage_mask(write_dtm(tmp_path / "dtm.tif", np.full((25, 25), -2500.0)), cell=10)
        assert mask.tolist() == [[1, 1, 0], [1, 1, 0], [0, 0, 0]]

    def test_strips_match_one_pass(self, tmp_path, monkeypatch):
        z = crater(n=120)
        dtm = write_dtm(tmp_path / "dtm.tif", z)
        whole, _, _ = precompute.coverage_mask(dtm, cell=10)
        monkeypatch.setattr(precompute, "STRIP_PX", 120 * 10 * 2)  # dos filas de celdas por franja
        strips, _, _ = precompute.coverage_mask(dtm, cell=10)
        assert (whole == strips).all() and whole[1, 1] == 0  # el hueco del cráter, en [10:20, 10:20]
