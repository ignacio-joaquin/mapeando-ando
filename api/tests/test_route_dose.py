"""Dosis de la travesía: usa la dosis por celda (survival-dose) si el pipeline la generó."""
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import rasterio

from api import planner

from .rasters import CRS, TRANSFORM, latlon

REPO = Path(__file__).resolve().parents[2]
BASE_MSV_H = 0.64 / 24


def write_dose(data_dir, value_usv_h, status="ok"):
    out = data_dir / "output" / "jezero"
    out.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out / "dose_rate.tif", "w", driver="GTiff", width=200, height=200, count=1,
                       dtype="float32", crs=CRS, transform=TRANSFORM, nodata=np.nan) as ds:
        ds.write(np.full((200, 200), value_usv_h, dtype="float32"), 1)
    (out / "terrain.json").write_text(json.dumps({"layers": {"survival-dose": {
        "file": "dose_rate.tif", "status": status, "unit": "µSv/h", "resolution": "derivada, 100 m/px",
        "assumptions": ["supuesto de la capa"]}}}))


def legs(*points):
    return [SimpleNamespace(latlon=list(points))]


def test_without_the_layer_uses_the_rad_base_rate(tmp_path):
    rate, src = planner._route_dose_rate(tmp_path, "jezero", REPO, legs(latlon(10, 10), latlon(20, 20)))
    assert rate == pytest.approx(BASE_MSV_H)
    assert "igual en todo el recorrido" in " ".join(src["assumptions"])


def test_with_the_layer_uses_the_dose_along_the_route_in_msv(tmp_path):
    write_dose(tmp_path, 25.0)   # µSv/h
    rate, src = planner._route_dose_rate(tmp_path, "jezero", REPO, legs(latlon(10, 10), latlon(150, 150)))
    assert rate == pytest.approx(25.0 / 1000)   # mSv/h: misma unidad que el límite de safety
    assert src["provenance"] == "MODELED" and src["instrument"] == "RAD"
    assert "supuesto de la capa" in src["assumptions"]


def test_layer_in_error_or_route_outside_falls_back_to_the_base(tmp_path):
    write_dose(tmp_path, 25.0, status="error")
    rate, _ = planner._route_dose_rate(tmp_path, "jezero", REPO, legs(latlon(10, 10)))
    assert rate == pytest.approx(BASE_MSV_H)
    write_dose(tmp_path, 25.0)
    rate, src = planner._route_dose_rate(tmp_path, "jezero", REPO, legs(latlon(-5000, -5000)))
    assert rate == pytest.approx(BASE_MSV_H)
    assert any("fuera" in a for a in src["assumptions"])
