/**
 * Pines de lugares sobre el mapa, como en Google Maps: los mismos lugares de
 * places.json que usa el buscador, dibujados como una capa de símbolos.
 *
 * Cada tipo tiene color Y símbolo propio (nada se distingue solo por color).
 * Los íconos se dibujan en un canvas al cargar el mapa: no dependen de un
 * sprite externo ni de tipografías del server de glifos.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import type { Place, PlaceKind } from "../api/schemas";

/** Ids de la fuente y las capas. Solo los usa el frontend. */
export const PLACES_SOURCE = "places";
export const PLACES_LAYER = "places-pins";
export const PLACES_SELECTED_LAYER = "places-selected";

export interface PlaceKindStyle {
  readonly color: string;
  /** Símbolo dentro del pin. Junto con el color, identifica el tipo. */
  readonly glyph: string;
  /** Prioridad al superponerse: menor gana (queda visible). */
  readonly rank: number;
  readonly defaultVisible: boolean;
}

export const PLACE_KIND_STYLE: Record<PlaceKind, PlaceKindStyle> = {
  iau: { color: "#f2d36b", glyph: "★", rank: 0, defaultVisible: true },
  sample: { color: "#e08cc0", glyph: "◆", rank: 1, defaultVisible: true },
  target: { color: "#6cb8e0", glyph: "◎", rank: 2, defaultVisible: true },
  heli: { color: "#5fbf86", glyph: "H", rank: 3, defaultVisible: true },
  // Cerros sin nombre sacados del DTM: cubren todo el sitio, no solo el camino del rover.
  landmark: { color: "#c9a27a", glyph: "▲", rank: 4, defaultVisible: true },
  // Puntos sin nombre y numerosos: apagados de entrada. Las señales de CRISM son indicios desde
  // órbita; las hondonadas, posibles cráteres; el recorrido del rover y los cráteres de Robbins, miles.
  orbital: { color: "#b48ce0", glyph: "◈", rank: 5, defaultVisible: false },
  rover: { color: "#e07a4a", glyph: "R", rank: 6, defaultVisible: false },
  depression: { color: "#8fa3b8", glyph: "▼", rank: 7, defaultVisible: false },
  crater: { color: "#a39a8f", glyph: "○", rank: 8, defaultVisible: false },
};

export const PLACE_KINDS = Object.keys(PLACE_KIND_STYLE) as PlaceKind[];

export const iconId = (kind: PlaceKind) => `place-pin-${kind}`;

/** Pin en forma de gota, con borde oscuro para que se lea sobre la ortoimagen. */
function drawPin(style: PlaceKindStyle, ratio: number): ImageData {
  const w = 26 * ratio;
  const h = 34 * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new ImageData(w, h);
  const r = 11 * ratio;
  const cx = w / 2;
  const cy = r + 2 * ratio;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.8, Math.PI * 2.2);
  ctx.lineTo(cx, h - 1.5 * ratio);
  ctx.closePath();
  ctx.fillStyle = style.color;
  ctx.fill();
  ctx.lineWidth = 2 * ratio;
  ctx.strokeStyle = "#0b0a09";
  ctx.stroke();
  ctx.fillStyle = "#0b0a09";
  ctx.font = `bold ${12 * ratio}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(style.glyph, cx, cy + 0.5 * ratio);
  return ctx.getImageData(0, 0, w, h);
}

/** Registra los íconos de los pines en el mapa (idempotente). */
export function addPinImages(map: MapLibreMap): void {
  const ratio = 2;
  for (const kind of PLACE_KINDS) {
    const id = iconId(kind);
    if (map.hasImage(id)) continue;
    map.addImage(id, drawPin(PLACE_KIND_STYLE[kind], ratio), { pixelRatio: ratio });
  }
}

export function placesToGeoJSON(places: readonly Place[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: places.map((p) => ({
      type: "Feature",
      properties: { id: p.id, name: p.name, kind: p.kind, rank: PLACE_KIND_STYLE[p.kind].rank },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  };
}
