/**
 * Catálogo de capas. Los ids son CONTRATO: los usa la API, el pipeline
 * (nombre de la salida en /data/output/<sitio>/) y el frontend. Renombrar uno
 * es breaking change y se hace en un PR que toca todas las puntas.
 */

export type LayerGroup = "relieve" | "supervivencia";

import type { SourceInfo } from "../domain/provenance";
import type { Messages } from "../i18n";
import type { LayerText } from "../i18n/messages";

/** Ids de capa: CONTRATO (ver arriba). Sus textos están en src/i18n/messages.ts. */
export type LayerId =
  | "base-ortho"
  | "relief-hillshade"
  | "relief-contours"
  | "relief-slope"
  | "survival-hazard"
  | "survival-shelter"
  | "survival-dose"
  | "survival-shadows";

export interface LegendStop {
  readonly color: string;
  readonly label: string;
}

/**
 * Clases de pendiente: UNA sola definición para la capa del mapa, la leyenda y
 * el perfil de elevación. Si un tramo se ve rojo en el perfil, se ve rojo en el
 * mapa. Las etiquetas, en el mismo orden, son `slopeClasses` de los textos.
 *
 * Los mismos cortes están en `RAMPAS["pendiente"]` de `pipeline/tiles.py`, que
 * es quien colorea el PNG. Si se cambian acá, hay que cambiarlos allá.
 */
export interface SlopeClass {
  /** Límite superior en grados; el último es Infinity. */
  readonly maxDeg: number;
  readonly color: string;
}

export const SLOPE_CLASSES: readonly SlopeClass[] = [
  { maxDeg: 10, color: "#2f7d4f" },
  { maxDeg: 20, color: "#e0a24a" },
  { maxDeg: 30, color: "#e07a4a" },
  { maxDeg: Infinity, color: "#e0564a" },
];

/** Clase de una pendiente en grados. Fuera de rango cae en la más severa. */
export function slopeClass(deg: number): SlopeClass {
  return (
    SLOPE_CLASSES.find((c) => deg < c.maxDeg) ??
    SLOPE_CLASSES[SLOPE_CLASSES.length - 1]!
  );
}

export interface LayerSpec {
  readonly id: LayerId;
  readonly group: LayerGroup;
  /**
   * Procedencia sin texto traducible (misión e instrumento son nombres
   * propios). Fuente, resolución y supuestos salen de los textos de la capa.
   * Sin esto la capa no se muestra.
   */
  readonly source: Pick<SourceInfo, "provenance" | "mission" | "instrument">;
  /** Colores de la leyenda; las etiquetas van en los textos, mismo orden. */
  readonly legendColors: readonly string[];
  /** Plantilla de tiles, relativa. `{site}` se reemplaza por el id del sitio. */
  readonly tiles: string;
  readonly kind: "raster" | "vector";
  readonly defaultVisible: boolean;
  /**
   * Raster por clases (cada color es un rango de la leyenda): se dibuja sin
   * suavizar al agrandar, para no inventar colores intermedios.
   */
  readonly categorical?: boolean;
}

export const LAYERS: readonly LayerSpec[] = [
  {
    id: "base-ortho",
    group: "relieve",
    source: { provenance: "OBSERVED", mission: "MRO", instrument: "HiRISE" },
    legendColors: ["#8a7a6a"],
    tiles: "/tiles/{site}/ortho/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: true,
  },
  {
    id: "relief-hillshade",
    group: "relieve",
    source: { provenance: "DERIVED", mission: "MRO", instrument: "HiRISE DTM" },
    legendColors: ["#2a2520", "#d8cec2"],
    tiles: "/tiles/{site}/hillshade/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: true,
  },
  {
    id: "relief-contours",
    group: "relieve",
    source: { provenance: "DERIVED", mission: "MRO", instrument: "HiRISE DTM" },
    legendColors: ["#e0a24a"],
    tiles: "/tiles/{site}/contours.geojson",
    kind: "vector",
    defaultVisible: false,
  },
  {
    id: "relief-slope",
    group: "relieve",
    source: { provenance: "DERIVED", mission: "MRO", instrument: "HiRISE DTM" },
    legendColors: SLOPE_CLASSES.map((c) => c.color),
    tiles: "/tiles/{site}/slope/{z}/{x}/{y}.png",
    kind: "raster",
    categorical: true,
    defaultVisible: false,
  },
  {
    id: "survival-hazard",
    group: "supervivencia",
    source: { provenance: "MODELED", mission: "MRO", instrument: "HiRISE DTM + ortho" },
    legendColors: ["#2f7d4f", "#e0a24a", "#e0564a"],
    tiles: "/tiles/{site}/hazard/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: false,
  },
  {
    id: "survival-shelter",
    group: "supervivencia",
    source: { provenance: "MODELED", mission: "MRO", instrument: "HiRISE DTM" },
    legendColors: ["#5fbf86", "#3a342e"],
    tiles: "/tiles/{site}/shelter/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: false,
  },
  {
    id: "survival-dose",
    group: "supervivencia",
    source: { provenance: "MODELED", mission: "MSL", instrument: "RAD" },
    legendColors: ["#2f7d4f", "#e0a24a", "#e0564a"],
    tiles: "/tiles/{site}/dose/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: false,
  },
  {
    id: "survival-shadows",
    group: "supervivencia",
    source: { provenance: "MODELED", mission: "MRO", instrument: "HiRISE DTM + SPICE" },
    legendColors: ["#161412", "#e0a24a"],
    tiles: "/tiles/{site}/shadows/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: false,
  },
];

export function tileUrl(spec: LayerSpec, siteId: string): string {
  return spec.tiles.replace("{site}", siteId);
}

export function layersByGroup(group: LayerGroup): readonly LayerSpec[] {
  return LAYERS.filter((l) => l.group === group);
}

/** Textos de una capa en el idioma activo. */
export function layerText(t: Messages, id: LayerId): LayerText {
  return t.layers[id];
}

/** Procedencia completa de una capa (lo que dibuja el badge), en el idioma activo. */
export function layerSource(spec: LayerSpec, t: Messages): SourceInfo {
  const text = layerText(t, spec.id);
  return {
    ...spec.source,
    resolution: text.resolution,
    source: text.source,
    assumptions: text.assumptions,
  };
}

/** Leyenda: cada color con su etiqueta, en el idioma activo. */
export function layerLegend(spec: LayerSpec, t: Messages): readonly LegendStop[] {
  const labels = layerText(t, spec.id).legend;
  return spec.legendColors.map((color, i) => ({ color, label: labels[i] ?? "" }));
}
