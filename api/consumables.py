"""Consumibles del traje por tramo: Pandolf ajustado a 0.38 g, O2 y batería del EMU.

Módulo puro (sin I/O ni dependencias) para poder reutilizarlo desde /api/route,
desde el pipeline o desde tests. Todo lo que sale de acá es MODELED.

Modelo metabólico (Pandolf et al. 1977, con la corrección de bajada de Santee et al. 2001):

    M = 1.5·W + g·[ 2.0·(W+L)·(L/W)² + η·(W+L)·(1.5·V² + 0.35·V·G) − CF ]

    W  masa del astronauta (kg)
    L  masa transportada = traje + carga (kg)
    V  velocidad (m/s)
    G  pendiente (%), positiva en subida
    η  factor de terreno (1.0 asfalto … 2.1 arena suelta)
    g  gravedad relativa a la Tierra (0.38 en Marte)
    CF corrección de Santee, solo para G < 0:
       η·[ G·(W+L)·V / 3.5 − (W+L)·(G+6)² / W + (25 − V²) ]

El término de pie (1.5·W) no se escala con g: es mayormente metabolismo basal. Los
términos de carga y de locomoción son trabajo contra el peso y se escalan por g.
Este ajuste es una hipótesis del equipo, no una ecuación validada en Marte.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

BADGE = "MODELED"
SOURCE = "Pandolf (1977) + Santee (2001) ajustado a gravedad marciana · EMU ISS"

O2_DENSITY_KG_PER_L = 1.429e-3  # O2 a 0 °C y 1 atm


@dataclass(frozen=True)
class SuitParams:
    """Supuestos del modelo. Los defaults son los del EMU de la ISS.
    Origen y estado de cada valor: docs/consumibles del traje.md (actualizarlo si cambia uno)."""
    astronaut_kg: float = 80.0          # astronauta sin traje
    suit_kg: float = 127.0              # EMU completo con PLSS (~280 lb)
    cargo_kg: float = 0.0               # carga extra (herramientas, muestras); la usa M2
    gravity_g: float = 0.38             # 3.71 / 9.81 m/s²
    terrain_factor: float = 1.1         # η de Pandolf: regolito compacto ≈ camino de tierra
    o2_kj_per_l: float = 20.1           # equivalente energético del O2 (RQ ≈ 0.85)
    o2_capacity_kg: float = 0.55        # O2 primario del PLSS (1.2 lb); no cuenta el SOP
    o2_leak_kg_per_h: float = 0.0       # fuga del traje; 0 por defecto
    battery_capacity_wh: float = 446.9  # 16.8 V × 26.6 Ah
    battery_efficiency: float = 0.9     # fracción de la energía nominal que llega a la carga
    base_power_w: float = 55.0          # ventilador, bomba, radio y electrónica del PLSS

    @property
    def carried_kg(self) -> float:
        return self.suit_kg + self.cargo_kg

    def as_dict(self) -> dict:
        return asdict(self)


def pandolf_watts(speed_m_s: float, grade_pct: float, p: SuitParams) -> float:
    """Gasto metabólico (W) caminando a `speed_m_s` sobre una pendiente `grade_pct`."""
    w, l, v, g, eta = p.astronaut_kg, p.carried_kg, speed_m_s, grade_pct, p.terrain_factor
    total = w + l
    standing = 1.5 * w
    load = 2.0 * total * (l / w) ** 2
    locomotion = eta * total * (1.5 * v ** 2 + 0.35 * v * g)
    correction = 0.0
    if g < 0:
        correction = eta * (g * total * v / 3.5 - total * (g + 6) ** 2 / w + (25 - v ** 2))
    m = standing + p.gravity_g * (load + locomotion - correction)
    # Pandolf puede dar valores por debajo del reposo en bajadas fuertes: piso en el gasto de pie.
    return max(m, standing)


def o2_kg(energy_j: float, duration_s: float, p: SuitParams) -> float:
    """O2 consumido por el metabolismo más la fuga del traje."""
    litres = energy_j / (p.o2_kj_per_l * 1000.0)
    return litres * O2_DENSITY_KG_PER_L + p.o2_leak_kg_per_h * duration_s / 3600.0


def battery_wh(duration_s: float, p: SuitParams) -> float:
    """Energía de batería consumida (Wh). El PLSS tiene un consumo casi constante; el
    enfriamiento por sublimación gasta agua, no batería, así que no depende de M."""
    return p.base_power_w * duration_s / 3600.0 / p.battery_efficiency


def dwell_consumption(duration_s: float, p: SuitParams) -> dict:
    """Consumo de una permanencia en una estación: el astronauta trabaja parado (gasto de
    reposo de Pandolf, sin velocidad ni pendiente) y el PLSS sigue andando."""
    energy = pandolf_watts(0.0, 0.0, p) * duration_s
    return {"duration_s": duration_s, "energy_kj": energy / 1000.0,
            "o2_kg": o2_kg(energy, duration_s, p), "battery_wh": battery_wh(duration_s, p)}


@dataclass
class Step:
    """Sub-paso de un tramo: distancia horizontal (m) y desnivel (m)."""
    dx_m: float
    dz_m: float


def segment_consumption(steps: list[Step], speed_m_s: float, p: SuitParams) -> dict:
    """Integra un tramo paso a paso. Devuelve tiempo, energía, O2 y batería del tramo."""
    duration = energy = gain = loss = horiz = 0.0
    max_abs_grade = 0.0
    for s in steps:
        if s.dx_m <= 0:
            continue
        grade = 100.0 * s.dz_m / s.dx_m
        dist = (s.dx_m ** 2 + s.dz_m ** 2) ** 0.5
        t = dist / speed_m_s
        duration += t
        energy += pandolf_watts(speed_m_s, grade, p) * t
        horiz += s.dx_m
        gain += max(s.dz_m, 0.0)
        loss += max(-s.dz_m, 0.0)
        max_abs_grade = max(max_abs_grade, abs(grade))
    return {
        "distance_m": horiz,
        "elev_gain_m": gain,
        "elev_loss_m": loss,
        "max_abs_grade_pct": max_abs_grade,
        "duration_s": duration,
        "metabolic_w": energy / duration if duration else 0.0,
        "energy_kj": energy / 1000.0,
        "o2_kg": o2_kg(energy, duration, p),
        "battery_wh": battery_wh(duration, p),
    }


PANDOLF_GRADE_LIMIT_PCT = 25.0  # rango aproximado en el que se validaron Pandolf y Santee


def route_consumption(segments: list[list[Step]], speed_m_s: float, p: SuitParams,
                      dwell_s: list[float] | None = None) -> dict:
    """Consumo por tramo con O2 y batería acumulados desde la salida.

    `dwell_s[i]` es la permanencia (s) en el punto de llegada del tramo i, antes de seguir.
    Se suma a ese tramo: sus acumulados ya la incluyen, y si un recurso se agota durante la
    permanencia, el aviso lo marca en ese tramo.
    """
    o2_cap, bat_cap = p.o2_capacity_kg, p.battery_capacity_wh
    out, o2_cum, bat_cum, t_cum = [], 0.0, 0.0, 0.0
    warnings = []
    for i, steps in enumerate(segments):
        seg = segment_consumption(steps, speed_m_s, p)
        stay = dwell_consumption(dwell_s[i] if dwell_s else 0.0, p)
        o2_cum += seg["o2_kg"] + stay["o2_kg"]
        bat_cum += seg["battery_wh"] + stay["battery_wh"]
        t_cum += seg["duration_s"] + stay["duration_s"]
        seg.update({
            "index": i,
            "dwell_s": stay["duration_s"],
            "dwell_energy_kj": stay["energy_kj"],
            "dwell_o2_kg": stay["o2_kg"],
            "dwell_battery_wh": stay["battery_wh"],
            "elapsed_s": t_cum,
            "o2_cum_kg": o2_cum,
            "o2_remaining_pct": 100.0 * (1 - o2_cum / o2_cap),
            "battery_cum_wh": bat_cum,
            "battery_remaining_pct": 100.0 * (1 - bat_cum / bat_cap),
            "badge": BADGE,
        })
        if seg["max_abs_grade_pct"] > PANDOLF_GRADE_LIMIT_PCT:
            warnings.append(f"Tramo {i}: pendiente de {seg['max_abs_grade_pct']:.0f} %, fuera del "
                            f"rango validado de Pandolf (±{PANDOLF_GRADE_LIMIT_PCT:.0f} %).")
        out.append(seg)
    notes = ["Pandolf no modela la rigidez de un traje presurizado; el gasto real puede ser mayor."]
    if p.carried_kg > p.astronaut_kg:
        notes.append("La masa transportada supera la del astronauta (L/W > 1): Pandolf se validó "
                     "con cargas menores, el término de carga puede sobreestimar.")
    o2_out = next((s["index"] for s in out if s["o2_cum_kg"] > o2_cap), None)
    bat_out = next((s["index"] for s in out if s["battery_cum_wh"] > bat_cap), None)
    if o2_out is not None:
        warnings.append(f"El O2 primario se agota en el tramo {o2_out}.")
    if bat_out is not None:
        warnings.append(f"La batería se agota en el tramo {bat_out}.")
    return {
        "badge": BADGE,
        "source": SOURCE,
        "segments": out,
        "totals": {
            "distance_m": sum(s["distance_m"] for s in out),
            "duration_s": t_cum,
            "energy_kj": sum(s["energy_kj"] + s["dwell_energy_kj"] for s in out),
            "o2_kg": o2_cum,
            "battery_wh": bat_cum,
            "o2_remaining_pct": 100.0 * (1 - o2_cum / o2_cap),
            "battery_remaining_pct": 100.0 * (1 - bat_cum / bat_cap),
            "o2_exhausted_at_segment": o2_out,
            "battery_exhausted_at_segment": bat_out,
        },
        "assumptions": {**p.as_dict(), "speed_m_s": speed_m_s},
        "warnings": warnings,
        "model_notes": notes,
    }
