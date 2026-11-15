/**
 * ¿Hay terreno de 1 m real en este punto? Lo responde coverage.geojson, la
 * huella del DTM que escribe pipeline/precompute.py (capa `coverage`).
 *
 * Es un chequeo de punto en polígono sobre lon/lat, sin proyectar: la huella
 * está en grados y los anillos son chicos (un sitio mide ~20 km), así que la
 * distorsión no cambia de qué lado del borde cae un punto.
 */
import type { Coverage } from "../api/schemas";
import type { LatLon } from "../mars/geo";

type Ring = readonly (readonly number[])[];
type Polygon = readonly Ring[];

export type CoverageCheck =
  /** Adentro de la huella del DTM. */
  | { readonly kind: "ok" }
  /** Afuera: no hay terreno de 1 m, el planificador lo rechaza. */
  | { readonly kind: "outside"; readonly message: string }
  /** Todavía no hay mapa de cobertura: se acepta, pero se dice que no se verificó. */
  | { readonly kind: "unverified"; readonly message: string };

export const OUTSIDE_MESSAGE =
  "Ese punto no tiene terreno de 1 m real (DTM HiRISE): no se puede planificar ahí. Elegí uno dentro del área cubierta.";

export const UNVERIFIED_MESSAGE =
  "Todavía no está el mapa de cobertura del pipeline: no se pudo verificar que los puntos tengan terreno de 1 m.";

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi = 0, yi = 0] = ring[i] ?? [];
    const [xj = 0, yj = 0] = ring[j] ?? [];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon: number, lat: number, poly: Polygon): boolean {
  const [outer, ...holes] = poly;
  if (!outer || !inRing(lon, lat, outer)) return false;
  return !holes.some((h) => inRing(lon, lat, h));
}

export function insideCoverage(coverage: Coverage, p: LatLon): boolean {
  return coverage.features.some((f) =>
    f.geometry.type === "Polygon"
      ? inPolygon(p.lon, p.lat, f.geometry.coordinates)
      : f.geometry.coordinates.some((poly) => inPolygon(p.lon, p.lat, poly)),
  );
}

export function checkCoverage(coverage: Coverage | null, p: LatLon): CoverageCheck {
  if (!coverage) return { kind: "unverified", message: UNVERIFIED_MESSAGE };
  return insideCoverage(coverage, p) ? { kind: "ok" } : { kind: "outside", message: OUTSIDE_MESSAGE };
}
