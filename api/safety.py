"""Seguridad de una ruta: límites duros, puntaje por eslabón más débil y robustez.

Módulo puro (sin I/O ni rasters): recibe la ruta ya resuelta (pasos con desnivel,
pendiente y visibilidad del hábitat) y la evalúa. Lo usa api/planner.py y se testea
sin datos. Documentado en docs/seguridad.md.

Regla: no hay probabilidades. Todo sale de márgenes calculables y explicables.

    margen_i = 1 − usado_i / límite_i        (en el peor punto de la ruta)
    puntaje  = 100 · min_i margen_i           (entre 0 y 100)

El límite que da el mínimo es el factor limitante. Si algún margen es negativo, se
rompió un límite duro y la ruta es NO-GO, sin compensación posible.

Veredicto:
    NO_GO    algún límite duro roto en el caso base
    CAUTION  puntaje < CAUTION_SCORE, falla en algún escenario de estrés, o un límite
             definido que no se pudo evaluar del todo por falta de datos
    GO       todo lo demás

Los valores de los límites son del equipo y todavía no tienen fuente citable: viajan
con procedencia ASSUMED hasta que la tengan.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

from .consumables import SuitParams, Step, battery_wh, dwell_consumption, o2_kg, pandolf_watts

CAUTION_SCORE = 20.0
KCAL_PER_J = 1.0 / 4184.0

ASSUMED_SOURCE = "Valor fijado por el equipo, sin fuente citable todavía (docs/seguridad.md)"


@dataclass(frozen=True)
class Limits:
    """Límites duros. Cambiar un default acá obliga a actualizar docs/seguridad.md."""
    max_slope_deg: float = 25.0          # supuesto; ojo: Pandolf se validó hasta ±25 % de grado (~14°)
    reserve_fraction: float = 0.20       # O2 y batería que tienen que sobrar al volver
    sunset_margin_min: float = 30.0      # volver al menos esto antes del atardecer
    max_no_contact_min: float = 10.0     # minutos seguidos sin línea de vista al hábitat (briefing)
    dose_budget_msv: float = 0.5         # presupuesto de dosis por EVA
    calories_kcal: float | None = None   # sin definir: el equipo todavía no fijó el tope


# id → (etiqueta para la UI, unidad). Los ids coinciden con LimitingFactor de web/.
LIMIT_LABELS: dict[str, tuple[str, str]] = {
    "terrain": ("Pendiente máxima", "°"),
    "o2": ("Reserva de O2 al volver", "kg"),
    "battery": ("Reserva de batería al volver", "Wh"),
    "daylight": ("Regreso antes del atardecer", "min"),
    "contact": ("Minutos seguidos sin contacto", "min"),
    "dose": ("Dosis de radiación por EVA", "mSv"),
    "calories": ("Calorías por EVA", "kcal"),
}

LIMITING_PHRASE: dict[str, str] = {
    "terrain": "la pendiente",
    "o2": "la reserva de O2",
    "battery": "la reserva de batería",
    "daylight": "el regreso antes del atardecer",
    "contact": "el tiempo sin contacto con el hábitat",
    "dose": "la dosis de radiación",
    "calories": "las calorías",
}


# ------------------------------------------------------------------ entrada


@dataclass
class TrackLeg:
    """Un tramo resuelto. `slopes[j]` y `visible[j]` corresponden al final de `steps[j]`.

    slopes: pendiente media de la celda (°), None = sin dato.
    visible: línea de vista al hábitat, None = sin dato.
    """
    steps: list[Step]
    slopes: list[float | None]
    visible: list[bool | None]

    def __post_init__(self):
        if not (len(self.steps) == len(self.slopes) == len(self.visible)):
            raise ValueError("steps, slopes y visible tienen que tener el mismo largo")


@dataclass
class Track:
    """La ruta completa. `dwell_s[i]` es la espera en la estación al final de `legs[i]`
    (la última, la llegada, no espera). `station_visible[i]` es la visibilidad en esa
    estación, para contar la espera en el tiempo sin contacto."""
    legs: list[TrackLeg]
    dwell_s: list[float]
    station_visible: list[bool | None]
    contact_evaluated: bool = True   # False si no hay DTM para calcular la línea de vista
    blocked_legs: list[int] = field(default_factory=list)  # tramos sin paso bajo la pendiente máxima


@dataclass(frozen=True)
class Conditions:
    """Lo que cambia entre el caso base y los escenarios de estrés."""
    depart_s: float                    # epoch UTC
    speed_m_s: float
    params: SuitParams
    sunrise_s: float | None = None     # None = no se conoce (falta la pila de sombras)
    sunset_s: float | None = None
    dose_rate_msv_h: float | None = None


# ------------------------------------------------------------------ salida


@dataclass
class LimitResult:
    id: str
    used: float | None
    limit: float | None
    margin: float | None            # 1 − usado/límite; < 0 = roto; None = no evaluado
    complete: bool = True           # False: se evaluó con datos parciales
    note: str | None = None
    defined: bool = True            # False: el equipo todavía no fijó el valor del límite
    short: str | None = None        # versión corta de `note` para el resumen del veredicto

    @property
    def evaluated(self) -> bool:
        return self.margin is not None

    @property
    def broken(self) -> bool:
        return self.margin is not None and self.margin < 0

    @property
    def status(self) -> str:
        if not self.evaluated:
            return "not_evaluated"
        return "broken" if self.broken else "ok"


@dataclass
class Evaluation:
    limits: list[LimitResult]
    elapsed_s: float
    end_s: float
    o2_used_kg: float
    battery_used_wh: float
    energy_kcal: float
    max_no_contact_min: float | None

    @property
    def evaluated(self) -> list[LimitResult]:
        return [r for r in self.limits if r.evaluated]

    @property
    def limiting(self) -> LimitResult | None:
        ev = self.evaluated
        return min(ev, key=lambda r: r.margin) if ev else None

    @property
    def score(self) -> float | None:
        lim = self.limiting
        return None if lim is None else max(0.0, min(100.0, 100.0 * lim.margin))

    @property
    def broken(self) -> list[LimitResult]:
        return [r for r in self.limits if r.broken]

    @property
    def missing(self) -> list[LimitResult]:
        """Límites definidos por el equipo que no se pudieron evaluar del todo."""
        return [r for r in self.limits if r.defined and (not r.evaluated or not r.complete)]


@dataclass
class ScenarioResult:
    id: str
    label: str
    evaluation: Evaluation | None = None
    note: str | None = None

    @property
    def status(self) -> str:
        if self.evaluation is None:
            return "not_evaluated"
        return "fail" if self.evaluation.broken else "pass"


@dataclass
class Assessment:
    status: str                       # GO | CAUTION | NO_GO
    base: Evaluation
    scenarios: list[ScenarioResult] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    @property
    def robustness(self) -> tuple[int, int]:
        ev = [s for s in self.scenarios if s.evaluation is not None]
        return sum(s.status == "pass" for s in ev), len(ev)


# ------------------------------------------------------------------ evaluación


@dataclass(frozen=True)
class Streak:
    """Tramo de la travesía sin contacto: segundos desde la salida y metros recorridos."""
    t0_s: float
    d0_m: float
    t1_s: float
    d1_m: float


def _km(m: float) -> str:
    return f"{m / 1000:.1f}".replace(".", ",")


def contact_short(streak: Streak | None, cap_min: float) -> str | None:
    """Para el resumen del NO-GO: cuánto y cuándo, en una línea."""
    if streak is None or streak.t1_s <= streak.t0_s:
        return None
    mins = (streak.t1_s - streak.t0_s) / 60.0
    return (f"{mins:.0f} min seguidos sin vista al hábitat (máximo {cap_min:.0f}), "
            f"del minuto {streak.t0_s / 60:.0f} al {streak.t1_s / 60:.0f}. "
            "Mirá la capa «Contacto con el hábitat».")


def contact_note(streak: Streak | None, cap_min: float, broken: bool) -> str | None:
    """Dónde está la racha más larga sin contacto y, si rompe el límite, qué hacer.

    Va en el `note` del límite (el detalle del panel)."""
    if streak is None or streak.t1_s <= streak.t0_s:
        return None
    mins = (streak.t1_s - streak.t0_s) / 60.0
    where = f"del minuto {streak.t0_s / 60:.0f} al {streak.t1_s / 60:.0f}"
    if streak.d1_m > streak.d0_m:
        where += f", entre el km {_km(streak.d0_m)} y el {_km(streak.d1_m)} del recorrido"
    if not broken:
        return f"La racha más larga sin vista al hábitat es de {mins:.0f} min, {where}."
    return (f"Son {mins:.0f} min seguidos sin línea de vista al hábitat (el máximo es {cap_min:.0f}), "
            f"{where}: el terreno tapa la antena. Mirá la capa «Contacto con el hábitat» y elegí un "
            "destino o un hábitat con vista entre sí, o paradas que vuelvan a tener vista antes de "
            f"los {cap_min:.0f} min.")


def _margin(used: float, limit: float) -> float:
    if limit <= 0:
        return -1.0
    return 1.0 - used / limit


def evaluate(track: Track, cond: Conditions, limits: Limits = Limits()) -> Evaluation:
    """Recorre la ruta paso a paso y devuelve el margen de cada límite duro."""
    p, speed = cond.params, cond.speed_m_s
    t = 0.0
    energy = o2 = bat = 0.0
    max_slope: float | None = None
    slope_gaps = 0
    # Dos rachas sin contacto: la confirmada (solo pasos sin vista medida) y la pesimista
    # (también los pasos sin dato). Solo la confirmada puede romper el límite: un hueco de
    # datos no se presenta como un límite roto (lo fuerza a CAUTION, ver más abajo).
    run = max_run = 0.0          # confirmada
    run_p = max_run_p = 0.0      # pesimista
    unknown_vis_s = 0.0
    dist = 0.0                   # metros recorridos, para decir dónde está la racha
    # Dónde empieza y termina cada racha: (s desde la salida, m recorridos) al inicio y al final.
    run_at = run_p_at = (0.0, 0.0)
    worst = worst_p = None

    def contact(dt: float, vis: bool | None, t_end: float, d_end: float) -> None:
        nonlocal run, max_run, run_p, max_run_p, unknown_vis_s, run_at, run_p_at, worst, worst_p
        start = (t_end - dt, dist)
        if vis is True:
            run = run_p = 0.0
            return
        if vis is None:
            unknown_vis_s += dt
            run = 0.0            # no se sabe: corta la racha confirmada
        else:
            if run == 0.0:
                run_at = start
            run += dt
            if run > max_run:
                max_run, worst = run, Streak(*run_at, t_end, d_end)
        if run_p == 0.0:
            run_p_at = start
        run_p += dt
        if run_p > max_run_p:
            max_run_p, worst_p = run_p, Streak(*run_p_at, t_end, d_end)

    for i, leg in enumerate(track.legs):
        for s, sl, vis in zip(leg.steps, leg.slopes, leg.visible):
            if s.dx_m <= 0:
                continue
            grade = 100.0 * s.dz_m / s.dx_m
            dt = math.hypot(s.dx_m, s.dz_m) / speed
            e = pandolf_watts(speed, grade, p) * dt
            energy += e
            o2 += o2_kg(e, dt, p)
            bat += battery_wh(dt, p)
            t += dt
            if sl is None:
                slope_gaps += 1
            else:
                max_slope = sl if max_slope is None else max(max_slope, sl)
            contact(dt, vis, t, dist + s.dx_m)
            dist += s.dx_m
        if i < len(track.dwell_s):
            dwell = max(0.0, track.dwell_s[i])
            if dwell:
                stay = dwell_consumption(dwell, p)   # la misma cuenta que las estaciones del planificador
                energy += stay["energy_kj"] * 1000.0
                o2 += stay["o2_kg"]
                bat += stay["battery_wh"]
                t += dwell
                vis = track.station_visible[i] if i < len(track.station_visible) else None
                contact(dwell, vis, t, dist)

    end = cond.depart_s + t
    kcal = energy * KCAL_PER_J
    n_steps = sum(len(leg.steps) for leg in track.legs)
    results: list[LimitResult] = []

    # Pendiente: la peor celda que pisa la ruta. Un tramo sin paso la rompe sin más.
    if track.blocked_legs:
        tramos = ", ".join(f"{i}→{i + 1}" for i in track.blocked_legs)
        results.append(LimitResult("terrain", max_slope, limits.max_slope_deg, -1.0,
                                   note=f"No hay paso con pendiente menor a {limits.max_slope_deg:.0f}° "
                                        f"en el tramo {tramos}."))
    elif max_slope is None:
        results.append(LimitResult("terrain", None, limits.max_slope_deg, None,
                                   note="Sin pendiente del DTM en la ruta: no se evaluó."))
    else:
        r = LimitResult("terrain", max_slope, limits.max_slope_deg, _margin(max_slope, limits.max_slope_deg))
        if slope_gaps:
            r.complete = False
            r.note = f"{slope_gaps} de {n_steps} pasos sin pendiente del DTM."
        results.append(r)

    # O2 y batería: lo usable es la capacidad menos la reserva que tiene que sobrar.
    o2_budget = p.o2_capacity_kg * (1 - limits.reserve_fraction)
    bat_budget = p.battery_capacity_wh * (1 - limits.reserve_fraction)
    reserve_pct = 100 * limits.reserve_fraction
    for rid, used, cap, budget, name in (("o2", o2, p.o2_capacity_kg, o2_budget, "El O2"),
                                         ("battery", bat, p.battery_capacity_wh, bat_budget, "La batería")):
        r = LimitResult(rid, used, budget, _margin(used, budget))
        if used > cap:
            r.note = f"{name} se agota antes de terminar la travesía."
        elif r.broken:
            r.note = f"{name} no deja la reserva mínima del {reserve_pct:.0f} % al llegar."
        results.append(r)

    # Luz: el tiempo disponible es desde la salida hasta el atardecer menos el margen.
    if cond.sunset_s is None:
        results.append(LimitResult("daylight", t / 60.0, None, None,
                                   note="Falta la pila de sombras de ese sol: no se sabe la hora del atardecer."))
    else:
        avail_min = (cond.sunset_s - limits.sunset_margin_min * 60.0 - cond.depart_s) / 60.0
        r = LimitResult("daylight", t / 60.0, avail_min, _margin(t / 60.0, avail_min))
        if cond.sunrise_s is not None and cond.depart_s < cond.sunrise_s:
            r.margin = min(r.margin, -1.0)
            r.note = "Sale antes del amanecer."
        elif avail_min <= 0:
            r.note = "Sale cuando ya no queda luz para volver con margen."
        results.append(r)

    # Contacto: la racha más larga sin línea de vista al hábitat.
    if not track.contact_evaluated:
        results.append(LimitResult("contact", None, limits.max_no_contact_min, None,
                                   note="Sin DTM no se puede calcular la línea de vista al hábitat."))
        max_run_min = None
    else:
        cap = limits.max_no_contact_min
        confirmed_min, pessimistic_min = max_run / 60.0, max_run_p / 60.0
        unknown_min = unknown_vis_s / 60.0
        if unknown_vis_s <= 0 or pessimistic_min <= cap:
            # Sin huecos, o con huecos que ni contados como sin contacto rompen el límite.
            max_run_min = pessimistic_min
            r = LimitResult("contact", max_run_min, cap, _margin(max_run_min, cap))
            r.note = contact_note(worst_p, cap, r.broken)
            r.short = contact_short(worst_p, cap) if r.broken else None
            if unknown_vis_s > 0:
                r.note = (f"{unknown_min:.0f} min sin dato de visibilidad: se contaron como sin contacto "
                          "y aun así no pasa el límite.")
        else:
            # Los huecos podrían romperlo: se evalúa con lo medido y queda incompleto (CAUTION).
            max_run_min = confirmed_min
            r = LimitResult("contact", max_run_min, cap, _margin(max_run_min, cap))
            if r.broken:
                r.note = contact_note(worst, cap, True)
                r.short = contact_short(worst, cap)
            else:
                r.complete = False
                r.note = (f"{unknown_min:.0f} min sin dato de visibilidad: contándolos como sin contacto, "
                          f"la racha llegaría a {pessimistic_min:.0f} min. No se sabe si se rompe el límite.")
        results.append(r)

    # Dosis: tasa de base por tiempo afuera.
    if cond.dose_rate_msv_h is None:
        results.append(LimitResult("dose", None, limits.dose_budget_msv, None,
                                   note="Falta la tasa de dosis de referencia."))
    else:
        dose = cond.dose_rate_msv_h * t / 3600.0
        results.append(LimitResult("dose", dose, limits.dose_budget_msv, _margin(dose, limits.dose_budget_msv)))

    # Calorías: se calculan siempre; el tope lo fija el equipo.
    if limits.calories_kcal is None:
        results.append(LimitResult("calories", kcal, None, None, defined=False,
                                   note="Tope sin definir por el equipo: se muestra el gasto, no cuenta en el puntaje."))
    else:
        results.append(LimitResult("calories", kcal, limits.calories_kcal, _margin(kcal, limits.calories_kcal)))

    return Evaluation(results, t, end, o2, bat, kcal, max_run_min)


# ------------------------------------------------------------------ escenarios


@dataclass(frozen=True)
class Scenario:
    id: str
    label: str
    apply: object = None              # Conditions → Conditions; None = no evaluable
    not_evaluable: str | None = None  # por qué no se puede calcular todavía


def _late(c: Conditions) -> Conditions:
    return replace(c, depart_s=c.depart_s + 30 * 60)


def _slow(c: Conditions) -> Conditions:
    return replace(c, speed_m_s=c.speed_m_s * 0.8)


def _heavy(c: Conditions) -> Conditions:
    p = c.params
    return replace(c, params=replace(p, cargo_kg=p.cargo_kg + 0.10 * p.carried_kg))


SCENARIOS: tuple[Scenario, ...] = (
    Scenario("late_30", "Salir 30 min tarde", _late),
    Scenario("slow_20", "Caminar un 20 % más lento", _slow),
    Scenario("cargo_10", "Llevar un 10 % más de carga", _heavy),
    Scenario("dust_storm", "Tormenta de polvo (más frío)",
             not_evaluable="No hay modelo térmico del traje: el frío no cambia ningún límite que "
                           "podamos calcular. No se inventa el efecto."),
    Scenario("no_shelter", "Sin el refugio más cercano",
             not_evaluable="Ningún límite duro depende hoy del refugio y los refugios todavía no "
                           "entran al planificador."),
)


def assess(track: Track, cond: Conditions, limits: Limits = Limits(),
           scenarios: tuple[Scenario, ...] = SCENARIOS) -> Assessment:
    """Caso base + escenarios de estrés sobre la misma ruta → veredicto."""
    base = evaluate(track, cond, limits)
    results = []
    for sc in scenarios:
        if sc.apply is None:
            results.append(ScenarioResult(sc.id, sc.label, None, sc.not_evaluable))
        else:
            results.append(ScenarioResult(sc.id, sc.label, evaluate(track, sc.apply(cond), limits)))

    reasons: list[str] = []
    if base.broken:
        status = "NO_GO"
    else:
        status = "GO"
        score = base.score
        if score is not None and score < CAUTION_SCORE:
            status = "CAUTION"
            reasons.append(f"puntaje {score:.0f} < {CAUTION_SCORE:.0f}")
        failed = [s for s in results if s.status == "fail"]
        if failed:
            status = "CAUTION"
            reasons.append("falla en: " + ", ".join(s.label.lower() for s in failed))
        if base.missing:
            status = "CAUTION"
            reasons.append("sin evaluar del todo: " + ", ".join(LIMIT_LABELS[r.id][0].lower() for r in base.missing))
    return Assessment(status, base, results, reasons)


def summary(a: Assessment) -> str:
    """Una frase para leer con el casco puesto."""
    lim = a.base.limiting
    if a.status == "NO_GO":
        r = min(a.base.broken, key=lambda x: x.margin)
        if r.short:
            return f"No va: {r.short}"
        extra = f" {r.note}" if r.note else ""
        return f"No va: se rompe el límite de {LIMIT_LABELS[r.id][0].lower()}.{extra}"
    passed, total = a.robustness
    skipped = sum(sc.evaluation is None for sc in a.scenarios)
    phrase = LIMITING_PHRASE[lim.id] if lim else "nada evaluable"
    head = "Va con cuidado" if a.status == "CAUTION" else "Va"
    tail = f" ({skipped} sin modelo para evaluarlos)" if skipped else ""
    return f"{head}: limita {phrase}. Robusta en {passed} de {total} escenarios{tail}."
