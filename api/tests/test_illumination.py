"""Lectura de la pila de sombras (api/illumination.py) y POST /api/illumination/window."""
import numpy as np
import pytest

from api.illumination import ShadowStack, sol_dirs, stack_for_tag

from .rasters import N, SOL_TAG, latlon, manifest, write_shadow_stack


@pytest.fixture
def site(data_dir, write_manifest):
    write_manifest(manifest())
    return data_dir


def window_req(**kw) -> dict:
    (la1, lo1), (la2, lo2) = latlon(10, 10), latlon(12, 14)
    return {"site_id": "jezero", "p1": {"lat": la1, "lon": lo1}, "p2": {"lat": la2, "lon": lo2}} | kw


class TestStack:
    def test_ignora_work_y_carpetas_incompletas(self, data_dir):
        write_shadow_stack(data_dir)
        base = data_dir / "output" / "jezero" / "illumination"
        (base / "_work").mkdir()
        (base / "20261116T0040Z").mkdir()  # sin tif ni index: corrida a medias
        assert [d.name for d in sol_dirs(data_dir, "jezero")] == [SOL_TAG]

    def test_sin_pila_no_genera_nada_y_avisa(self, data_dir):
        from api.illumination import IlluminationNotReady
        with pytest.raises(IlluminationNotReady):
            stack_for_tag(data_dir, "jezero", None)
        assert not (data_dir / "output").exists()

    def test_sol_tag_con_otro_formato_se_rechaza(self, data_dir):
        with pytest.raises(ValueError):
            stack_for_tag(data_dir, "jezero", "../../etc")

    @pytest.mark.parametrize("ltst,band", [("00:00", 1), ("12:00", 13), ("23:00", 24)])
    def test_banda_por_hora_lee_el_paso_del_index(self, data_dir, ltst, band):
        stack = ShadowStack(write_shadow_stack(data_dir))
        assert stack.band_for_ltst(ltst) == band

    @pytest.mark.parametrize("ltst", ["12:30", "12:99", "24:00", "mediodía"])
    def test_hora_invalida_o_fuera_del_paso(self, data_dir, ltst):
        stack = ShadowStack(write_shadow_stack(data_dir))
        with pytest.raises(ValueError):
            stack.band_for_ltst(ltst)


class TestWindowEndpoint:
    def test_sin_pila_responde_503(self, client, site):
        res = client.post("/api/illumination/window", json=window_req(ltst="12:00"))
        assert res.status_code == 503
        assert "pipeline/illumination.py" in res.json()["detail"]

    def test_sin_manifest_responde_404(self, client, data_dir):
        assert client.post("/api/illumination/window", json=window_req(ltst="12:00")).status_code == 404

    def test_pide_ltst_o_band(self, client, site):
        assert client.post("/api/illumination/window", json=window_req()).status_code == 422
        assert client.post("/api/illumination/window", json=window_req(ltst="12:00", band=13)).status_code == 422

    def test_sol_tag_con_ruta_se_rechaza(self, client, site):
        res = client.post("/api/illumination/window", json=window_req(ltst="12:00", sol_tag="../../.."))
        assert res.status_code == 422

    def test_devuelve_sol_sombra_y_sin_dato(self, client, site):
        band = np.ones((N, N), dtype=np.uint8)
        band[10, 10] = 0
        band[12, 14] = 255
        write_shadow_stack(site, {13: band})
        res = client.post("/api/illumination/window", json=window_req(ltst="12:00"))
        assert res.status_code == 200
        body = res.json()
        assert body["shape"] == [3, 5]
        assert body["window"] == {"row_start": 10, "row_end": 12, "col_start": 10, "col_end": 14}
        assert body["values"][0][0] is False
        assert body["values"][2][4] is None
        assert body["values"][1][2] is True
        assert body["cell_ground_m"] == [pytest.approx(4.743, abs=1e-3), 5.0]
        assert body["provenance"] == "DERIVED"

    def test_punto_fuera_de_la_pila_responde_422(self, client, site):
        write_shadow_stack(site)
        la, lo = latlon(N + 20, 5)
        body = window_req(ltst="12:00") | {"p2": {"lat": la, "lon": lo}}
        assert client.post("/api/illumination/window", json=body).status_code == 422
