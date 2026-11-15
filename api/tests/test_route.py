"""/api/route/consumables. El planificador 4D (/api/route) está en test_planner.py."""
import pytest


# Ruta ya armada con cotas: no necesita DTM ni manifest.
CONSUMABLES_WITH_ELEV = {
    "points": [
        {"lat": 18.444, "lon": 77.450, "elev_m": -2500.0},
        {"lat": 18.460, "lon": 77.420, "elev_m": -2440.0},
    ],
}

CONSUMABLES_FROM_DTM = {
    "site_id": "jezero",
    "points": [{"lat": 18.444, "lon": 77.450}, {"lat": 18.460, "lon": 77.420}],
}


class TestConsumables:
    def test_calcula_con_cotas_del_pedido(self, client, data_dir):
        res = client.post("/api/route/consumables", json=CONSUMABLES_WITH_ELEV)
        assert res.status_code == 200
        body = res.json()
        assert body["elevation_source"] == "request"
        assert len(body["segments"]) == 1
        seg = body["segments"][0]
        assert seg["from"]["elev_m"] == -2500.0
        assert seg["to"]["elev_m"] == -2440.0

    def test_sin_manifest_dice_que_faltan_los_datos(self, client, data_dir):
        res = client.post("/api/route/consumables", json=CONSUMABLES_FROM_DTM)
        assert res.status_code == 404
        assert "todavía no descargados" in res.json()["detail"]

    def test_manifest_sin_dtm_ok_responde_503(self, client, write_manifest):
        write_manifest(
            {
                "sites": {
                    "jezero": {
                        "files": [
                            {"key": "dtm", "status": "error"},
                            {"key": "ortho", "status": "ok", "path": "raw/jezero/ortho.tif"},
                        ]
                    }
                }
            }
        )
        res = client.post("/api/route/consumables", json=CONSUMABLES_FROM_DTM)
        assert res.status_code == 503
        assert "DTM" in res.json()["detail"]

    def test_la_ruta_vieja_ya_no_acepta_el_contrato_de_consumibles(self, client, data_dir):
        # Quien siga pegándole a /api/route con `points` recibe un 422 con la
        # ruta nueva en el mensaje, no un cálculo silencioso.
        res = client.post("/api/route", json=CONSUMABLES_WITH_ELEV)
        assert res.status_code == 422
        assert "/api/route/consumables" in str(res.json()["detail"])


def _with_stop(dwell_min: float | None, **extra) -> dict:
    """Salida, una parada en el medio y llegada, con cotas: no necesita DTM."""
    mid = {"lat": 18.452, "lon": 77.435, "elev_m": -2470.0}
    if dwell_min is not None:
        mid["dwell_min"] = dwell_min
    a, b = (dict(p) for p in CONSUMABLES_WITH_ELEV["points"])  # copias: los tests las modifican
    points = [a, mid, b]
    return {"points": points, **extra}


class TestConsumablesConPermanencia:
    def test_la_permanencia_entra_en_el_tramo_que_llega_a_la_parada(self, client, data_dir):
        sin = client.post("/api/route/consumables", json=_with_stop(None)).json()
        con = client.post("/api/route/consumables", json=_with_stop(30)).json()
        s0, c0 = sin["segments"][0], con["segments"][0]
        assert s0["dwell_s"] == 0 and c0["dwell_s"] == 30 * 60
        assert c0["elapsed_s"] == pytest.approx(s0["elapsed_s"] + 30 * 60)
        assert c0["o2_cum_kg"] == pytest.approx(s0["o2_cum_kg"] + c0["dwell_o2_kg"])
        # Los totales son el último acumulado: no hay una cuenta aparte para la permanencia.
        last = con["segments"][-1]
        assert con["totals"]["duration_s"] == pytest.approx(last["elapsed_s"])
        assert con["totals"]["o2_kg"] == pytest.approx(last["o2_cum_kg"])
        assert con["totals"]["o2_remaining_pct"] == pytest.approx(last["o2_remaining_pct"])
        assert con["totals"]["energy_kj"] > sin["totals"]["energy_kj"]

    def test_si_el_o2_se_agota_en_la_parada_lo_avisa(self, client, data_dir):
        body = client.post("/api/route/consumables",
                           json=_with_stop(600, suit={"o2_capacity_kg": 0.05})).json()
        assert body["totals"]["o2_exhausted_at_segment"] == 0
        assert any("O2" in w and "tramo 0" in w for w in body["warnings"])

    def test_en_la_salida_y_en_la_llegada_no_cuenta(self, client, data_dir):
        base = client.post("/api/route/consumables", json=_with_stop(None)).json()
        req = _with_stop(None)
        req["points"][0]["dwell_min"] = 60
        req["points"][-1]["dwell_min"] = 60
        body = client.post("/api/route/consumables", json=req).json()
        assert body["totals"]["duration_s"] == pytest.approx(base["totals"]["duration_s"])
