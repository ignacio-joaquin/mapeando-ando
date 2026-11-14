"""shadow_tiles.py: qué horas se teselan, el catálogo y una corrida completa sobre una pila sintética.

La corrida completa necesita las herramientas de GDAL (gdalwarp, gdaldem, gdal2tiles.py,
gdal_edit.py, gdal_translate): se saltea si no están instaladas.
"""
import json
import math
import shutil

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

import shadow_tiles as st

R = 3396190.0
EQC = "+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs"
LAT0, LON0 = 18.55, 77.45
TAG = "20261115T0649Z"

BANDS = [  # noche, mañana, mediodía
    {"band": 1, "ltst": "00:00", "utc": "2026-11-15T06:49:00Z", "sun_az_deg": 0.0, "sun_el_deg": -60.0, "lit_fraction": 0.0},
    {"band": 2, "ltst": "07:00", "utc": "2026-11-15T14:00:00Z", "sun_az_deg": 95.0, "sun_el_deg": 8.0, "lit_fraction": 0.6},
    {"band": 3, "ltst": "12:00", "utc": "2026-11-15T19:08:00Z", "sun_az_deg": 180.0, "sun_el_deg": 70.0, "lit_fraction": 0.98},
]


def write_sol(base, tag=TAG, n=64, generated_at="2026-11-14T00:00:00Z"):
    """Carpeta de sol como la deja illumination.py: COG uint8 por hora + index.json."""
    d = base / "illumination" / tag
    d.mkdir(parents=True)
    stack = np.zeros((len(BANDS), n, n), dtype=np.uint8)  # banda 1: noche, todo sombra
    stack[1, :, : n // 2] = 1                              # mañana: mitad al sol
    stack[2] = 1                                           # mediodía: todo al sol...
    stack[2, :24, :24] = 255                               # ...salvo un hueco sin dato
    with rasterio.open(d / "shadow_hourly.tif", "w", driver="GTiff", width=n, height=n, count=len(BANDS),
                       dtype="uint8", nodata=255, crs=EQC,
                       transform=from_origin(R * math.radians(LON0), R * math.radians(LAT0), 8.0, 8.0)) as ds:
        ds.write(stack)
    index = {
        "badge": "DERIVED", "site": "jezero", "generated_at": generated_at,
        "sol": {"start_utc": "2026-11-15T06:49:00Z", "end_utc": "2026-11-16T07:28:35Z", "ls_deg": 120.5,
                "flat_sunrise": {"utc": "2026-11-15T12:58:00Z", "ltst": "06:05"},
                "flat_sunset": {"utc": "2026-11-16T01:20:00Z", "ltst": "18:02"}},
        "shadow_hourly": {"file": "shadow_hourly.tif", "step_min": 60, "bands": BANDS},
        "grid": {"pixel_ground_m": [8.0, 8.0]},
        "provenance": {"ephemeris": "NAIF SPICE: de440s.bsp"},
        "assumptions": ["Sol puntual (centro del disco); sin refracción ni polvo."],
        "warnings": [],
    }
    (d / "index.json").write_text(json.dumps(index))
    return d


class TestHelpers:
    def test_hhmm(self):
        assert st.hhmm("07:00") == "0700"
        assert st.hhmm("7:30") == "0730"

    def test_only_daylight_bands(self):
        index = {"shadow_hourly": {"bands": BANDS}}
        assert [b["ltst"] for b in st.daylight_bands(index)] == ["07:00", "12:00"]

    def test_provenance_is_derived(self):
        prov = st.provenance({"grid": {"pixel_ground_m": [1.0, 1.0]}, "assumptions": ["x"]}, TAG)
        assert prov["provenance"] == "DERIVED"
        assert prov["resolution"] == "1.00 × 1.00 m/px"
        assert TAG in prov["source"]


class TestDataNotReady:
    def test_no_stack(self, tmp_path):
        assert st.main(["--out", str(tmp_path)]) == 2

    def test_unknown_sol(self, tmp_path):
        write_sol(tmp_path)
        assert st.main(["--out", str(tmp_path), "--sol", "20991231T0000Z"]) == 2


class TestCatalog:
    def test_lists_sols_and_skips_broken_index(self, tmp_path):
        write_sol(tmp_path)
        rota = tmp_path / "illumination" / "20261116T0728Z"
        rota.mkdir()
        (rota / "index.json").write_text("{a medio escribir")
        (rota / "shadow_hourly.tif").write_bytes(b"")
        cat = st.write_catalog(tmp_path / "illumination")
        assert [s["tag"] for s in cat["sols"]] == [TAG]
        assert cat["sols"][0]["tiles"] is None  # todavía no se teselaron
        assert json.loads((tmp_path / "illumination" / "catalog.json").read_text())["sols"][0]["step_min"] == 60


GDAL = all(shutil.which(t) for t in st.tl.HERRAMIENTAS + ["gdal_translate"])


@pytest.mark.skipif(not GDAL, reason="faltan las herramientas de GDAL")
class TestFullRun:
    def test_tiles_daylight_hours(self, tmp_path):
        sol = write_sol(tmp_path)
        assert st.main(["--out", str(tmp_path), "--max-zoom", "12"]) == 0

        idx = json.loads((sol / "tiles.json").read_text())
        assert idx["badge"] == "DERIVED"
        assert [b["ltst"] for b in idx["bands"]] == ["07:00", "12:00"]  # la noche no se tesela
        assert all(b["status"] == "ok" for b in idx["bands"])
        b = idx["bands"][0]
        assert b["template"] == f"illumination/{TAG}/tiles/0700/{{z}}/{{x}}/{{y}}.png"
        assert b["maxzoom"] <= 12
        assert (sol / "tiles" / "0700" / str(b["maxzoom"])).is_dir()
        assert not (sol / "tiles" / "0000").exists()
        west, south, east, north = b["bounds"]
        assert west == pytest.approx(LON0, abs=1e-3) and north == pytest.approx(LAT0, abs=1e-3)

        cat = json.loads((tmp_path / "illumination" / "catalog.json").read_text())
        assert cat["sols"][0]["tiles"] == f"{TAG}/tiles.json"
        assert not (sol / ".tiles.work").exists()

    def test_mask_colors(self, tmp_path):
        """Sombra oscura, sol transparente, sin dato distinto de sol."""
        sol = write_sol(tmp_path)
        assert st.main(["--out", str(tmp_path), "--max-zoom", "12"]) == 0
        from PIL import Image

        def pixels(name):
            pngs = sorted((sol / "tiles" / name).rglob("*.png"), key=lambda p: int(p.parts[-3]))
            img = Image.open(pngs[-1]).convert("RGBA")  # el zoom más alto
            datos = img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata()
            return {px for px in datos if px[3] > 0}

        manana = pixels("0700")
        assert (12, 10, 9, 175) in manana              # la mitad en sombra
        mediodia = pixels("1200")
        assert (12, 10, 9, 175) not in mediodia        # nada en sombra
        assert (120, 130, 150, 110) in mediodia        # el hueco sin dato se ve

    def test_skips_when_up_to_date(self, tmp_path, capsys):
        write_sol(tmp_path)
        assert st.main(["--out", str(tmp_path), "--max-zoom", "11"]) == 0
        assert st.main(["--out", str(tmp_path), "--max-zoom", "11"]) == 0
        assert "al día" in capsys.readouterr().out
