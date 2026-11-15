/**
 * Búsqueda sobre places.json (pipeline/places.py), en memoria: son entre ~2.400
 * y ~8.500 lugares por sitio (casi todos cráteres de Robbins y posiciones del
 * rover) y filtrar eso en el navegador alcanza sin un endpoint.
 */
import type { Place, PlaceKind } from "../api/schemas";

/** "Cráter" y "crater" encuentran lo mismo, con o sin mayúsculas. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Nombres oficiales primero, después lugares con nombre de la misión, el rover y cráteres sin nombre. */
const KIND_ORDER: Record<PlaceKind, number> = { iau: 0, sample: 1, target: 2, heli: 3, rover: 4, crater: 5 };

export const KIND_LABEL: Record<PlaceKind, string> = {
  iau: "nombre IAU",
  sample: "tubo de muestra",
  target: "objetivo científico",
  heli: "aeródromo de Ingenuity",
  rover: "rover",
  crater: "cráter",
};

function score(place: Place, q: string): number | null {
  const name = normalize(place.name);
  if (name.startsWith(q)) return 0;
  if (name.split(/[\s·()-]+/).some((w) => w.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if (normalize(place.detail).includes(q)) return 3;
  return null;
}

export function searchPlaces(places: readonly Place[], query: string, limit = 8): Place[] {
  const q = normalize(query);
  if (!q) return [];
  return places
    .map((p) => ({ p, s: score(p, q) }))
    .filter((x): x is { p: Place; s: number } => x.s !== null)
    .sort(
      (a, b) =>
        a.s - b.s ||
        KIND_ORDER[a.p.kind] - KIND_ORDER[b.p.kind] ||
        a.p.name.localeCompare(b.p.name, "es", { numeric: true }),
    )
    .slice(0, limit)
    .map((x) => x.p);
}
