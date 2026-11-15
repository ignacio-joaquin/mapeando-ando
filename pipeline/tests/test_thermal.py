"""thermal.py: recorte sin remuestrear, criterio de suelo suelto, contraste, huecos y datos que faltan.
También el refuerzo del peligro de terreno (terrain_layers.py con loose_soil.tif)."""
import numpy as np
import pytest
import rasterio

import terrain_layers as tl
import thermal
from test_precompute import tilted_plane, write_dtm, write_themis
from test_terrain_layers import block_field, make_inputs


def run_thermal(tmp_path, **kw):
    """DTM de 300 x 300 m + THEMIS sintético -> salidas de thermal.compute en tmp_path/out."""
    data = tmp_path / "data"
    write_dtm(tmp_path / "dtm.tif", tilted_plane(300, 2, "e"))
    write_themis(data, **kw)
    summary = thermal.compute("jezero", tmp_path / "dtm.tif", tmp_path / "out", data_dir=data)
    with rasterio.open(tmp_path / "out" / "themis_night.tif") as n, \
         rasterio.open(tmp_path / "out" / "loose_soil.tif") as s:
        return summary, n.read(1), s.read(1), n


def test_crop_covers_the_dtm_and_keeps_the_original_values(tmp_path):
    """El recorte es la huella del DTM (3 x 3 píxeles de 100 m) con los DN tal cual."""
    summary, night, _, ds = run_thermal(tmp_path)
    assert night.shape == (3, 3)
    assert night[:, 0].tolist() == [40, 40, 40] and night[:, 1:].min() == 200
    assert ds.res == (100.0, 100.0) and ds.nodata == 0
    assert summary["night_dn"] == {"p5": 40, "p50": 200, "p95": 200}


def test_coldest_part_of_the_site_is_loose_soil(tmp_path):
    summary, _, loose, _ = run_thermal(tmp_path)
    assert loose[:, 0].tolist() == [1, 1, 1]          # la columna fría
    assert (loose[:, 1:] == 0).all()                  # la tibia
    assert summary["loose_threshold_dn"] == pytest.approx(40)
    assert summary["loose_pct"] == pytest.approx(100 / 3, abs=0.01)
    assert summary["warnings"] == []


def test_no_contrast_marks_nothing(tmp_path):
    """Un sitio térmicamente parejo: el percentil igual encuentra 'el 20 % más frío', pero no se marca."""
    summary, _, loose, _ = run_thermal(tmp_path, cold=198, warm=200)
    assert (loose == 0).all()
    assert summary["loose_threshold_dn"] is None
    assert "sin contraste" in summary["warnings"][0]


def test_holes_stay_holes(tmp_path):
    """Sin dato en THEMIS (DN 0) -> 255 en loose_soil y fuera de los percentiles."""
    summary, night, loose, _ = run_thermal(tmp_path, nodata_block=True)
    assert (night[:, 2] == 0).all() and (loose[:, 2] == thermal.LOOSE_NODATA).all()
    assert summary["coverage_pct"] == pytest.approx(200 / 3, abs=0.01)
    assert summary["night_dn"]["p95"] == 200          # el 0 no entró en las estadísticas


def test_missing_inputs_give_a_clear_error(tmp_path, capsys):
    write_dtm(tmp_path / "dtm.tif", tilted_plane(50, 2, "e"))
    with pytest.raises(thermal.MissingInput, match="fetch_science.sh"):
        thermal.compute("jezero", tmp_path / "dtm.tif", tmp_path / "out", data_dir=tmp_path / "data")
    with pytest.raises(thermal.MissingInput, match="no-hay.tif"):
        thermal.compute("jezero", tmp_path / "no-hay.tif", tmp_path / "out", data_dir=tmp_path / "data")
    assert thermal.main(["--site", "jezero", "--dir", str(tmp_path / "vacia")]) == 2
    assert "Faltan datos" in capsys.readouterr().err


def test_themis_that_does_not_cover_the_dtm(tmp_path):
    data = tmp_path / "data"
    write_dtm(tmp_path / "dtm.tif", tilted_plane(50, 2, "e"))
    write_themis(data, n=5)        # 500 m que terminan 500 m antes del DTM
    with pytest.raises(thermal.MissingInput, match="no se superpone"):
        thermal.compute("jezero", tmp_path / "dtm.tif", tmp_path / "out", data_dir=data)


# ------------------------------------------------------------------ peligro de terreno + THEMIS

def hazard_with_themis(tmp_path, z, **kw):
    make_inputs(tmp_path, z)
    data = tmp_path / "data"
    write_themis(data, **kw)
    thermal.compute("jezero", tmp_path / "dtm.tif", tmp_path, data_dir=data)
    summary = tl.compute(tmp_path / "dtm.tif", tmp_path / "slope.tif", tmp_path / "out",
                         loose_soil_path=tmp_path / "loose_soil.tif")
    with rasterio.open(tmp_path / "out" / "hazard.tif") as ds:
        return ds.read(1), summary


INNER = slice(20, -20)


def test_loose_soil_raises_low_to_medium(tmp_path):
    """Llano y liso: oeste frío (arena) -> 'medio'; este tibio (roca) -> 'bajo'."""
    cls, summary = hazard_with_themis(tmp_path, tilted_plane(300, 2, "e"))
    assert (cls[INNER, 20:100] == 1).all()
    assert (cls[INNER, 100:280] == 0).all()
    assert summary["pct_raised_by_loose_soil"] == pytest.approx(100 / 3, abs=1)


def test_loose_soil_never_blocks(tmp_path):
    """THEMIS solo avisa: lo que ya era 'medio' o más no cambia, y nunca crea 'no transitable'."""
    slope = np.array([5.0, 15.0, 22.0, 30.0])
    rough = np.zeros(4)
    sand = np.ones(4, dtype="uint8")
    assert tl.hazard_class(slope, rough, sand).tolist() == [1, 1, 2, 3]
    assert tl.hazard_class(slope, rough, np.full(4, 255, "uint8")).tolist() == [0, 1, 2, 3]
    assert tl.hazard_class(np.array([np.nan]), np.zeros(1), np.ones(1, "uint8")).tolist() == [255]


def test_loose_soil_does_not_hide_blocks(tmp_path):
    """Bloques de 1 m sobre arena siguen siendo 'no transitable'."""
    cls, _ = hazard_with_themis(tmp_path, block_field(300, 1.0))
    assert (cls[INNER, 20:100] == 3).mean() > 0.8


def test_loose_soil_does_not_leave_seams(tmp_path, monkeypatch):
    """Por bloques o de una vez, el mismo resultado (el bloque de 64 px corta columnas de THEMIS)."""
    once, _ = hazard_with_themis(tmp_path, tilted_plane(300, 2, "e"))
    monkeypatch.setattr(tl, "BLOCK", 64)
    tl.compute(tmp_path / "dtm.tif", tmp_path / "slope.tif", tmp_path / "blocks",
               loose_soil_path=tmp_path / "loose_soil.tif")
    with rasterio.open(tmp_path / "blocks" / "hazard.tif") as ds:
        np.testing.assert_array_equal(once, ds.read(1))
