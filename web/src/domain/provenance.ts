import { MARS_RADIUS_M } from "../mars/constants";

/**
 * Formato común de un número visible: valor + unidad + de dónde sale.
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
 * - ASSUMED: valor elegido por el equipo, sin fuente citable todavía (los
 *   límites duros del veredicto). Se muestra como tal hasta tener la fuente.
 */
export type Provenance = "OBSERVED" | "DERIVED" | "MODELED" | "ASSUMED";

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

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  OBSERVED: "observado",
  DERIVED: "derivado",
  MODELED: "modelado",
  ASSUMED: "supuesto del equipo, sin fuente citable",
};

/** Texto corto del badge: "MRO HiRISE · DERIVED". */
export function sourceLabel(s: SourceInfo): string {
  const who = [s.mission, s.instrument].filter(Boolean).join(" ");
  return `${who || "cálculo local"} · ${s.provenance}`;
}

const km = (m: number) => (m / 1000).toFixed(m % 1000 === 0 ? 0 : 2);

/** Procedencia de lo que calcula el frontend con geometría esférica. */
export const LOCAL_GEOMETRY: SourceInfo = {
  provenance: "DERIVED",
  mission: null,
  instrument: "geometría esférica",
  source: "Cálculo en el navegador (src/mars/geo.ts)",
  assumptions: [
    `Esfera IAU Mars 2000 de radio ${km(MARS_RADIUS_M)} km, la misma de los DTM y de la API`,
    "Distancia sobre la superficie en línea recta, sin relieve",
  ],
};

/** Procedencia del reloj marciano (Mars24, en el cliente). */
export const MARS24: SourceInfo = {
  provenance: "MODELED",
  mission: "NASA GISS",
  instrument: "Mars24",
  source: "Algoritmo Mars24 (Allison & McEwen 2000), calculado en el navegador",
  assumptions: ["Hora del reloj de esta computadora", "Longitud del centro del sitio"],
};

/** Hora solar local derivada de una hora UTC (Mars24). */
export const MARS24_LTST: SourceInfo = {
  ...MARS24,
  assumptions: ["Hora solar verdadera local en la longitud de cada punto"],
};
