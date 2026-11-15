"""Reutilizar la pila de sombras de otro sol de la misma estación (api/illumination.py).

Con la misma hora solar local, el Sol solo cambia con su declinación, que sale de Ls.
Si el sol de la salida no se precomputó, se usa uno de la misma estación (de
cualquier año marciano) con |ΔLs| ≤ 2°, llevado a la fecha pedida y como MODELED.
"""
import datetime as dt
import math

import numpy as np
import pytest

from api import mars_time as mt
from api.illumination import SOL_REUSE_MAX_DLS_DEG, stack_for_time

from .rasters import BAND_S, LON0, N, iso, latlon, manifest, write_shadow_stack, write_terrain

MARS_YEAR_SOLS = 668.5991  # año marciano en soles medios


def epoch(s: str) -> float:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


# Sol de la pila: el que empieza a la medianoche local del 15/11/2026 en el centro del sitio.
SRC_START = mt.local_midnight_before(epoch("2026-11-15T12:00:00Z"), LON0)
SRC_LS = round(mt.ls_deg(SRC_START), 2)
SRC_TAG = dt.datetime.fromtimestamp(SRC_START, dt.timezone.utc).strftime("%Y%m%dT%H%MZ")


def at_ltst(midnight: float, hours: float) -> float:
    """Instante a esa hora solar local, `midnight` = medianoche local del sol."""
    return midnight + hours * mt.SOL_S / 24.0


def sol_after(n_sols: float) -> float:
    """Medianoche local del sol que está `n_sols` después del de la pila."""
    return mt.local_midnight_before(SRC_START + n_sols * mt.SOL_S + 3600.0, LON0)


ONE_YEAR_LATER = sol_after(round(MARS_YEAR_SOLS))  # misma estación, otro año marciano


@pytest.fixture
def site(data_dir, write_manifest):
    write_manifest(manifest())
    return data_dir


def write_source(site, bands=None, **kw):
    kw = {"tag": SRC_TAG, "start": SRC_START, "ls_deg": SRC_LS, "center_lon": LON0} | kw
    return write_shadow_stack(site, bands, **kw)


class TestMars24:
    # Valores de web/src/mars/mars24.ts (node, mismo algoritmo). El primero es el
    # ejemplo publicado de Mars24 (NASA GISS): MSD 44795,9998 y Ls 277,1876°.
    @pytest.mark.parametrize("utc,msd,ls,eot_h,ltst", [
        ("2000-01-06T00:00:00Z", 44795.999819, 277.18762, -0.34585, 4.813147),
        ("2026-11-15T12:36:18Z", 54344.037517, 22.28847, -0.434094, 5.629652),
        ("2026-11-15T00:00:00Z", 54343.526361, 22.04276, -0.437228, 17.358774),
        ("2028-10-03T21:10:00Z", 55013.976784, 22.94953, -0.426708, 4.179443),
    ])
    def test_igual_que_el_reloj_del_mapa(self, utc, msd, ls, eot_h, ltst):
        t = mt.mars_time(epoch(utc))
        assert t.msd == pytest.approx(msd, abs=2e-6)
        assert t.ls_deg == pytest.approx(ls, abs=2e-5)
        assert t.eot_h == pytest.approx(eot_h, abs=2e-6)
        assert mt.ltst_hours(epoch(utc), 77.45) == pytest.approx(ltst, abs=2e-6)

    @pytest.mark.parametrize("utc", ["2026-11-15T12:36:18Z", "2027-03-01T00:00:00Z", "2028-10-03T21:10:00Z"])
    def test_medianoche_local(self, utc):
        t = epoch(utc)
        m = mt.local_midnight_before(t, LON0)
        assert m <= t < m + mt.SOL_S
        h = mt.ltst_hours(m, LON0)
        assert min(h, 24.0 - h) < 1e-3  # 00:00 LTST, a menos de 4 s

    def test_declinacion(self):
        assert mt.declination_deg(0.0) == pytest.approx(0.0)
        assert mt.declination_deg(90.0) == pytest.approx(math.degrees(math.asin(0.42565)) + 0.25)
        assert mt.declination_deg(270.0) == pytest.approx(-mt.declination_deg(90.0))

    def test_diferencia_de_estacion_da_la_vuelta(self):
        assert mt.dls_deg(359.0, 1.0) == pytest.approx(2.0)
        assert mt.dls_deg(1.0, 359.0) == pytest.approx(-2.0)

    def test_un_anio_terrestre_no_es_la_misma_estacion(self):
        # La idea de "mismo día del año" no sirve en Marte: un año terrestre después, otra estación.
        a = mt.ls_deg(epoch("2026-11-15T12:00:00Z"))
        b = mt.ls_deg(epoch("2027-11-15T12:00:00Z"))
        assert abs(mt.dls_deg(a, b)) > 90


class TestElegirPila:
    def test_el_sol_exacto_no_se_marca_como_reutilizado(self, site):
        write_source(site)
        s = stack_for_time(site, "jezero", at_ltst(SRC_START, 13))
        assert s is not None and s.reuse is None
        assert s.provenance()["provenance"] == "DERIVED"

    def test_un_anio_marciano_despues_reutiliza_la_misma_estacion(self, site):
        write_source(site)
        t = at_ltst(ONE_YEAR_LATER, 13.0)
        s = stack_for_time(site, "jezero", t)
        assert s is not None and s.reuse is not None
        assert s.tag == SRC_TAG
        assert abs(s.reuse.dls) < 0.5
        assert s.covers(t)
        # Misma hora solar local: la banda de las 13:00 LTST (banda 14).
        assert s.band_at(t) == 14
        # El amanecer y el atardecer quedan a la misma hora local, en la fecha pedida.
        assert s.sunset == pytest.approx(ONE_YEAR_LATER + 18 * BAND_S, abs=120)
        prov = s.provenance()
        assert prov["provenance"] == "MODELED"
        assert "reutilizado" in prov["source"]
        assert any(SRC_TAG in a and "ΔLs" in a for a in prov["assumptions"])
        assert any("declinación" in a for a in prov["assumptions"])

    def test_dos_soles_despues_entra_en_el_tope(self, site):
        write_source(site)
        s = stack_for_time(site, "jezero", at_ltst(sol_after(2), 10))
        assert s is not None and s.reuse is not None
        assert 0 < abs(s.reuse.dls) <= SOL_REUSE_MAX_DLS_DEG

    def test_fuera_del_tope_no_se_reutiliza(self, site):
        write_source(site)
        assert stack_for_time(site, "jezero", at_ltst(sol_after(10), 10)) is None

    def test_otra_estacion_no_se_reutiliza(self, site):
        write_source(site)
        assert stack_for_time(site, "jezero", at_ltst(sol_after(round(MARS_YEAR_SOLS / 2)), 10)) is None

    def test_pila_vieja_sin_ls_solo_sirve_para_su_sol(self, site):
        write_source(site, ls_deg=None, center_lon=None)
        assert stack_for_time(site, "jezero", at_ltst(ONE_YEAR_LATER, 13)) is None

    def test_elige_la_de_estacion_mas_cercana(self, site):
        write_source(site)                                   # ΔLs ~0 un año después
        other = sol_after(3)
        tag = dt.datetime.fromtimestamp(other, dt.timezone.utc).strftime("%Y%m%dT%H%MZ")
        write_source(site, tag=tag, start=other, ls_deg=round(mt.ls_deg(other), 2))
        s = stack_for_time(site, "jezero", at_ltst(ONE_YEAR_LATER, 13))
        assert s is not None and s.tag == SRC_TAG

    def test_sin_pilas_no_hay_nada(self, site):
        assert stack_for_time(site, "jezero", at_ltst(ONE_YEAR_LATER, 13)) is None


ROW = 100
A, B = latlon(ROW, 40), latlon(ROW, 160)


def request(depart: float) -> dict:
    return {"site": "jezero", "depart_utc": iso(depart),
            "waypoints": [{"lat": la, "lon": lo, "task": None, "dwell_min": 0} for la, lo in (A, B)]}


def path_rows(leg: dict) -> list[int]:
    from .rasters import PX, R, Y0
    return [round((Y0 - R * math.radians(lat)) / PX - 0.5) for _, lat in leg["coordinates"]]


class TestPlanificador:
    @pytest.fixture
    def con_sombra(self, site):
        write_terrain(site, np.full((N, N), 2.0, dtype=np.float32), dtm=np.zeros((N, N), dtype=np.float32))
        shadow = np.ones((N, N), dtype=np.uint8)
        shadow[90:111, 80:121] = 0    # sombra sobre la línea recta, solo a las 13:00 LTST (banda 14)
        write_source(site, {14: shadow})
        return site

    def test_evalua_la_luz_con_la_pila_reutilizada(self, client, con_sombra):
        body = client.post("/api/route", json=request(at_ltst(ONE_YEAR_LATER, 13.0))).json()
        v = body["verdict"]
        assert "se estimó con las sombras del sol " + SRC_TAG in v["summary"]
        assert "no se evaluó la luz" not in v["summary"]
        daylight = next(r for r in v["limits"] if r["id"] == "daylight")
        assert daylight["status"] == "ok"
        assert daylight["limit"]["provenance"] == "MODELED"
        assert any(SRC_TAG in a for a in daylight["limit"]["assumptions"])
        leg = body["legs"][0]
        assert leg["shadow_fraction"]["provenance"] == "MODELED"
        # El A* usa la máscara de esa hora solar local: rodea la sombra.
        assert min(path_rows(leg)) < 90 or max(path_rows(leg)) > 110

    def test_salir_de_noche_en_la_pila_reutilizada_es_no_go(self, client, con_sombra):
        body = client.post("/api/route", json=request(at_ltst(ONE_YEAR_LATER, 4.0))).json()
        assert body["verdict"]["status"] == "NO_GO"
        assert body["verdict"]["limiting_factor"] == "daylight"

    def test_sin_pila_de_la_estacion_lo_dice(self, client, con_sombra):
        body = client.post("/api/route", json=request(at_ltst(sol_after(10), 13.0))).json()
        summary = body["verdict"]["summary"]
        assert "no se evaluó la luz" in summary
        assert "misma estación (±2° Ls)" in summary
        assert next(r for r in body["verdict"]["limits"] if r["id"] == "daylight")["status"] == "not_evaluated"
