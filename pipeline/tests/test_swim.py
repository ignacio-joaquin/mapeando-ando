"""swim.py: recorte de SWIM 2.0 sin remuestrear, sin dato (-100 y -30), avisos y datos que faltan."""
import numpy as np
import pytest
import rasterio

import swim
from test_precompute import tilted_plane, write_dtm, write_swim


def run_swim(tmp_path, dtm_px=100.0, n=59, **kw):
    """DTM de n × dtm_px m (por defecto 5,9 km: cubre 2 × 2 píxeles de SWIM) + SWIM sintético."""
    data = tmp_path / "data"
    write_dtm(tmp_path / "dtm.tif", tilted_plane(n, 2, "e", px=dtm_px), px=dtm_px)
    write_swim(data, **kw)
    summary = swim.compute(tmp_path / "dtm.tif", tmp_path / "out", data_dir=data)
    with rasterio.open(tmp_path / "out" / "ice_consistency.tif") as ds:
        return summary, ds.read(1), ds


def test_crop_covers_the_dtm_and_keeps_the_original_values(tmp_path):
    summary, ci, ds = run_swim(tmp_path)
    assert ci.tolist() == [[pytest.approx(0.2), pytest.approx(0.4)], [pytest.approx(0.2), pytest.approx(0.4)]]
    assert ds.res == (3000.0, 3000.0) and ds.nodata == swim.SWIM_NODATA
    assert summary["consistency"] == {"min": pytest.approx(0.2), "mean": pytest.approx(0.3), "max": pytest.approx(0.4)}
    assert summary["pct_positive"] == 100 and summary["coverage_pct"] == 100
    assert summary["depth_m"] == "0-1" and summary["warnings"] == []


def test_small_dtm_is_one_pixel(tmp_path):
    """El recorte de prueba (2 km) cae entero en un píxel de 3 km."""
    summary, ci, _ = run_swim(tmp_path, dtm_px=1.0, n=300)
    assert ci.shape == (1, 1) and summary["n_pixels"] == 1


@pytest.mark.parametrize("nodata", [-100.0, -30.0])
def test_nodata_stays_out_of_the_statistics(tmp_path, nodata):
    """El -100 de los GeoTIFF y el -30 que documenta la web quedan como sin dato (-100)."""
    values = [[0, 0, 0], [0, nodata, 0.4], [0, nodata, 0.4]]
    summary, ci, _ = run_swim(tmp_path, values=values, nodata=-100.0)
    assert (ci[:, 0] == swim.SWIM_NODATA).all()
    assert summary["coverage_pct"] == 50 and summary["consistency"]["min"] == pytest.approx(0.4)


def test_no_ice_is_said_plainly(tmp_path):
    summary, _, _ = run_swim(tmp_path, values=[[-0.3] * 3] * 3)
    assert summary["pct_positive"] == 0
    assert "ningún píxel" in summary["warnings"][0]


def test_weak_signal_is_flagged(tmp_path):
    summary, _, _ = run_swim(tmp_path, values=[[0.1] * 3] * 3)
    assert "débil" in summary["warnings"][0]


def test_missing_inputs_give_a_clear_error(tmp_path, capsys):
    write_dtm(tmp_path / "dtm.tif", tilted_plane(50, 2, "e"))
    with pytest.raises(swim.MissingInput, match="fetch_extras.py"):
        swim.compute(tmp_path / "dtm.tif", tmp_path / "out", data_dir=tmp_path / "data")
    with pytest.raises(swim.MissingInput, match="no-hay.tif"):
        swim.compute(tmp_path / "no-hay.tif", tmp_path / "out", data_dir=tmp_path / "data")
    assert swim.main(["--dir", str(tmp_path / "vacia")]) == 2
    assert "Faltan datos" in capsys.readouterr().err


def test_swim_that_does_not_cover_the_dtm(tmp_path):
    data = tmp_path / "data"
    write_dtm(tmp_path / "dtm.tif", tilted_plane(50, 2, "e"))
    write_swim(data, values=[[0.1]])        # un solo píxel, al noroeste del DTM
    with pytest.raises(swim.MissingInput, match="no se superpone"):
        swim.compute(tmp_path / "dtm.tif", tmp_path / "out", data_dir=data)


def test_cli_writes_next_to_the_dtm(tmp_path, monkeypatch):
    data = tmp_path / "data"
    write_dtm(tmp_path / "site" / "dtm.tif", tilted_plane(50, 2, "e"))
    write_swim(data)
    monkeypatch.setattr(swim, "DATA_DIR", data)
    assert swim.main(["--dir", str(tmp_path / "site")]) == 0
    assert (tmp_path / "site" / "ice_consistency.tif").exists()
    assert not (tmp_path / "site" / ".swim.work").exists()
    assert np.isfinite(rasterio.open(tmp_path / "site" / "ice_consistency.tif").read(1)).all()
