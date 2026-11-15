"""GET /api/sites/{site}/viewshed: zona con línea de vista al hábitat (api/viewshed.py)."""
import numpy as np
import pytest

from api import viewshed as vs
from api.contact import ContactField

from .rasters import N, latlon, manifest, write_terrain
from .test_planner import flat, loma

HABITAT = latlon(100, 40)          # al oeste de la loma de la columna 100


@pytest.fixture
def site(data_dir, write_manifest):
    write_manifest(manifest())
    return data_dir


def get(client, lat, lon, site="jezero"):
    return client.get(f"/api/sites/{site}/viewshed", params={"lat": lat, "lon": lon})


def test_sin_manifest_responde_404(client, data_dir):
    assert get(client, *HABITAT).status_code == 404


def test_sitio_desconocido_responde_404(client, site):
    assert get(client, *HABITAT, site="marte").status_code == 404


def test_sin_dtm_procesado_avisa_y_no_dibuja(client, site):
    r = get(client, *HABITAT)
    assert r.status_code == 200
    body = r.json()
    assert body["geojson"] is None and "DTM" in body["note"]


def test_habitat_fuera_del_dtm_avisa_y_no_dibuja(client, site):
    write_terrain(site, flat(), dtm=np.zeros((N, N), dtype=np.float32))
    body = get(client, *latlon(-500, -500)).json()
    assert body["geojson"] is None and "fuera del DTM" in body["note"]


def test_coordenadas_invalidas_responden_422(client, site):
    assert get(client, 95, 77).status_code == 422


def test_en_llano_todo_el_dtm_tiene_contacto(client, site):
    write_terrain(site, flat(), dtm=np.zeros((N, N), dtype=np.float32))
    body = get(client, *HABITAT).json()
    assert body["note"] is None
    classes = {f["properties"]["class"] for f in body["geojson"]["features"]}
    # El DTM sintético mide 1 km: lo que queda afuera del círculo de 3 km es "sin dato", nunca "sin contacto".
    assert classes == {"contact", "unknown"}
    assert body["fractions"]["no_contact"] == 0
    assert body["source"]["provenance"] == "MODELED"
    assert body["source"]["assumptions"]


def test_la_loma_tapa_lo_que_queda_detras(client, site):
    write_terrain(site, flat(), dtm=loma(height=8.0))
    body = get(client, *HABITAT).json()
    assert body["fractions"]["no_contact"] > 0
    # Coordenadas en lon/lat de Marte, cerca del sitio sintético.
    lon, lat = body["geojson"]["features"][0]["geometry"]["coordinates"][0][0]
    assert abs(lat - HABITAT[0]) < 0.1 and abs(lon - HABITAT[1]) < 0.1


def test_la_grilla_coincide_con_el_planificador(site):
    """Detrás de la loma la grilla da sin contacto, y del lado del hábitat, contacto:
    la misma respuesta que ContactField le da al planificador en esos puntos."""
    import rasterio

    out = write_terrain(site, flat(), dtm=loma(height=8.0))
    with rasterio.open(out / "dtm.tif") as ds:
        field = ContactField.from_dtm(ds, HABITAT, [HABITAT], margin_m=vs.RADIUS_M)
    detras, adelante = latlon(100, 160), latlon(100, 60)
    assert field.visible_latlon([detras, adelante]) == [False, True]

    classes, transform, cell_m = vs.classify(field, radius_m=800, side=64)
    assert cell_m == pytest.approx(25.0)
    from rasterio.warp import transform as warp
    from api.terrain import MARS_LONGLAT
    for (la, lo), want in ((detras, vs.NO_CONTACT), (adelante, vs.CONTACT)):
        xs, ys = warp(MARS_LONGLAT, field.crs, [lo], [la])
        c, r = ~transform @ (xs[0], ys[0])
        assert classes[int(r), int(c)] == want
