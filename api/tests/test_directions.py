"""Indicaciones por landmarks (api/directions.py) sobre terreno sintético.

El terreno es una grilla lat/lon armada a mano (Field), así cada caso controla qué se
ve y qué no: una llanura, cráteres con borde, una loma que tapa, el interior de un
cráter grande. Al final, /api/route de punta a punta con rasters en disco.
"""
import json
import math

import numpy as np
import pytest

from api import directions as dr
from api.directions import Field, Landmark, Terrain

from .rasters import iso, band_time, manifest, write_terrain, N

LAT0, LON0 = 18.44, 77.45
K = math.pi / 180 * dr.MARS_RADIUS_M          # metros por grado de latitud
KX = K * math.cos(math.radians(LAT0))         # metros por grado de longitud acá


def at(east_m: float, north_m: float) -> tuple[float, float]:
    """(lat, lon) a tantos metros al este y al norte del origen."""
    return LAT0 + north_m / K, LON0 + east_m / KX


def terrain(fn, half_m: float = 25_000.0, cell_m: float = 25.0) -> Terrain:
    """Grilla lat/lon de ±half_m alrededor del origen con z = fn(este_m, norte_m)."""
    n = int(2 * half_m / cell_m)
    dlat, dlon = cell_m / K, cell_m / KX
    lat_max, lon_min = LAT0 + half_m / K, LON0 - half_m / KX
    rows = (np.arange(n) + 0.5)
    lats = lat_max - rows * dlat
    lons = lon_min + rows * dlon
    north = (lats - LAT0) * K
    east = (lons - LON0) * KX
    E, Nn = np.meshgrid(east, north)
    return Terrain([Field(fn(E, Nn).astype(np.float64), lat_max, lon_min, dlat, dlon, "HiRISE DTM", cell_m)])


def ring(cx, cy, r, height, width=None):
    """Borde de cráter: un anillo gaussiano de `height` m en el radio `r`."""
    w = width or max(r * 0.15, 60.0)

    def f(E, Nn):
        d = np.hypot(E - cx, Nn - cy)
        return height * np.exp(-((d - r) / w) ** 2)
    return f


def flat(E, Nn):
    return np.zeros_like(E)


def robbins(cid: str, east_m: float, north_m: float, diam_km: float) -> dict:
    lat, lon = at(east_m, north_m)
    return {"id": f"robbins-{cid}", "name": f"Cráter {cid}", "kind": "crater",
            "detail": f"Cráter de {diam_km:.2f} km (catálogo de Robbins)".replace(".", ","),
            "lat": lat, "lon": lon}


def iau(name: str, east_m: float, north_m: float, ftype: str, diam_km: float | None = None) -> dict:
    lat, lon = at(east_m, north_m)
    detail = ftype + (f" · {diam_km:.1f} km".replace(".", ",") if diam_km else "")
    return {"id": f"iau-{name}", "name": name, "kind": "iau", "detail": detail, "lat": lat, "lon": lon}


def walk(*pts_m) -> list[tuple[float, float]]:
    """Polilínea densa (cada 10 m) entre puntos en metros, como sale del A*."""
    out = []
    for (x0, y0), (x1, y1) in zip(pts_m[:-1], pts_m[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) // 10))
        out += [at(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(n)]
    out.append(at(*pts_m[-1]))
    return out


class TestTrechos:
    def test_tramo_recto_es_un_solo_trecho(self):
        st = dr.stretches(walk((0, 0), (1500, 0)))
        assert len(st) == 1
        assert st[0].heading == pytest.approx(90, abs=1)
        assert st[0].length_m == pytest.approx(1500, rel=0.01)

    def test_un_giro_de_90_grados_parte_el_tramo(self):
        st = dr.stretches(walk((0, 0), (1000, 0), (1000, 800)))
        assert len(st) == 2
        assert st[1].turn_deg == pytest.approx(-90, abs=3)      # de este a norte: izquierda
        assert st[1].start_m == pytest.approx(1000, rel=0.02)

    def test_el_escalonado_de_las_celdas_no_cuenta_como_giro(self):
        # Diagonal en escalera de 10 m, como camina el A* sobre la grilla.
        pts = [(0, 0)]
        for k in range(60):
            x, y = pts[-1]
            pts.append((x + 10, y) if k % 2 == 0 else (x, y + 10))
        st = dr.stretches(walk(*pts))
        assert len(st) == 1
        assert st[0].heading == pytest.approx(45, abs=5)


class TestCatalogo:
    def test_entran_crateres_grandes_y_relieve_con_nombre(self):
        lms = dr.landmarks_from_places([
            robbins("18-1", 0, 0, 1.4),
            robbins("18-2", 0, 0, 0.6),                       # < 1 km: catálogo incompleto, no entra
            iau("Jezero", 0, 0, "Crater, craters", 49.0),
            iau("Neretva", 0, 0, "Vallis, valles"),           # un valle no es un punto
            {"id": "rover-1", "name": "Sol 100", "kind": "rover", "detail": "", "lat": 1, "lon": 1},
        ])
        assert [(lm.name, lm.catalog) for lm in lms] == [("Cráter 18-1", "Robbins"), ("Jezero", "IAU")]
        assert lms[0].radius_m == pytest.approx(700)
        assert lms[1].label == "el cráter Jezero"

    def test_los_cerros_del_dtm_entran_como_extraidos_del_relieve(self):
        lat, lon = at(0, 0)
        cerro = {"id": "cerro-3", "name": "Cerro sin nombre 3", "kind": "landmark",
                 "detail": "Se eleva 42 m sobre su entorno (radio 500 m)", "lat": lat, "lon": lon}
        hondonada = cerro | {"id": "hondo-1", "name": "Hondonada 1", "kind": "depression"}
        lms = dr.landmarks_from_places([cerro, hondonada])
        assert [(lm.catalog, lm.shape, lm.label) for lm in lms] == [("DEM", "peak", "el cerro sin nombre 3")]

    def test_un_cerro_al_frente(self):
        hill = lambda E, Nn: 60 * np.exp(-(np.hypot(E - 3000, Nn) / 250) ** 2)
        lat, lon = at(3000, 0)
        cerro = {"id": "cerro-1", "name": "Cerro sin nombre 1", "kind": "landmark", "detail": "", "lat": lat, "lon": lon}
        out = dr.leg_directions(walk((0, 0), (1500, 0)), terrain(hill), dr.landmarks_from_places([cerro]))
        assert out[0]["kind"] == "toward"
        assert out[0]["landmark"]["source"] == "DEM"
        assert out[0]["text"] == "Caminá 1,5 km hacia el cerro sin nombre 1, a las 12."
        assert out[0]["clock"] == 12

    def test_size_km_le_gana_al_texto(self):
        p = robbins("18-3", 0, 0, 2.0) | {"size_km": 3.0}
        assert dr.landmarks_from_places([p])[0].radius_m == pytest.approx(1500)


def test_contracciones():
    assert dr._contract("a", "el cráter X") == "al cráter X"
    assert dr._contract("de", "el cráter X") == "del cráter X"
    assert dr._contract("a", "la mesa X") == "a la mesa X"


class TestIndicaciones:
    def test_crater_al_frente(self):
        t = terrain(ring(4000, 0, 1000, 80))
        lms = dr.landmarks_from_places([robbins("18-7", 4000, 0, 2.0)])
        out = dr.leg_directions(walk((0, 0), (1500, 0)), t, lms)
        assert [d["kind"] for d in out] == ["toward"]
        d = out[0]
        assert d["landmark"]["source"] == "Robbins"
        assert d["text"] == "Caminá 1,5 km hacia el cráter sin nombre de 2,0 km (Robbins 18-7), a las 12."
        assert d["checks"][0]["kind"] == "landmark"
        assert "loma baja (el borde) a unos" in d["checks"][0]["text"]
        assert d["visible_fraction"]["value"] >= 0.5
        assert d["visible_fraction"]["provenance"] == "DERIVED"
        assert abs(d["relative_bearing_deg"]) <= 15

    def test_crater_al_costado(self):
        t = terrain(ring(800, 3000, 800, 80))
        lms = dr.landmarks_from_places([robbins("18-8", 800, 3000, 1.6)])
        out = dr.leg_directions(walk((0, 0), (1500, 0)), t, lms)
        assert out[0]["kind"] == "keep_left"
        assert out[0]["text"].endswith("a las 9.") and out[0]["clock"] == 9

    def test_una_loma_en_el_medio_lo_tapa_y_va_el_respaldo(self):
        def f(E, Nn):
            loma = 300 * np.exp(-((E - 2200) / 300) ** 2)    # muralla norte-sur entre medio
            return loma + ring(5000, 0, 1000, 60)(E, Nn)
        lms = dr.landmarks_from_places([robbins("18-9", 5000, 0, 2.0)])
        out = dr.leg_directions(walk((0, 0), (1500, 0)), terrain(f), lms)
        assert [d["kind"] for d in out] == ["fallback_bearing"]
        assert out[0]["landmark"] is None
        assert out[0]["text"].startswith("Sin referencia visible: mantené el rumbo 090° (E) durante 1,5 km")
        assert out[0]["visible_fraction"]["value"] is None

    def test_adentro_de_un_crater_grande_se_mira_el_borde_hacia_donde_se_camina(self):
        t = terrain(ring(0, 0, 12_000, 700), half_m=16_000, cell_m=50)
        lms = dr.landmarks_from_places([iau("Jezero", 0, 0, "Crater, craters", 24.0)])
        out = dr.leg_directions(walk((0, 0), (-1500, 0)), t, lms)
        assert out[0]["kind"] == "toward"
        assert "hacia el borde oeste del cráter Jezero" in out[0]["text"]
        assert "target" in out[0]["landmark"]

    def test_un_giro_se_anuncia_con_el_landmark_del_trecho_siguiente(self):
        t = terrain(ring(1000, 5000, 1000, 120))
        lms = dr.landmarks_from_places([robbins("18-10", 1000, 5000, 2.0)])
        out = dr.leg_directions(walk((0, 0), (1000, 0), (1000, 1200)), t, lms)
        assert [d["kind"] for d in out][-1] == "turn"     # una indicación por trecho
        turn = out[-1]
        assert turn["text"].startswith("Girá a la izquierda hasta tener el cráter sin nombre")
        assert turn["text"].endswith("a las 12 y caminá 1,2 km.")
        assert turn["landmark"]["name"] == "Cráter 18-10"

    def test_nunca_se_inventa_un_landmark_lejano(self):
        t = terrain(flat)
        lms = dr.landmarks_from_places([robbins("18-11", 60_000, 0, 3.0)])
        out = dr.leg_directions(walk((0, 0), (1000, 0)), t, lms)
        assert all(d["kind"].startswith("fallback") and d["landmark"] is None for d in out)

    def test_sin_catalogo_lo_dice_en_el_respaldo(self):
        out = dr.leg_directions(walk((0, 0), (1000, 0)), None, None, "Sin catálogo de landmarks (falta places.json)")
        assert out[0]["kind"] == "fallback_bearing"
        assert out[0]["text"].startswith("Sin catálogo de landmarks (falta places.json): mantené el rumbo")

    def test_sin_terreno_en_la_linea_de_vista_no_dice_que_no_hay_nada(self):
        # Terreno solo debajo del caminante: hacia el cráter no hay dato.
        t = terrain(flat, half_m=2000)
        lms = dr.landmarks_from_places([robbins("18-12", 6000, 0, 2.0)])
        out = dr.leg_directions(walk((0, 0), (1000, 0)), t, lms)
        assert out[0]["text"].startswith("No se pudo evaluar qué se ve")


# ------------------------------------------------------------ reloj, Sol, unicidad, parada, hábitat

from api.mars_time import ltst_hours  # noqa: E402


def t_at_ltst(hour: float, lon: float = LON0) -> float:
    """Un instante del 15/11/2026 en que la hora solar local en `lon` es `hour`."""
    t = 1794700800.0
    while abs(ltst_hours(t, lon) - hour) > 0.02:
        t += 60.0
    return t


class TestRelojYCuerpo:
    @pytest.mark.parametrize("rel,c", [(0, 12), (29, 1), (90, 3), (180, 6), (-90, 9), (-35, 11)])
    def test_reloj(self, rel, c):
        assert dr.clock(rel) == c

    def test_a_la_1_y_a_las_n(self):
        assert dr.at_clock(30) == "a la 1" and dr.at_clock(60) == "a las 2"

    @pytest.mark.parametrize("rel,txt", [(0, "de frente"), (45, "adelante a la derecha"),
                                         (-90, "sobre el hombro izquierdo"), (135, "atrás a la derecha"),
                                         (180, "en la espalda")])
    def test_sol_respecto_del_cuerpo(self, rel, txt):
        assert dr.body_side(rel) == txt


class TestSol:
    def test_mars24_al_mediodia_el_sol_esta_al_sur_y_arriba(self):
        lat, lon = at(0, 0)
        sun = dr.sun_mars24(t_at_ltst(12.0), lat, lon)
        assert 150 < sun.az < 210 and sun.el > 40
        assert sun.src["provenance"] == "MODELED"

    def test_mars24_a_la_manana_el_sol_esta_al_este_y_bajo(self):
        lat, lon = at(0, 0)
        sun = dr.sun_mars24(t_at_ltst(8.0), lat, lon)
        assert 60 < sun.az < 120 and 5 < sun.el < 45

    def test_la_pila_de_sombras_le_gana_a_mars24_e_interpola(self, tmp_path):
        from api.illumination import ShadowStack
        from .rasters import band_time, write_shadow_stack
        d = write_shadow_stack(tmp_path)
        idx = json.loads((d / "index.json").read_text())
        for b in idx["shadow_hourly"]["bands"]:
            b["sun_az_deg"] = 10.0 * b["band"]
        (d / "index.json").write_text(json.dumps(idx))
        stack = ShadowStack(d)
        t = (band_time(12) + band_time(13)) / 2
        sun = dr.sun_at(stack, t, LAT0, LON0)
        assert sun.az == pytest.approx(125.0, abs=0.5)
        assert sun.src["instrument"] == "SPICE"

    def test_sin_landmarks_el_respaldo_es_el_sol_con_hombro_y_sombra(self):
        leg = dr.LegInput(walk((0, 0), (1500, 0)), t_start=t_at_ltst(9.0), duration_s=1800.0)
        out = dr.leg_directions(leg, ctx=dr.Context(terrain(flat), [], None))
        d = out[0]
        assert d["kind"] == "fallback_sun"
        assert d["text"].startswith("Sin referencia visible: caminá unos 30 min (1,5 km) con el Sol ")
        assert "tu sombra hacia las" in d["text"]
        assert d["sun"]["elevation_deg"] > 3

    def test_con_el_sol_muy_alto_no_se_usa_y_se_dice(self):
        leg = dr.LegInput(walk((0, 0), (1500, 0)), t_start=t_at_ltst(12.0), duration_s=1800.0)
        d = dr.leg_directions(leg, ctx=dr.Context(terrain(flat), [], None))[0]
        assert d["kind"] == "fallback_bearing"
        assert any(c["kind"] == "sun" and "muy alto" in c["text"] for c in d["checks"])

    def test_con_landmark_el_sol_va_como_confirmacion(self):
        lms = dr.landmarks_from_places([robbins("18-30", 4000, 0, 2.0)])
        leg = dr.LegInput(walk((0, 0), (1500, 0)), t_start=t_at_ltst(9.0), duration_s=1800.0)
        d = dr.leg_directions(leg, ctx=dr.Context(terrain(ring(4000, 0, 1000, 80)), lms, None))[0]
        assert d["kind"] == "toward"
        assert d["text"] == "Caminá unos 30 min (1,5 km) hacia el cráter sin nombre de 2,0 km (Robbins 18-30), a las 12."
        assert [c["kind"] for c in d["checks"]] == ["landmark", "sun"]


class TestUnicidad:
    def test_dos_crateres_parecidos_hacia_el_mismo_lado_se_distinguen(self):
        # Lado a lado, iguales, a ~7° a cada lado de la marcha: se distinguen por la posición.
        f = lambda E, Nn: ring(6000, 650, 500, 60)(E, Nn) + ring(6000, -650, 500, 60)(E, Nn)
        lms = dr.landmarks_from_places([robbins("18-41", 6000, 650, 1.0), robbins("18-42", 6000, -650, 1.0)])
        d = dr.leg_directions(walk((0, 0), (1500, 0)), terrain(f), lms)[0]
        assert ("el de más a la izquierda de los dos que se ven hacia ahí" in d["text"]
                or "el de más a la derecha de los dos que se ven hacia ahí" in d["text"])

    def test_un_crater_solo_no_lleva_aclaracion(self):
        lms = dr.landmarks_from_places([robbins("18-43", 4000, 0, 2.0)])
        d = dr.leg_directions(walk((0, 0), (1500, 0)), terrain(ring(4000, 0, 1000, 80)), lms)[0]
        assert "que se ven hacia ahí" not in d["text"]


class TestParada:
    def test_un_crater_al_costado_al_final_es_la_senal_de_parada(self):
        f = lambda E, Nn: ring(5000, 0, 1000, 80)(E, Nn) + ring(1500, -2500, 700, 70)(E, Nn)
        lms = dr.landmarks_from_places([robbins("18-50", 5000, 0, 2.0), robbins("18-51", 1500, -2500, 1.4)])
        d = dr.leg_directions(walk((0, 0), (1500, 0)), terrain(f), lms)[0]
        assert d["until"]["landmark"]["name"] == "Cráter 18-51"
        assert d["until"]["text"] == "Llegaste cuando el cráter sin nombre de 1,4 km (Robbins 18-51) te quede a las 3."

    def test_sin_nada_al_costado_no_hay_senal(self):
        lms = dr.landmarks_from_places([robbins("18-52", 5000, 0, 2.0)])
        d = dr.leg_directions(walk((0, 0), (1500, 0)), terrain(ring(5000, 0, 1000, 80)), lms)[0]
        assert d["until"] is None


class FakeContact:
    """Línea de vista al hábitat: se ve desde todos lados."""
    resolution = "DTM promediado a 10 m"

    def visible_latlon(self, pts):
        return [True for _ in pts]


class TestHabitat:
    def test_volviendo_el_mastil_es_la_referencia(self):
        hab = at(0, 0)
        ctx = dr.Context(None, None, "Sin catálogo de landmarks (falta places.json)", None, FakeContact(), hab)
        d = dr.leg_directions(walk((2000, 0), (300, 0)), ctx=ctx)[0]
        assert d["kind"] == "toward"
        assert d["landmark"]["source"] == "habitat"
        assert d["text"] == "Caminá 1,7 km hacia el mástil del hábitat, a las 12."

    def test_yendo_el_mastil_confirma_a_la_espalda(self):
        hab = at(0, 0)
        lms = dr.landmarks_from_places([robbins("18-60", 5000, 0, 2.0)])
        ctx = dr.Context(terrain(ring(5000, 0, 1000, 80)), lms, None, None, FakeContact(), hab)
        d = dr.leg_directions(walk((300, 0), (1800, 0)), ctx=ctx)[0]
        assert d["landmark"]["source"] == "Robbins"
        assert any(c["kind"] == "habitat" and c["text"] == "El mástil del hábitat se ve a las 6, a tu espalda."
                   for c in d["checks"])


# ------------------------------------------------------------ /api/route de punta a punta


def write_dem(path, fn, cell_m=100.0, half_m=10_000.0):
    """DEM en equirectangular marciano (metros), como el recorte de MOLA-HRSC."""
    import rasterio
    from rasterio.transform import from_origin
    from .rasters import CRS, R
    n = int(2 * half_m / cell_m)
    # El CRS de los tests tiene lat_ts=0: x = R·lon, y = R·lat (en radianes).
    x0 = R * math.radians(LON0) - half_m / math.cos(math.radians(LAT0))
    y0 = R * math.radians(LAT0) + half_m
    px_x = cell_m / math.cos(math.radians(LAT0))
    cols = (np.arange(n) + 0.5) * px_x + x0
    rows = y0 - (np.arange(n) + 0.5) * cell_m
    east = (np.degrees(cols / R) - LON0) * KX
    north = (np.degrees(rows / R) - LAT0) * K
    E, Nn = np.meshgrid(east, north)
    z = fn(E, Nn).astype("float32")
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32", crs=CRS,
                       transform=from_origin(x0, y0, px_x, cell_m), nodata=-9999.0) as ds:
        ds.write(z[None])


@pytest.fixture
def site(data_dir, write_manifest):
    m = manifest()
    m["sites"]["jezero"]["files"] = [{"key": "dem200_crop", "status": "ok", "path": "raw/jezero/dem200_crop.tif"}]
    write_manifest(m)
    write_terrain(data_dir, np.full((N, N), 2.0, dtype=np.float32), np.zeros((N, N), dtype=np.float32))
    return data_dir


def route_request(*pts_m):
    return {"site": "jezero", "depart_utc": iso(band_time(13)),
            "waypoints": [{"lat": la, "lon": lo, "task": None, "dwell_min": 0} for la, lo in (at(*p) for p in pts_m)]}


def test_api_route_sin_places_json_no_nombra_rasgos_y_usa_el_habitat(client, site):
    res = client.post("/api/route", json=route_request((-300, 0), (300, 0)))
    assert res.status_code == 200
    dirs = res.json()["legs"][0]["directions"]
    # Sin catálogo no hay cráteres ni cerros; lo único que se puede nombrar es el hábitat.
    assert dirs and all(d["landmark"] is None or d["landmark"]["source"] == "habitat" for d in dirs)
    assert all(d["duration"]["value"] is not None for d in dirs)


def test_api_route_sin_places_ni_hab_visible_dice_que_falta_el_catalogo(client, site):
    res = client.post("/api/route", json=route_request((-50, 0), (300, 0)))
    dirs = res.json()["legs"][0]["directions"]
    fb = [d for d in dirs if d["landmark"] is None]
    assert all("falta places.json" in d["text"] for d in fb)


def test_api_route_encuentra_el_crater_con_el_dem(client, site):
    write_dem(site / "raw" / "jezero" / "dem200_crop.tif", ring(4000, 0, 1000, 120))
    places = {"site": "jezero", "generated_at": "x", "sources": {},
              "places": [robbins("18-20", 4000, 0, 2.0), iau("Neretva", 0, 0, "Vallis, valles")]}
    (site / "output" / "jezero" / "places.json").write_text(json.dumps(places))
    res = client.post("/api/route", json=route_request((-300, 0), (300, 0)))
    assert res.status_code == 200
    d = res.json()["legs"][0]["directions"][0]
    assert d["kind"] == "toward", d["text"]
    assert d["landmark"]["id"] == "robbins-18-20"
    assert d["visible_fraction"]["instrument"] == "línea de vista"
    assert "DEM MOLA-HRSC" in d["visible_fraction"]["source"]


def test_api_route_no_se_cae_si_falla_el_calculo(client, site, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("roto")
    monkeypatch.setattr(dr, "route_directions", boom)
    res = client.post("/api/route", json=route_request((-300, 0), (300, 0)))
    assert res.status_code == 200
    assert "directions" not in res.json()["legs"][0]
