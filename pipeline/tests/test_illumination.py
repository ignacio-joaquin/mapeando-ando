"""Orquestador: datos que faltan y una corrida completa sobre un DTM sintético.

La corrida completa necesita los kernels SPICE: se saltea si MAPEANDO_KERNELS no apunta a
una carpeta con naif*.tls, pck*.tpc, de4*.bsp y mar*.bsp (en el server: /data/raw/common).
"""
import json
import math
import os
from pathlib import Path

import numpy as np
import pytest

import illumination


def fake_kernels(tmp_path):
    k = tmp_path / "kernels"
    k.mkdir()
    for name in ("naif0012.tls", "pck00011.tpc", "de440s.bsp", "mar099s.bsp"):
        (k / name).write_text("")
    return k


class TestDataNotReady:
    def test_missing_kernels(self, tmp_path):
        assert illumination.main(["--dtm", str(tmp_path / "x.tif"), "--kernels", str(tmp_path)]) == 2

    def test_missing_dtm(self, tmp_path):
        k = fake_kernels(tmp_path)
        assert illumination.main(["--dtm", str(tmp_path / "no.tif"), "--kernels", str(k)]) == 2

    def test_missing_manifest(self, tmp_path, monkeypatch):
        monkeypatch.setattr(illumination, "DATA_DIR", tmp_path)
        assert illumination.main(["--site", "jezero", "--kernels", str(fake_kernels(tmp_path))]) == 2

    def test_dtm_not_downloaded_yet(self, tmp_path, monkeypatch):
        monkeypatch.setattr(illumination, "DATA_DIR", tmp_path)
        (tmp_path / "manifest.json").write_text(json.dumps({"sites": {"jezero": {"files": [
            {"key": "dtm", "status": "error", "path": "raw/jezero/dtm.tif"}]}}}))
        assert illumination.main(["--site", "jezero", "--kernels", str(fake_kernels(tmp_path))]) == 2


KERNELS = os.environ.get("MAPEANDO_KERNELS")


@pytest.mark.skipif(not KERNELS, reason="sin kernels SPICE (MAPEANDO_KERNELS)")
def test_full_run_on_synthetic_crater(tmp_path):
    import rasterio
    from rasterio.transform import from_origin

    # Cráter sintético de 1 km de diámetro y 150 m de profundidad cerca de Jezero, píxel de 5 m.
    r_m, n, px = 3396190.0, 300, 5.0
    lat0, lon0 = 18.45, 77.45
    yy, xx = np.mgrid[0:n, 0:n] * px
    rr = np.hypot(xx - n * px / 2, yy - n * px / 2)
    z = (-2500 - 150 * np.clip(1 - (rr / 500.0) ** 2, 0, None)).astype(np.float32)
    dtm = tmp_path / "crater.tif"
    with rasterio.open(dtm, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32",
                       crs="+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs",
                       transform=from_origin(r_m * math.radians(lon0), r_m * math.radians(lat0), px, px),
                       nodata=-32767) as ds:
        ds.write(z, 1)

    out = tmp_path / "out"
    rc = illumination.main(["--dtm", str(dtm), "--kernels", KERNELS, "--out", str(out),
                            "--start", "2026-11-15T00:00:00", "--rise-step-min", "10"])
    assert rc == 0
    (sol,) = [p for p in (out / "illumination").iterdir() if p.is_dir()]
    index = json.loads((sol / "index.json").read_text())
    bands = index["shadow_hourly"]["bands"]
    assert len(bands) == 24
    noon = bands[12]
    assert noon["sun_el_deg"] > 45 and noon["lit_fraction"] > 0.95
    assert bands[0]["sun_el_deg"] < 0 and bands[0]["lit_fraction"] == 0
    with rasterio.open(sol / "shadow_hourly.tif") as ds:
        assert ds.count == 24
    with rasterio.open(sol / "sun_times.tif") as ds:
        rise, sset = ds.read(1), ds.read(2)
    flat_rise = index["sol"]["flat_sunrise"]["ltst"]
    flat_min = int(flat_rise[:2]) * 60 + int(flat_rise[3:])
    # Afuera del cráter amanece con el horizonte plano; adentro, más tarde por la pared este.
    assert abs(int(rise[5, 5]) - flat_min) <= 10
    assert rise[n // 2, n // 2 - 80] > rise[5, 5]
    assert sset[n // 2, n // 2 + 80] < sset[5, 5]
    assert not (out / "illumination" / "_work").exists()
