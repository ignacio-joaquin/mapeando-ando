"""terrain_layers.py: rugosidad sin la pendiente, calibración de bloques, costuras, huecos y datos que faltan."""
import numpy as np
import pytest
import rasterio

import precompute
import terrain_layers as tl
from test_precompute import EQC_LATTS0, LAT0, LON0, R, tilted_plane, write_dtm  # noqa: F401

INNER = slice(20, -20)  # lejos del borde, donde las ventanas están completas


def make_inputs(folder, z, nodata_tag=True):
    """dtm.tif + slope.tif (la pendiente la calcula precompute, igual que en producción)."""
    dtm = folder / "dtm.tif"
    if nodata_tag:
        write_dtm(dtm, z)
    else:
        write_dtm_without_nodata(dtm, z)
    precompute.compute_slope(dtm, folder / "slope.tif")
    return dtm, folder / "slope.tif"


def write_dtm_without_nodata(path, z):
    """Como los DTM de USGS que traen ±3,4e38 en los huecos pero sin la etiqueta de nodata."""
    import math
    from rasterio.transform import from_origin
    h, w = z.shape
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32",
                       crs=EQC_LATTS0, transform=from_origin(R * math.radians(LON0), R * math.radians(LAT0), 1, 1)) as ds:
        ds.write(z.astype(np.float32), 1)
    return path


def run(folder, z, nodata_tag=True):
    make_inputs(folder, z, nodata_tag)
    tl.compute(folder / "dtm.tif", folder / "slope.tif", folder)
    with rasterio.open(folder / "roughness.tif") as r, rasterio.open(folder / "hazard.tif") as h:
        return r.read(1), h.read(1)


def block_field(n, height, block=2, p=0.5, seed=0):
    """Terreno plano con bloques de `height` m de lado `block` m, en una fracción p del área."""
    rng = np.random.default_rng(seed)
    g = (rng.random((n // block + 1, n // block + 1)) < p).astype(float)
    return -2500.0 + np.kron(g, np.ones((block, block)))[:n, :n] * height


def test_smooth_slope_is_not_rough(tmp_path):
    """Una ladera lisa de 15°: σ en el nivel del ruido y clase 'medio', que sale solo de la pendiente.

    (No se usa 20° justo: con la convención ≥ del planificador, 20° ya es 'alto'.)
    """
    rough, cls = run(tmp_path, tilted_plane(200, 15, "e"))
    assert np.nanmax(rough[INNER, INNER]) < 0.1
    assert (cls[INNER, INNER] == 1).all()


def test_one_meter_blocks_are_impassable(tmp_path):
    """Campo denso de bloques de 1 m sobre terreno plano -> 'no transitable' (valida la calibración σ ≈ h/2)."""
    rough, cls = run(tmp_path, block_field(200, 1.0))
    inner = cls[INNER, INNER]
    assert np.median(rough[INNER, INNER]) > tl.ROUGHNESS_CUTS_M[-1]
    assert (inner == 3).mean() > 0.8


def test_small_blocks_are_not_impassable(tmp_path):
    """Bloques de 30 cm: rugosos, pero nunca 'no transitable'."""
    _, cls = run(tmp_path, block_field(200, 0.3))
    assert (cls[INNER, INNER] < 3).all()


def test_blocks_do_not_leave_seams(tmp_path, monkeypatch):
    rng = np.random.default_rng(1)
    z = -2500 + np.cumsum(rng.normal(size=(200, 200)), axis=0) + rng.normal(0, 0.3, (200, 200))
    make_inputs(tmp_path, z)
    tl.compute(tmp_path / "dtm.tif", tmp_path / "slope.tif", tmp_path / "once")
    monkeypatch.setattr(tl, "BLOCK", 64)
    tl.compute(tmp_path / "dtm.tif", tmp_path / "slope.tif", tmp_path / "blocks")
    for name in ("roughness.tif", "terrain_factor.tif", "hazard.tif"):
        with rasterio.open(tmp_path / "once" / name) as a, rasterio.open(tmp_path / "blocks" / name) as b:
            np.testing.assert_allclose(a.read(1), b.read(1), atol=1e-4, equal_nan=True, err_msg=name)


@pytest.mark.parametrize("nodata_tag", [True, False])
def test_hole_stays_a_hole(tmp_path, nodata_tag):
    """Hueco del DTM -> NaN en la rugosidad y 255 en las clases, con o sin etiqueta de nodata."""
    z = tilted_plane(200, 5, "s")
    z[80:120, 80:120] = -3.4028226550889045e38
    rough, cls = run(tmp_path, z, nodata_tag)
    assert np.isnan(rough[90:110, 90:110]).all()
    assert (cls[90:110, 90:110] == tl.HAZARD_NODATA).all()
    # alrededor del hueco no aparece rugosidad astronómica ni "no transitable" falso
    ring = cls[70:130, 70:130]
    assert not (ring == 3).any()
    assert np.nanmax(rough) < 1


def test_missing_inputs_give_a_clear_error(tmp_path, capsys):
    assert tl.main(["--dir", str(tmp_path)]) == 2
    assert "Falta" in capsys.readouterr().err
    write_dtm(tmp_path / "dtm.tif", tilted_plane(50, 5, "e"))  # hay DTM pero no pendiente
    with pytest.raises(tl.MissingInput, match="slope.tif"):
        tl.compute(tmp_path / "dtm.tif", tmp_path / "slope.tif", tmp_path)


def test_cli_publishes_atomically(tmp_path):
    make_inputs(tmp_path, tilted_plane(100, 12, "e"))
    assert tl.main(["--dir", str(tmp_path)]) == 0
    names = {p.name for p in tmp_path.iterdir()}
    assert {"roughness.tif", "terrain_factor.tif", "hazard.tif"} <= names
    assert not any(n.endswith(".work") for n in names)


def test_hazard_cuts_match_the_planner():
    """Mismos cortes que el planificador (api/planner.py SLOPE_CUTS, con el límite duro de
    api/safety.py) y la misma convención ≥: 25° justos no se pisan en ninguno de los dos."""
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from api import safety
    assert tl.SLOPE_CUTS_DEG == (10.0, 20.0, safety.Limits().max_slope_deg)
    cls = tl.hazard_class(np.array([9.99, 10.0, 20.0, 24.99, 25.0]), np.zeros(5))
    assert cls.tolist() == [0, 1, 2, 2, 3]
