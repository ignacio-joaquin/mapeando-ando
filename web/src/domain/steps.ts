/**
 * Indicaciones de toda la ruta como una lista de pasos, con el trecho del mapa
 * al que corresponde cada uno.
 *
 * La API manda las indicaciones por tramo, en orden, con la distancia de cada
 * trecho. Acá solo se recorta la polilínea del tramo por esas distancias para
 * poder resaltar el trecho en el mapa: es dibujo, no un cálculo nuevo.
 */
import type { Direction, RouteResponse } from "../api/schemas";
import { marsDistanceM } from "../mars/geo";
import { MARS_RADIUS_M } from "../mars/constants";

export type LonLat = readonly [number, number];

export interface RouteStep {
  /** Índice global (0, 1, 2…) en toda la ruta. */
  readonly index: number;
  readonly leg: number;
  readonly direction: Direction;
  /** El trecho sobre el mapa, [lon, lat]. */
  readonly path: readonly LonLat[];
  /** Hacia dónde se mira (borde o centro del landmark). null en los respaldos. */
  readonly aim: LonLat | null;
}

const dist = (a: LonLat, b: LonLat) => marsDistanceM({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });

/** Corta la polilínea entre dos distancias desde su inicio. */
export function slicePath(coords: readonly LonLat[], from: number, to: number): LonLat[] {
  if (coords.length < 2) return [...coords];
  const out: LonLat[] = [];
  let acc = 0;
  const lerp = (a: LonLat, b: LonLat, t: number): LonLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const d = dist(a, b);
    const s0 = acc;
    const s1 = acc + d;
    if (s1 >= from && s0 <= to && d > 0) {
      const t0 = Math.max(0, (from - s0) / d);
      const t1 = Math.min(1, (to - s0) / d);
      if (out.length === 0) out.push(lerp(a, b, t0));
      out.push(lerp(a, b, t1));
    }
    acc = s1;
    if (acc > to) break;
  }
  return out.length >= 2 ? out : [coords[0]!, coords[coords.length - 1]!];
}

export function routeSteps(route: RouteResponse | null | undefined): RouteStep[] {
  if (!route) return [];
  const steps: RouteStep[] = [];
  route.legs.forEach((leg, li) => {
    const dirs = leg.directions ?? [];
    let start = 0;
    for (const d of dirs) {
      const len = d.distance.value;
      const path =
        len === null || dirs.length === 1 ? [...leg.coordinates] : slicePath(leg.coordinates, start, start + len);
      start += len ?? 0;
      const lm = d.landmark;
      const aim: LonLat | null = lm ? (lm.target ? [lm.target.lon, lm.target.lat] : [lm.lon, lm.lat]) : null;
      steps.push({ index: steps.length, leg: li, direction: d, path, aim });
    }
  });
  return steps;
}

/** Punto a `meters` de `p` con rumbo `azDeg` (0 = norte). Aproximación plana: alcanza para dibujar. */
export function offset(p: LonLat, azDeg: number, meters: number): LonLat {
  const R = MARS_RADIUS_M;
  const az = (azDeg * Math.PI) / 180;
  const dLat = ((meters * Math.cos(az)) / R) * (180 / Math.PI);
  const dLon = ((meters * Math.sin(az)) / (R * Math.cos((p[1] * Math.PI) / 180))) * (180 / Math.PI);
  return [p[0] + dLon, p[1] + dLat];
}

/** Largo de un trecho en metros (sobre Marte). */
export function pathLength(path: readonly LonLat[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += dist(path[i - 1]!, path[i]!);
  return d;
}

/** Punto medio de un trecho, para la línea de vista dibujada hacia el landmark. */
export function midpoint(path: readonly LonLat[]): LonLat {
  return path[Math.floor(path.length / 2)] ?? path[0] ?? [0, 0];
}
