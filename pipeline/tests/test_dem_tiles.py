"""tiles.py, relieve 3D: la altura codificada en PNG vuelve igual y cae en el tile correcto.

Solo necesita rasterio (no las herramientas de línea de comandos de GDAL): arma a mano
el raster en lon/lat que en producción sale de gdalwarp + gdal_fillnodata.
"""
import math

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

import tiles

R = 3396190.0
LON0, LAT0 = 77.45, 18.55
NODATA = -3.4028226550889045e38


class TestCodificacion:
    def test_ida_y_vuelta(self):
        h = np.array([[0.0, 0.5, 1.0 / 256, 123.456], [999.99, 4321.0, 20000.0, 65535.0]])
        rgb = tiles.codificar_relieve(h)
        assert rgb.dtype == np.uint8 and rgb.shape == (3, 2, 4)
        np.testing.assert_allclose(tiles.decodificar_relieve(rgb), h, atol=1 / 512)

    def test_sin_dato_y_negativo_quedan_en_el_piso(self):
        rgb = tiles.codificar_relieve(np.array([[np.nan, -5.0, np.inf]]))
        assert not rgb.any()

    def test_rgb_cero_es_el_piso(self):
        """Fuera de los tiles MapLibre ve RGB 0: tiene que ser el piso, no -32 km."""
        assert tiles.decodificar_relieve(np.zeros((3, 1, 1), dtype=np.uint8))[0, 0] == 0


class TestGrillaDeTiles:
    def test_tile_de_y_sus_limites_coinciden(self):
        x, y = tiles.tile_de(LON0, LAT0, 15)
        oeste, sur, este, norte = tiles.limites_tile_3857(15, x, y)
        mx = math.radians(LON0) * 6378137.0
        my = math.log(math.tan(math.pi / 4 + math.radians(LAT0) / 2)) * 6378137.0
        assert oeste <= mx < este and sur <= my < norte

    def test_zoom_minimo(self):
        # ~0,17° de lado (10 km en Marte): entra entero en un tile de z11 (0,176°).
        assert tiles.zoom_minimo_dem([77.3, 18.3, 77.47, 18.47], 15) == 11
        assert tiles.zoom_minimo_dem([0, 0, 1e-6, 1e-6], 15) == 15


def write_lonlat(path, z, paso):
    h, w = z.shape
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32",
                       crs="EPSG:4326", nodata=NODATA, transform=from_origin(LON0, LAT0, paso, paso)) as ds:
        ds.write(z.astype(np.float32), 1)
    return path


def leer_tile(outdir, z, lon, lat):
    """Altura relativa decodificada en un lon/lat, leyendo el tile como lo haría MapLibre."""
    x, y = tiles.tile_de(lon, lat, z)
    with rasterio.open(outdir / str(z) / str(x) / f"{y}.png") as ds:
        rgb = ds.read()
    oeste, sur, este, norte = tiles.limites_tile_3857(z, x, y)
    mx = math.radians(lon) * 6378137.0
    my = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * 6378137.0
    col = int((mx - oeste) / (este - oeste) * tiles.DEM_TILE_PX)
    fila = int((norte - my) / (norte - sur) * tiles.DEM_TILE_PX)
    return float(tiles.decodificar_relieve(rgb[:, fila:fila + 1, col:col + 1])[0, 0])


def test_teselar_relieve_rampa(tmp_path):
    """Rampa que sube 1 m por columna hacia el este, desde -2500 m: el piso se descuenta."""
    zmax = 15
    paso = tiles.grados_por_pixel(zmax)
    n = 300
    z = -2500.0 + np.tile(np.arange(n, dtype=float), (n, 1))
    z[:5, :5] = NODATA  # esquina sin dato
    src = write_lonlat(tmp_path / "relleno.tif", z, paso)

    out = tmp_path / "dem"
    info = tiles.teselar_relieve(src, out, 13, zmax)

    assert info["datum_m"] == -2500.0
    assert (info["minzoom"], info["maxzoom"]) == (13, zmax) and info["count"] > 0
    w, s, e, nn = info["bounds"]
    assert w == pytest.approx(LON0) and nn == pytest.approx(LAT0)
    assert e == pytest.approx(LON0 + n * paso) and s == pytest.approx(LAT0 - n * paso)
    assert not list(out.rglob("*.aux.xml"))
    for zz in range(13, zmax + 1):
        assert (out / str(zz)).is_dir()

    # En el zoom máximo la altura vuelve con el error de un píxel de remuestreo.
    for col in (50, 150, 250):
        lon = LON0 + (col + 0.5) * paso
        lat = LAT0 - 150.5 * paso
        assert leer_tile(out, zmax, lon, lat) == pytest.approx(col, abs=1.5)
    # Sin dato: al piso, no un valor inventado.
    assert leer_tile(out, zmax, LON0 + 1.5 * paso, LAT0 - 1.5 * paso) == pytest.approx(0, abs=1.5)
    # Un zoom más bajo promedia, pero sigue siendo la misma rampa.
    assert leer_tile(out, 13, LON0 + 200.5 * paso, LAT0 - 150.5 * paso) == pytest.approx(200, abs=4)


def test_raster_sin_dato_falla(tmp_path):
    src = write_lonlat(tmp_path / "vacio.tif", np.full((10, 10), NODATA), tiles.grados_por_pixel(15))
    with pytest.raises(RuntimeError, match="ningún píxel"):
        tiles.teselar_relieve(src, tmp_path / "dem", 15, 15)


def test_sin_herramientas_falla_sin_tocar_nada(tmp_path, monkeypatch):
    monkeypatch.setattr(tiles.shutil, "which", lambda _: None)
    with pytest.raises(RuntimeError, match="Faltan herramientas"):
        tiles.dem_a_tiles(tmp_path / "dtm.tif", tmp_path / "dem")
    assert not (tmp_path / "dem").exists()
