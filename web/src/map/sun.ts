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
import { declinationDeg, dlsDeg, localMidnightBefore, marsTime } from "../mars/mars24";
import { localeNow, tNow } from "../i18n/lang";

export const SHADOWS_LAYER_ID = "survival-shadows";
/** Velo sobre el sitio cuando el Sol está bajo el horizonte (capa de MapLibre). */
export const SHADOWS_NIGHT_LAYER_ID = "shadow-night";

/**
 * Distancia de estación máxima para mostrar las sombras de otro sol (docs/context.md §5).
 * Es el mismo tope que usa el veredicto (SOL_REUSE_MAX_DLS_DEG de api/illumination.py):
 * si cambia uno, cambia el otro.
 */
export const SOL_REUSE_MAX_DLS_DEG = 2;

export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

/** Sombras de otro sol de la misma estación, llevadas a la fecha pedida. */
export interface SolReuse {
  readonly sourceTag: string;
  readonly sourceLs: number;
  readonly targetLs: number;
  /** Ls de destino menos Ls de origen, entre −180 y 180. */
  readonly dls: number;
  /** Diferencia de declinación del Sol entre los dos soles (°). */
  readonly ddecl: number;
  /** Cuánto se corren los instantes de la pila (ms, destino − origen). */
  readonly shiftMs: number;
}

export interface SolPick {
  readonly sol: CatalogSol;
  /** null = es el sol de la hora pedida. */
  readonly reuse: SolReuse | null;
}

const ms = (iso: string) => new Date(iso).getTime();

/**
 * El sol del catálogo para el instante: el que lo contiene o, si no se
 * precomputó, el de la misma estación (|ΔLs| ≤ tope, cualquier año marciano)
 * más cercano. Mismo criterio que stack_for_time de api/illumination.py, así el
 * deslizador y el veredicto usan el mismo sol. `lonEast`: meridiano de la
 * medianoche local (el centro del sitio).
 */
export function pickSol(catalog: IlluminationCatalog | null, t: Date, lonEast: number): SolPick | null {
  if (!catalog) return null;
  const x = t.getTime();
  const exact = catalog.sols.find((s) => ms(s.start_utc) <= x && x < ms(s.end_utc));
  if (exact) return { sol: exact, reuse: null };

  const midnight = localMidnightBefore(t, lonEast);
  const targetLs = marsTime(new Date(midnight)).ls;
  let best: SolPick | null = null;
  for (const s of catalog.sols) {
    if (s.ls_deg == null) continue; // pila vieja: solo sirve para su propio sol
    const dls = dlsDeg(s.ls_deg, targetLs);
    if (Math.abs(dls) > SOL_REUSE_MAX_DLS_DEG) continue;
    if (best?.reuse && Math.abs(best.reuse.dls) <= Math.abs(dls)) continue;
    best = {
      sol: s,
      reuse: {
        sourceTag: s.tag,
        sourceLs: s.ls_deg,
        targetLs,
        dls,
        ddecl: Math.abs(declinationDeg(targetLs) - declinationDeg(s.ls_deg)),
        shiftMs: midnight - ms(s.start_utc),
      },
    };
  }
  return best;
}

/** Número con el separador decimal del idioma elegido. */
export function formatDeg(x: number, digits = 1, signed = false): string {
  return x.toLocaleString(localeNow(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: signed ? "always" : "auto",
  });
}

/** Supuestos de una pila reutilizada: los mismos que declara la API (api/illumination.py). */
export function reuseAssumptions(r: SolReuse): string[] {
  return [
    tNow(
      `Sombras del sol ${r.sourceTag} (Ls ${formatDeg(r.sourceLs)}°) usadas para la fecha pedida ` +
        `(Ls ${formatDeg(r.targetLs)}°, ΔLs ${formatDeg(r.dls, 1, true)}°, tope ±${SOL_REUSE_MAX_DLS_DEG}°): ` +
        "misma estación y misma hora solar local, de cualquier año marciano",
      `Shadows from sol ${r.sourceTag} (Ls ${formatDeg(r.sourceLs)}°) used for the requested date ` +
        `(Ls ${formatDeg(r.targetLs)}°, ΔLs ${formatDeg(r.dls, 1, true)}°, limit ±${SOL_REUSE_MAX_DLS_DEG}°): ` +
        "same season and same local solar time, from any Mars year",
    ),
    tNow(
      `A la misma hora solar local solo cambia la declinación del Sol: ${formatDeg(r.ddecl, 2)}° de ` +
        "diferencia (Mars24). Las sombras con el Sol bajo son las que más se apartan",
      `At the same local solar time only the Sun's declination changes: ${formatDeg(r.ddecl, 2)}° of ` +
        "difference (Mars24). Shadows with a low Sun are the ones that differ most",
    ),
    tNow(
      "Amanecer y atardecer: los de ese sol, a la misma hora solar local",
      "Sunrise and sunset: those of that sol, at the same local solar time",
    ),
  ];
}

const shiftIso = (iso: string, d: number) => new Date(ms(iso) + d).toISOString();

/**
 * La misma pila con todos sus instantes corridos: misma hora solar local, otro
 * sol. Los tiles (plantillas por hora LTST) no cambian.
 */
export function shiftSolTiles(sol: SolTiles, shiftMs: number): SolTiles {
  if (shiftMs === 0) return sol;
  const cross = (c: SolTiles["sol"]["flat_sunrise"]) => (c ? { ...c, utc: shiftIso(c.utc, shiftMs) } : c);
  return {
    ...sol,
    sol: {
      ...sol.sol,
      start_utc: shiftIso(sol.sol.start_utc, shiftMs),
      end_utc: shiftIso(sol.sol.end_utc, shiftMs),
      flat_sunrise: cross(sol.sol.flat_sunrise),
      flat_sunset: cross(sol.sol.flat_sunset),
    },
    bands: sol.bands.map((b) => ({ ...b, utc: shiftIso(b.utc, shiftMs) })),
  };
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
