/**
 * Lógica del deslizador de tiempo del sol: qué sol mostrar, qué rango cubre la
 * línea de tiempo y qué máscara de sombra corresponde a cada instante.
 *
 * Cada hora es una máscara precomputada (pipeline/illumination.py). No se
 * interpola entre horas: se muestra la máscara más cercana y la UI dice de qué
 * hora es. Fuera del amanecer/atardecer sobre horizonte plano es de noche.
 */
import type { CatalogSol, IlluminationCatalog, ShadowBand, SolTiles } from "../api/schemas";

export const SHADOWS_LAYER_ID = "survival-shadows";

const ms = (iso: string) => new Date(iso).getTime();

/** El sol del catálogo que contiene el instante, o null si no se precomputó. */
export function solFor(catalog: IlluminationCatalog | null, t: Date): CatalogSol | null {
  const x = t.getTime();
  return catalog?.sols.find((s) => ms(s.start_utc) <= x && x < ms(s.end_utc)) ?? null;
}

/** Bandas teseladas sin error, ordenadas por hora. */
export function okBands(sol: SolTiles): ShadowBand[] {
  return sol.bands.filter((b) => b.status === "ok" && b.template).sort((a, b) => ms(a.utc) - ms(b.utc));
}

/**
 * Rango de la línea de tiempo: amanecer a atardecer sobre horizonte plano. Si
 * el índice no los trae (sol polar, por ejemplo), la primera y la última hora
 * con máscara.
 */
export function timelineRange(sol: SolTiles): { start: number; end: number } | null {
  const bands = okBands(sol);
  const first = bands[0];
  const last = bands.at(-1);
  const start = sol.sol.flat_sunrise ? ms(sol.sol.flat_sunrise.utc) : first ? ms(first.utc) : null;
  const end = sol.sol.flat_sunset ? ms(sol.sol.flat_sunset.utc) : last ? ms(last.utc) : null;
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

export type ShadowFrame =
  | { readonly kind: "night" }
  | { readonly kind: "band"; readonly band: ShadowBand; readonly offsetMin: number }
  | { readonly kind: "none" };

/** Qué dibujar en el instante `t`. */
export function frameAt(sol: SolTiles, t: number): ShadowFrame {
  const range = timelineRange(sol);
  if (range && (t < range.start || t > range.end)) return { kind: "night" };
  let best: ShadowBand | null = null;
  for (const b of okBands(sol)) {
    if (!best || Math.abs(ms(b.utc) - t) < Math.abs(ms(best.utc) - t)) best = b;
  }
  if (!best) return { kind: "none" };
  return { kind: "band", band: best, offsetMin: Math.round((t - ms(best.utc)) / 60_000) };
}

/** Id de la capa de MapLibre de una hora: cambia con el sol, así no se mezclan. */
export function bandLayerId(solTag: string, band: ShadowBand): string {
  return `shadow-${solTag}-${band.ltst.replace(":", "")}`;
}

export function clamp(t: number, range: { start: number; end: number }): number {
  return Math.min(range.end, Math.max(range.start, t));
}
