"""GET /api/sites/{site_id}/point: elevación y pendiente en un punto.

El DTM de los tests es un plano inclinado con pendiente conocida, así se
verifica el número y no solo que el endpoint conteste.
"""
import math

import pytest

rasterio = pytest.importorskip("rasterio", reason="el muestreo del DTM necesita rasterio")
numpy = pytest.importorskip("numpy")

from api.terrain import MARS_RADIUS_M  # noqa: E402

CENTRO = (18.488, 77.403)          # centro de Jezero
PX = 200                           # 200x200 px
RES_M = 1.0                        # 1 m/px, como el DTM HiRISE real
PENDIENTE_OBJETIVO_DEG = 10.0      # el plano se arma para dar exactamente esto

# El endpoint muestrea a ±5 m con vecino más cercano sobre una grilla de 1 m, así
# que el redondeo mete hasta ~1°. Por eso la tolerancia no es más fina.
TOLERANCIA_DEG = 1.5


def _grados_a_m(deg: float) -> float:
    return math.radians(deg) * MARS_RADIUS_M


def _m_a_grados(m: float) -> float:
    return math.degrees(m / MARS_RADIUS_M)


@pytest.fixture
def dtm_plano(data_dir):
    """DTM sintético: plano que sube hacia el este con PENDIENTE_OBJETIVO_DEG."""
    import numpy as np
    from rasterio.transform import from_origin

    lat, lon = CENTRO
    # Un pixel de RES_M metros en la dirección este-oeste, a esta latitud.
    res_deg = _m_a_grados(RES_M) / math.cos(math.radians(lat))
    lado_deg = res_deg * PX
    subida_por_px = math.tan(math.radians(PENDIENTE_OBJETIVO_DEG)) * RES_M

    # z crece con la columna (hacia el este); constante en y.
    z = (np.arange(PX, dtype="float32") * subida_por_px)[None, :].repeat(PX, axis=0)

    ruta = data_dir / "raw" / "jezero" / "dtm.tif"
    ruta.parent.mkdir(parents=True, exist_ok=True)
    transform = from_origin(lon - lado_deg / 2, lat + lado_deg / 2, res_deg, res_deg)
    with rasterio.open(
        ruta, "w", driver="GTiff", height=PX, width=PX, count=1, dtype="float32",
        crs="+proj=longlat +R=3396190 +no_defs", transform=transform, nodata=-9999.0,
    ) as ds:
        ds.write(z, 1)
    return ruta


@pytest.fixture
def manifest_con_dtm(write_manifest, dtm_plano):
    write_manifest({
        "generated_at": "2026-11-14T00:00:00Z",
        "sites": {
            "jezero": {
                "name": "Jezero", "rover": "Perseverance (Mars 2020)",
                "center": {"lat": CENTRO[0], "lon": CENTRO[1]},
                "bbox": {"lat_min": 18.3, "lat_max": 18.7, "lon_min": 77.2, "lon_max": 77.6},
                "notes": None,
                "files": [{
                    "key": "dtm", "kind": "raster", "status": "ok",
                    "path": "raw/jezero/dtm.tif", "mission": "MRO HiRISE",
                    "desc": "DTM de prueba", "raster": {"pixel_size": 1.0},
                }],
            }
        },
    })


class TestConDtm:
    def test_devuelve_elevacion_y_pendiente_correctas(self, client, manifest_con_dtm):
        r = client.get("/api/sites/jezero/point", params={"lat": CENTRO[0], "lon": CENTRO[1]})
        assert r.status_code == 200
        cuerpo = r.json()

        assert cuerpo["elevation"]["value"] is not None
        assert cuerpo["elevation"]["unit"] == "m"
        assert cuerpo["elevation"]["provenance"] == "OBSERVED"

        assert cuerpo["slope"]["value"] == pytest.approx(PENDIENTE_OBJETIVO_DEG, abs=TOLERANCIA_DEG)
        assert cuerpo["slope"]["provenance"] == "DERIVED"
        assert cuerpo["slope"]["assumptions"], "la pendiente derivada tiene que declarar supuestos"

    def test_todo_valor_trae_procedencia(self, client, manifest_con_dtm):
        cuerpo = client.get("/api/sites/jezero/point",
                            params={"lat": CENTRO[0], "lon": CENTRO[1]}).json()
        for campo in ("elevation", "slope"):
            v = cuerpo[campo]
            assert set(v) >= {"value", "unit", "provenance", "mission", "instrument"}
            assert v["provenance"] in {"OBSERVED", "DERIVED", "MODELED"}

    def test_fuera_del_dtm_avisa_y_no_inventa(self, client, manifest_con_dtm):
        r = client.get("/api/sites/jezero/point", params={"lat": -4.5, "lon": 137.4})
        assert r.status_code == 200, "clic fuera del raster no es un error del servidor"
        cuerpo = r.json()
        assert cuerpo["elevation"]["value"] is None
        assert cuerpo["slope"]["value"] is None
        assert "fuera del DTM" in cuerpo["note"]

    def test_la_resolucion_sale_del_manifest(self, client, manifest_con_dtm):
        cuerpo = client.get("/api/sites/jezero/point",
                            params={"lat": CENTRO[0], "lon": CENTRO[1]}).json()
        assert cuerpo["elevation"]["resolution"] == "1 m/px"


class TestSinDatos:
    """Degradar, no romper: los datos tardan horas en bajar."""

    def test_sin_manifest_responde_vacio(self, client, data_dir):
        r = client.get("/api/sites/jezero/point", params={"lat": 18.5, "lon": 77.4})
        assert r.status_code == 200
        cuerpo = r.json()
        assert cuerpo["elevation"]["value"] is None
        assert "todavía no está descargado" in cuerpo["note"]

    def test_manifest_sin_dtm_ok_responde_vacio(self, client, write_manifest):
        write_manifest({
            "generated_at": "2026-11-14T00:00:00Z",
            "sites": {"jezero": {"name": "Jezero", "rover": "x",
                                 "center": {"lat": 18.4, "lon": 77.4},
                                 "bbox": {"lat_min": 0, "lat_max": 1, "lon_min": 0, "lon_max": 1},
                                 "notes": None,
                                 "files": [{"key": "dtm", "status": "error"}]}},
        })
        cuerpo = client.get("/api/sites/jezero/point",
                            params={"lat": 18.4, "lon": 77.4}).json()
        assert cuerpo["elevation"]["value"] is None

    def test_sitio_desconocido_es_404(self, client, write_manifest):
        write_manifest({"generated_at": "x", "sites": {}})
        r = client.get("/api/sites/marte/point", params={"lat": 0, "lon": 0})
        assert r.status_code == 404
