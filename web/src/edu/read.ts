/**
 * Lectura de la respuesta de /api/route para las lecciones. Funciones puras:
 * todo número que muestra una lección sale de acá, o sea de la respuesta real.
 * Si el dato falta, devuelven null y la lección dice que falta.
 */
import { localeNow, tNow } from "../i18n/lang";
import type { LimitingFactor, MeasuredValue, RouteResponse, SafetyLimit } from "../api/schemas";
import { marsDistanceM } from "../mars/geo";

export function limitOf(route: RouteResponse, id: LimitingFactor): SafetyLimit | null {
  return route.verdict.limits?.find((l) => l.id === id) ?? null;
}

/** Valor de un MeasuredValue, o null si falta. */
export const val = (m: MeasuredValue | undefined | null): number | null => m?.value ?? null;

/** Número en castellano, con hasta `digits` decimales. "—" si falta. */
export function num(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString(localeNow(), { maximumFractionDigits: digits });
}

/** "12,3 kg" con la unidad que trae el dato. */
export function measure(m: MeasuredValue | null | undefined, digits = 1): string {
  if (!m || m.value === null) return tNow("sin dato", "no data");
  return m.unit ? `${num(m.value, digits)} ${m.unit}` : num(m.value, digits);
}

/** Margen como porcentaje: 1 − usado/límite. */
export function marginPct(l: SafetyLimit | null): string {
  return l?.margin === null || l?.margin === undefined ? tNow("sin evaluar", "not evaluated") : `${num(l.margin * 100, 0)} %`;
}

/** Distancia caminada (suma de tramos) y en línea recta entre las estaciones, en m. */
export function walkedVsStraight(route: RouteResponse): { walked: number; straight: number } | null {
  let walked = 0;
  for (const leg of route.legs) {
    const d = val(leg.distance);
    if (d === null) return null;
    walked += d;
  }
  let straight = 0;
  for (let i = 1; i < route.stops.length; i++) {
    straight += marsDistanceM(route.stops[i - 1]!, route.stops[i]!);
  }
  return straight > 0 ? { walked, straight } : null;
}

/** Pendiente máxima entre todos los tramos (°), o null si algún tramo no la tiene. */
export function maxSlope(route: RouteResponse): number | null {
  let max: number | null = null;
  for (const leg of route.legs) {
    const s = val(leg.max_slope);
    if (s === null) return null;
    max = max === null ? s : Math.max(max, s);
  }
  return max;
}

/** Minutos-equivalentes que aportó un factor del costo del A*. null = inactivo o sin dato. */
export function costMinutes(route: RouteResponse, factorId: string): number | null {
  return route.cost?.factors.find((f) => f.id === factorId)?.minutes ?? null;
}

/** Duración de la travesía completa (salida → llegada), en minutos. */
export function totalMinutes(route: RouteResponse): number | null {
  const start = route.depart_utc;
  const end = route.stops.at(-1)?.arrive_utc;
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? ms / 60_000 : null;
}

/** Límites cuyo valor eligió el equipo sin fuente citable. */
export function assumedLimits(route: RouteResponse): readonly SafetyLimit[] {
  return route.verdict.limits?.filter((l) => l.limit.provenance === "ASSUMED") ?? [];
}
