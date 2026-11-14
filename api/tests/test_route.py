"""/api/route (planificador 4D, todavía 501) y /api/route/consumables."""

# Lo que manda web/ (contrato de docs/context.md §4, RouteRequest en schemas.ts).
PLANNER_REQUEST = {
    "site": "jezero",
    "depart_utc": "2026-11-15T12:00:00.000Z",
    "waypoints": [
        {"lat": 18.444, "lon": 77.450, "task": None, "dwell_min": 0},
        {"lat": 18.460, "lon": 77.420, "task": "tomar muestra", "dwell_min": 0},
    ],
}

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


class TestPlannerRoute:
    def test_responde_501_con_el_contrato_del_frontend(self, client, data_dir):
        # 501 (no 422) es lo que hace que web/ pase al planificador de ejemplo.
        res = client.post("/api/route", json=PLANNER_REQUEST)
        assert res.status_code == 501
        assert "/api/route/consumables" in res.json()["detail"]

    def test_responde_501_sin_cuerpo(self, client, data_dir):
        assert client.post("/api/route").status_code == 501


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
        # Quien siga pegándole a /api/route con `points` recibe el 501 con la
        # ruta nueva en el mensaje, no un cálculo silencioso.
        res = client.post("/api/route", json=CONSUMABLES_WITH_ELEV)
        assert res.status_code == 501
