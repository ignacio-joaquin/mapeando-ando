"""radiation.py: sky-view contra casos analíticos, normalización en Bradbury y datos que faltan."""
import math

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

import radiation as rad

R = rad.MARS_RADIUS_M
PAD_M = 10_000   # para que los tests corran rápido: el horizonte de prueba está a 5 km


def eqc(lat_ts=0):
    return f"+proj=eqc +lat_ts={lat_ts} +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R={R:.0f} +units=m +no_defs"


def write(path, z, x0, y0, px, crs):
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", width=z.shape[1], height=z.shape[0], count=1,
                       dtype="float32", crs=crs, nodata=-3.4028226550889045e38,
                       transform=from_origin(x0, y0, px, px)) as ds:
        ds.write(z.astype("float32"), 1)
    return path


def scene(data_dir, site, lat, lon, ring_h=None, ring_r=5000.0, dtm_m=2000, crs=None):
    """DTM plano de dtm_m × dtm_m centrado en (lat, lon) y, opcional, un DEM de 200 m con un
    anillo de montañas de altura ring_h a ring_r metros SOBRE EL SUELO del centro."""
    crs = crs or eqc()
    cx, cy = math.radians(lon) * R, math.radians(lat) * R
    kx = math.cos(math.radians(lat))                 # metros de suelo por metro de proyección (E-O)
    n = int(dtm_m / 10)
    dtm = write(data_dir / "output" / site / "dtm.tif", np.zeros((n, n)),
                cx - dtm_m / 2 / kx, cy + dtm_m / 2, 10, crs)
    # el píxel E-O del DTM en la proyección es 10 m, pero sobre el suelo mide 10·kx:
    # se corrige el ancho para que el DTM mida dtm_m sobre el suelo en las dos direcciones
    with rasterio.open(dtm, "r+") as ds:
        ds.transform = from_origin(cx - dtm_m / 2 / kx, cy + dtm_m / 2, 10 / kx, 10)
    if ring_h is not None:
        m, px = 200, 200.0
        half = m * px / 2
        rows, cols = np.mgrid[0:m, 0:m]
        x = (cx - half / kx) + (cols + 0.5) * px / kx      # celdas de 200 m de suelo
        y = (cy + half) - (rows + 0.5) * px
        dist = np.hypot((x - cx) * kx, y - cy)
        z = np.where((dist > ring_r) & (dist < ring_r + 600), ring_h, 0.0)
        p = write(data_dir / "raw" / site / "dem200_crop.tif", z, cx - half / kx, cy + half, px, crs)
        with rasterio.open(p, "r+") as ds:
            ds.transform = from_origin(cx - half / kx, cy + half, px / kx, px)
    return dtm


def center_value(path):
    with rasterio.open(path) as ds:
        a = ds.read(1)
    return float(a[a.shape[0] // 2, a.shape[1] // 2])


@pytest.fixture
def no_gale(monkeypatch):
    """Que los tests no dependan de los datos reales de Gale."""
    monkeypatch.setattr(rad, "RAD_SITE", {**rad.RAD_SITE, "site": "gale-de-prueba"})


def test_flat_ground_sees_the_whole_sky(tmp_path, no_gale):
    dtm = scene(tmp_path, "llano", 0.0, 10.0)
    summary = rad.compute("llano", dtm, tmp_path / "out", data_dir=tmp_path, pad_m=PAD_M)
    with rasterio.open(tmp_path / "out" / "skyview.tif") as ds:
        svf = ds.read(1)
    assert np.nanmin(svf) > 0.999
    assert any("dem200" in w for w in summary["warnings"])   # sin DEM sigue, con aviso


def test_ring_of_mountains_matches_the_analytic_value(tmp_path, no_gale):
    """En el centro de un anillo de 1000 m a ~5,3 km: sky-view = 1 − sin(atan(h/d))."""
    dtm = scene(tmp_path, "pozo", 0.0, 10.0, ring_h=1000.0)
    rad.compute("pozo", dtm, tmp_path / "out", data_dir=tmp_path, pad_m=PAD_M)
    expected = 1 - math.sin(math.atan(1000 / 5300))
    assert center_value(tmp_path / "out" / "skyview.tif") == pytest.approx(expected, abs=0.02)


def test_east_west_distances_are_ground_meters(tmp_path, no_gale):
    """A 60° de latitud un metro de la proyección mide 0,5 m E-O: el anillo (circular sobre el
    suelo) tiene que dar el mismo sky-view que en el ecuador."""
    dtm = scene(tmp_path, "norte", 60.0, 10.0, ring_h=1000.0)
    rad.compute("norte", dtm, tmp_path / "out", data_dir=tmp_path, pad_m=2 * PAD_M)
    expected = 1 - math.sin(math.atan(1000 / 5300))
    assert center_value(tmp_path / "out" / "skyview.tif") == pytest.approx(expected, abs=0.02)


def test_dose_is_exactly_the_base_where_rad_measured(tmp_path, monkeypatch):
    """Normalización: en el punto de RAD la dosis es H0 aunque el horizonte tape cielo."""
    monkeypatch.setattr(rad, "RAD_SITE", {"site": "gale", "name": "prueba", "lat": 0.0, "lon": 10.0})
    dtm = scene(tmp_path, "gale", 0.0, 10.0, ring_h=1000.0)
    summary = rad.compute("gale", dtm, tmp_path / "out", data_dir=tmp_path, pad_m=PAD_M)
    h0 = rad.load_reference()["h0_msv_day"] * 1000 / 24
    assert summary["skyview_reference"]["value"] < 0.9
    assert center_value(tmp_path / "out" / "dose_rate.tif") == pytest.approx(h0, rel=1e-4)
    assert summary["warnings"] == []


def test_units_are_dose_equivalent_in_usv_per_hour(tmp_path, no_gale):
    """Sin normalizar y a cielo abierto, dose_rate = 0,64 mSv/día = 26,7 µSv/h (no mGy)."""
    dtm = scene(tmp_path, "llano", 0.0, 10.0)
    summary = rad.compute("llano", dtm, tmp_path / "out", data_dir=tmp_path, pad_m=PAD_M)
    assert center_value(tmp_path / "out" / "dose_rate.tif") == pytest.approx(0.64 * 1000 / 24, rel=1e-3)
    assert any("normalizada" in w for w in summary["warnings"])


def test_missing_dtm_gives_a_clear_error(tmp_path):
    with pytest.raises(rad.MissingInput, match="dtm.tif"):
        rad.compute("nada", tmp_path / "output" / "nada" / "dtm.tif", tmp_path / "out", data_dir=tmp_path)


def test_radius_comes_from_common_json():
    import json
    common = json.loads((rad.ROOT / "sites" / "common.json").read_text())
    assert rad.MARS_RADIUS_M == common["dem200"]["radius_m"] == 3396190
