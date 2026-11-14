"""api/safety.py: límites duros, puntaje por eslabón más débil, robustez y veredicto.

Sin rasters: la ruta se arma a mano con pasos de 10 m en llano.
"""
import pytest

from api.consumables import Step, SuitParams
from api.safety import (CAUTION_SCORE, Conditions, Limits, Track, TrackLeg, assess, evaluate,
                        summary)

T0 = 1_794_700_800.0          # 2026-11-15T00:00:00Z
SPEED = 0.8


def leg(metres: float, slope: float | None = 2.0, visible: bool | None = True, step: float = 10.0) -> TrackLeg:
    n = max(1, round(metres / step))
    return TrackLeg([Step(metres / n, 0.0)] * n, [slope] * n, [visible] * n)


def track(*legs: TrackLeg, dwell_min=(), station_visible=None, **kw) -> Track:
    dw = [d * 60.0 for d in dwell_min] or [0.0] * (len(legs) - 1)
    sv = station_visible if station_visible is not None else [True] * len(legs)
    return Track(list(legs), dw, sv, **kw)


def cond(depart=T0 + 6 * 3600, sunset=T0 + 18 * 3600, **kw) -> Conditions:
    base = dict(depart_s=depart, speed_m_s=SPEED, params=SuitParams(), sunrise_s=T0 + 6 * 3600,
                sunset_s=sunset, dose_rate_msv_h=0.64 / 24)
    return Conditions(**(base | kw))


def by_id(ev):
    return {r.id: r for r in ev.limits}


class TestMargenes:
    def test_margen_es_uno_menos_usado_sobre_limite(self):
        ev = evaluate(track(leg(1000, slope=10.0)), cond())
        r = by_id(ev)["terrain"]
        assert r.used == 10.0 and r.limit == 25.0
        assert r.margin == pytest.approx(1 - 10 / 25)

    def test_puntaje_es_el_margen_mas_chico_y_ese_es_el_limitante(self):
        ev = evaluate(track(leg(1000, slope=22.0)), cond())
        assert ev.limiting.id == "terrain"
        assert ev.score == pytest.approx(100 * (1 - 22 / 25))

    def test_o2_usa_la_capacidad_menos_la_reserva(self):
        ev = evaluate(track(leg(500)), cond())
        r = by_id(ev)["o2"]
        assert r.limit == pytest.approx(SuitParams().o2_capacity_kg * 0.8)
        assert 0 < r.used < r.limit

    def test_dosis_es_tasa_por_tiempo_afuera(self):
        ev = evaluate(track(leg(1440)), cond())       # 1440 m a 0.8 m/s = 30 min
        assert by_id(ev)["dose"].used == pytest.approx(0.64 / 24 * 0.5)

    def test_calorias_se_calculan_pero_sin_tope_no_cuentan(self):
        ev = evaluate(track(leg(500)), cond())
        r = by_id(ev)["calories"]
        assert r.used > 0
        assert not r.evaluated and r.limit is None
        assert ev.missing == []    # tope sin definir no es "faltan datos"

    def test_calorias_con_tope_entran_al_puntaje(self):
        ev = evaluate(track(leg(500)), cond(), Limits(calories_kcal=1.0))
        assert by_id(ev)["calories"].broken


class TestContacto:
    def test_cuenta_la_racha_mas_larga_sin_vista(self):
        # 5 min tapado, vuelve la vista, 3 min tapado: la racha es 5, no 8.
        t = track(leg(240, visible=False), leg(48), leg(144, visible=False), station_visible=[True, True, True])
        ev = evaluate(t, cond())
        assert ev.max_no_contact_min == pytest.approx(5.0, abs=0.01)

    def test_la_espera_tapada_suma_a_la_racha(self):
        t = track(leg(240, visible=False), leg(48, visible=False), dwell_min=[10], station_visible=[False, False])
        ev = evaluate(t, cond())
        assert by_id(ev)["contact"].broken
        assert ev.max_no_contact_min == pytest.approx(16.0, abs=0.01)

    def test_sin_dato_de_vista_se_cuenta_como_tapado_y_se_avisa(self):
        ev = evaluate(track(leg(240, visible=None)), cond())
        r = by_id(ev)["contact"]
        assert r.used == pytest.approx(5.0, abs=0.01)
        assert not r.complete and "sin dato" in r.note

    def test_sin_dtm_no_se_evalua(self):
        ev = evaluate(track(leg(240), contact_evaluated=False), cond())
        assert not by_id(ev)["contact"].evaluated


class TestVeredicto:
    def test_ruta_corta_de_dia_es_go(self):
        a = assess(track(leg(500)), cond())
        assert a.status == "GO"
        assert a.robustness == (3, 3)
        assert "Robusta en 3 de 3" in summary(a)

    def test_limite_roto_es_no_go_sin_compensacion(self):
        a = assess(track(leg(500, slope=26.0)), cond())
        assert a.status == "NO_GO"
        assert [r.id for r in a.base.broken] == ["terrain"]
        assert a.base.score == 0

    def test_tramo_bloqueado_rompe_la_pendiente(self):
        a = assess(track(leg(500, slope=None), blocked_legs=[0]), cond())
        assert a.status == "NO_GO"
        assert "tramo 0→1" in by_id(a.base)["terrain"].note

    def test_puntaje_bajo_es_caution(self):
        a = assess(track(leg(500, slope=21.0)), cond())    # margen 0.16
        assert a.base.score < CAUTION_SCORE
        assert a.status == "CAUTION"

    def test_falla_en_un_escenario_es_caution(self):
        # Vuelve con margen, pero saliendo 30 min tarde ya no llega antes del atardecer - 30 min.
        sunset = T0 + 10 * 3600
        depart = sunset - 30 * 60 - 40 * 60    # 40 min de luz útil
        a = assess(track(leg(1440)), cond(depart=depart, sunset=sunset))   # 30 min de caminata
        assert not a.base.broken
        assert {s.id: s.status for s in a.scenarios}["late_30"] == "fail"
        assert a.status == "CAUTION"
        assert a.robustness == (2, 3)

    def test_faltan_datos_de_un_limite_definido_es_caution(self):
        a = assess(track(leg(500)), cond(sunset=None, sunrise_s=None))
        assert a.status == "CAUTION"
        assert any("atardecer" in r for r in a.reasons)

    def test_escenarios_sin_modelo_no_cuentan_en_m(self):
        a = assess(track(leg(500)), cond())
        skipped = [s for s in a.scenarios if s.status == "not_evaluated"]
        assert {s.id for s in skipped} == {"dust_storm", "no_shelter"}
        assert all(s.note for s in skipped)
        assert "2 sin modelo" in summary(a)

    def test_cambiar_la_hora_de_salida_cambia_el_veredicto(self):
        """MAP-25: la misma ruta, a tres horas distintas, da los tres veredictos."""
        sunset = T0 + 18 * 3600
        t = track(leg(1440))                      # 30 min de caminata
        temprano = assess(t, cond(depart=sunset - 4 * 3600, sunset=sunset))
        justo = assess(t, cond(depart=sunset - 30 * 60 - 45 * 60, sunset=sunset))
        tarde = assess(t, cond(depart=sunset - 30 * 60 - 20 * 60, sunset=sunset))
        assert (temprano.status, justo.status, tarde.status) == ("GO", "CAUTION", "NO_GO")
        assert tarde.base.limiting.id == "daylight"

    def test_salir_antes_del_amanecer_es_no_go(self):
        a = assess(track(leg(500)), cond(depart=T0 + 5 * 3600))
        assert a.status == "NO_GO"
        assert by_id(a.base)["daylight"].note == "Sale antes del amanecer."


class TestEscenarios:
    def test_mas_lento_tarda_mas(self):
        t = track(leg(1000))
        base, lento = evaluate(t, cond()), evaluate(t, cond(speed_m_s=SPEED * 0.8))
        assert lento.elapsed_s == pytest.approx(base.elapsed_s / 0.8)

    def test_mas_carga_gasta_mas_o2(self):
        a = assess(track(leg(1000)), cond())
        heavy = next(s for s in a.scenarios if s.id == "cargo_10").evaluation
        assert heavy.o2_used_kg > a.base.o2_used_kg
