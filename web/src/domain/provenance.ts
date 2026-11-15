import { MARS_RADIUS_M } from "../mars/constants";
import type { Messages } from "../i18n";

/**
 * Formato común de un número visible: valor + unidad + de dónde sale.
 *
 * Los textos (fuente, supuestos) salen del idioma activo: por eso las
 * procedencias del frontend son funciones de `t` (src/i18n).
 *
 * Regla del briefing: todo número que ve el usuario lleva badge de
 * procedencia. Este tipo es lo que consume <Measure> y <ProvenanceBadge>.
 *
 * Es el mismo formato que devuelve la API: lo valida MeasuredValueSchema en
 * src/api/schemas.ts (con un chequeo de tipos que obliga a que coincidan).
 * Contrato documentado en docs/context.md §4.
 */

/**
 * - OBSERVED: medido directo por un instrumento (imagen HiRISE, dosis RAD medida).
 * - DERIVED: calculado de forma determinista a partir de un dato observado
 *   (pendiente desde el DTM, distancia geodésica).
 * - MODELED: sale de un modelo con supuestos (dosis extrapolada, índice de
 *   peligro, efemérides). Siempre debería traer `assumptions`.
 */
export type Provenance = "OBSERVED" | "DERIVED" | "MODELED";

export interface SourceInfo {
  readonly provenance: Provenance;
  /** Misión, ej. "MRO", "MSL". null = cálculo local del frontend. */
  readonly mission: string | null;
  /** Instrumento o modelo, ej. "HiRISE", "RAD", "Mars24". */
  readonly instrument: string | null;
  /** Resolución del producto de origen, ej. "1 m/px". */
  readonly resolution?: string | undefined;
  /** Fuente legible para el tooltip (producto, paper, endpoint). */
  readonly source?: string | undefined;
  /** Supuestos del cálculo o del modelo, para el tooltip. */
  readonly assumptions?: readonly string[] | undefined;
}

export interface DataValue extends SourceInfo {
  /** null = el dato falta. Se muestra que falta; nunca se rellena. */
  readonly value: number | null;
  readonly unit: string | null;
}

/** Texto corto del badge: "MRO HiRISE · DERIVED". */
export function sourceLabel(s: SourceInfo, t: Messages): string {
  const who = [s.mission, s.instrument].filter(Boolean).join(" ");
  return `${who || t.badge.localCalc} · ${s.provenance}`;
}

const km = (m: number) => (m / 1000).toFixed(m % 1000 === 0 ? 0 : 2);

/** Procedencia de lo que calcula el frontend con geometría esférica. */
export function localGeometry(t: Messages): SourceInfo {
  return {
    provenance: "DERIVED",
    mission: null,
    instrument: t.sources.localGeometryInstrument,
    source: t.sources.localGeometrySource,
    assumptions: t.sources.localGeometryAssumptions(km(MARS_RADIUS_M)),
  };
}

/** Procedencia del reloj marciano (Mars24, en el cliente). */
export function mars24(t: Messages): SourceInfo {
  return {
    provenance: "MODELED",
    mission: "NASA GISS",
    instrument: "Mars24",
    source: t.sources.mars24Source,
    assumptions: t.sources.mars24Assumptions,
  };
}

/** Hora solar local derivada de una hora UTC (Mars24). */
export function mars24Ltst(t: Messages): SourceInfo {
  return { ...mars24(t), assumptions: t.sources.mars24LtstAssumptions };
}
