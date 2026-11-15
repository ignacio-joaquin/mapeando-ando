"""Ajustes del planificador: GET /api/route/params y `params` en POST /api/route."""
from api import main
from api.consumables import SuitParams
from api.planner import CostWeights
from api.safety import Limits

from .test_directions import route_request, site  # noqa: F401  (fixture)


def _limit(res_json: dict, lid: str) -> dict:
    return next(x for x in res_json["verdict"]["limits"] if x["id"] == lid)


class TestParamsEndpoint:
    def test_responde_sin_manifest(self, client, data_dir):
        res = client.get("/api/route/params")
        assert res.status_code == 200
        assert [g["id"] for g in res.json()["groups"]] == ["limits", "weights", "suit"]

    def test_los_defaults_salen_de_las_dataclasses(self, client, data_dir):
        groups = {g["id"]: {f["id"]: f for f in g["fields"]} for g in client.get("/api/route/params").json()["groups"]}
        assert groups["limits"]["max_slope_deg"]["default"] == Limits().max_slope_deg
        assert groups["weights"]["slope"]["default"] == CostWeights().slope
        assert groups["suit"]["o2_capacity_kg"]["default"] == SuitParams().o2_capacity_kg

    def test_cada_ajuste_trae_rango_unidad_y_texto(self, client, data_dir):
        for g in client.get("/api/route/params").json()["groups"]:
            assert g["label"]
            for f in g["fields"]:
                assert f["label"] and f["help"]
                assert f["min"] is not None and f["max"] is not None
                assert f["min"] <= f["default"] <= f["max"]


class TestRouteWithParams:
    def test_sin_params_el_resumen_no_habla_de_ajustes(self, client, site):  # noqa: F811
        res = client.post("/api/route", json=route_request((-300, 0), (300, 0)))
        assert res.status_code == 200
        assert "ajustes del usuario" not in res.json()["verdict"]["summary"]

    def test_un_limite_cambiado_llega_al_veredicto_y_se_declara(self, client, site):  # noqa: F811
        req = route_request((-300, 0), (300, 0))
        req["params"] = {"limits": {"max_slope_deg": 12}}
        res = client.post("/api/route", json=req)
        assert res.status_code == 200
        body = res.json()
        assert _limit(body, "terrain")["limit"]["value"] == 12
        assert "ajustes del usuario" in body["verdict"]["summary"]
        assert "Pendiente máxima 12" in body["verdict"]["summary"]

    def test_params_iguales_al_default_no_se_declaran(self, client, site):  # noqa: F811
        req = route_request((-300, 0), (300, 0))
        req["params"] = {"limits": {"max_slope_deg": Limits().max_slope_deg}, "weights": {}, "suit": {}}
        res = client.post("/api/route", json=req)
        assert res.status_code == 200
        assert "ajustes del usuario" not in res.json()["verdict"]["summary"]

    def test_mas_capacidad_de_o2_deja_mas_o2_al_llegar(self, client, site):  # noqa: F811
        base = client.post("/api/route", json=route_request((-300, 0), (300, 0))).json()
        req = route_request((-300, 0), (300, 0))
        req["params"] = {"suit": {"o2_capacity_kg": 2 * SuitParams().o2_capacity_kg}}
        more = client.post("/api/route", json=req).json()
        assert more["stops"][-1]["o2_remaining"]["value"] > base["stops"][-1]["o2_remaining"]["value"]

    def test_valor_fuera_de_rango_es_422(self, client, site):  # noqa: F811
        req = route_request((-300, 0), (300, 0))
        req["params"] = {"limits": {"max_slope_deg": 90}}
        assert client.post("/api/route", json=req).status_code == 422

    def test_ajuste_desconocido_es_422(self, client, site):  # noqa: F811
        req = route_request((-300, 0), (300, 0))
        req["params"] = {"limits": {"pendiente": 10}}
        assert client.post("/api/route", json=req).status_code == 422

    def test_con_params_y_sin_manifest_sigue_siendo_404(self, client, data_dir):
        req = route_request((-300, 0), (300, 0))
        req["params"] = {"limits": {"max_slope_deg": 12}}
        assert client.post("/api/route", json=req).status_code == 404


def test_changed_describe_solo_lo_que_cambia():
    p = main.PlannerParams(limits={"dose_budget_msv": 1.0}, suit={"cargo_kg": 10})
    assert p.changed() == ["Presupuesto de dosis 1 mSv", "Carga 10 kg"]
