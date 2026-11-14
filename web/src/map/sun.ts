/**
 * Lógica del deslizador de tiempo del sol: qué sol mostrar, qué rango cubre la
 * línea de tiempo y qué máscara de sombra corresponde a cada instante.
 *
 * Cada hora es una máscara precomputada (pipeline/illumination.py). No se
 * interpola entre horas: se muestra la máscara más cercana y la UI dice de qué
 * hora es. El deslizador recorre el sol entero; fuera del amanecer/atardecer
 * sobre horizonte plano es de noche y el mapa pone un velo sobre el sitio.
 */
import type { CatalogSol, IlluminationCatalog, ShadowBand, SolTiles } from "../api/schemas";
import { MARS_RADIUS_M } from "../mars/constants";

export const SHADOWS_LAYER_ID = "survival-shadows";
/** Velo sobre el sitio cuando el Sol está bajo el horizonte (capa de MapLibre). */
export const SHADOWS_NIGHT_LAYER_ID = "shadow-night";

export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

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

/** Rango del deslizador: el sol entero, de medianoche a medianoche local. */
export function timelineRange(sol: SolTiles): TimeRange | null {
  const start = ms(sol.sol.start_utc);
  const end = ms(sol.sol.end_utc);
  return end > start ? { start, end } : null;
}

/**
 * Amanecer y atardecer sobre horizonte plano, en ms UTC. null si el índice no
 * lo trae (sol polar, por ejemplo): en ese caso no se marca la noche.
 */
export function flatCrossings(sol: SolTiles): { readonly rise: number | null; readonly set: number | null } {
  return {
    rise: sol.sol.flat_sunrise ? ms(sol.sol.flat_sunrise.utc) : null,
    set: sol.sol.flat_sunset ? ms(sol.sol.flat_sunset.utc) : null,
  };
}

/**
 * Lo que recorre "reproducir": amanecer a atardecer (horizonte plano). Si el
 * índice no los trae, la primera y la última hora con máscara.
 */
export function daylightRange(sol: SolTiles): TimeRange | null {
  const { rise, set } = flatCrossings(sol);
  const bands = okBands(sol);
  const first = bands[0];
  const last = bands.at(-1);
  const start = rise ?? (first ? ms(first.utc) : null);
  const end = set ?? (last ? ms(last.utc) : null);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

export type ShadowFrame =
  | { readonly kind: "night" }
  | { readonly kind: "band"; readonly band: ShadowBand; readonly offsetMin: number }
  | { readonly kind: "none" };

/** Qué dibujar en el instante `t`. */
export function frameAt(sol: SolTiles, t: number): ShadowFrame {
  const { rise, set } = flatCrossings(sol);
  if ((rise !== null && t < rise) || (set !== null && t > set)) return { kind: "night" };
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

export function clamp(t: number, range: TimeRange): number {
  return Math.min(range.end, Math.max(range.start, t));
}

/**
 * Metros por píxel sobre el suelo marciano de un tile de 256 px a ese zoom.
 * Los tiles son lat/lon de Marte etiquetado como EPSG:4326 (pipeline/tiles.py),
 * así que un grado del esquema XYZ es un grado de Marte: no vale el número de
 * la Tierra (a z15 son ~2,5 m/px en el ecuador marciano, no ~4,8).
 */
export function tileGroundM(zoom: number, lat: number): number {
  return (2 * Math.PI * MARS_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom);
}
