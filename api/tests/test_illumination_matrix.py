import numpy as np
import rasterio

from api.illumination_matrix import a_star_min_dark_cells, resolve_shadow_tif


def test_resolve_shadow_tif_generates_missing_output(tmp_path, monkeypatch):
    site_dir = tmp_path / "output" / "jezero" / "illumination"
    site_dir.mkdir(parents=True)
    called = {}

    def fake_generate(site_id, sol_tag=None, start_utc=None, data_dir=None):
        called["site_id"] = site_id
        out_dir = site_dir / "20261115T000000Z"
        out_dir.mkdir(exist_ok=True)
        tif = out_dir / "shadow_hourly.tif"
        with rasterio.open(
            tif,
            "w",
            driver="GTiff",
            width=2,
            height=2,
            count=24,
            dtype="uint8",
            nodata=255,
        ) as ds:
            for band in range(1, 25):
                ds.write(np.full((2, 2), 1, dtype=np.uint8), band)
        return tif

    monkeypatch.setattr("api.illumination_matrix.generate_illumination_for_site", fake_generate)

    tif, band = resolve_shadow_tif("jezero", sol_tag="20261115T000000Z", ltst="12:30", data_dir=tmp_path)

    assert tif.name == "shadow_hourly.tif"
    assert band == 13
    assert called["site_id"] == "jezero"


def test_a_star_min_dark_cells_prefers_lit_path():
    matrix = np.array(
        [
            [True, True, True],
            [True, False, True],
            [True, True, True],
        ],
        dtype=bool,
    )

    result = a_star_min_dark_cells(matrix, (0, 0), (2, 2))

    assert result["path"][0] == (0, 0)
    assert result["path"][-1] == (2, 2)
    assert result["shadow_points"] == 0
    assert result["cost"] == 0
