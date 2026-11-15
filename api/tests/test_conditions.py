"""GET /api/sites/{site}/conditions: franja de condiciones actuales.

Hoy no hay paso del pipeline que baje MEDA/REMS ni DONKI: el endpoint tiene que
decir que falta, nunca devolver números de ejemplo.
"""
import pytest


@pytest.mark.parametrize("site", ["jezero", "gale"])
def test_sin_datos_todo_falta(client, data_dir, site):
    res = client.get(f"/api/sites/{site}/conditions")
    assert res.status_code == 200
    body = res.json()
    assert body["site"] == site
    assert [o["id"] for o in body["observations"]] == ["temperature", "pressure", "dust_opacity"]
    for obs in body["observations"]:
        assert obs["value"]["value"] is None
        assert obs["when"] is None
        assert obs["label"]  # texto en español para la UI
    assert body["alerts"] == []
    assert body["alerts_status"] == "missing"
    assert body["note"]


def test_instrumento_segun_el_rover(client, data_dir):
    jezero = client.get("/api/sites/jezero/conditions").json()["observations"]
    gale = client.get("/api/sites/gale/conditions").json()["observations"]
    assert {o["value"]["mission"] for o in jezero} == {"Mars 2020"}
    assert {o["value"]["mission"] for o in gale} == {"MSL"}
    assert jezero[0]["value"]["instrument"] == "MEDA"
    assert gale[0]["value"]["instrument"] == "REMS"


@pytest.mark.parametrize("site", ["marte", "common", "..", "Jezero"])
def test_sitio_desconocido_404(client, data_dir, site):
    assert client.get(f"/api/sites/{site}/conditions").status_code == 404
