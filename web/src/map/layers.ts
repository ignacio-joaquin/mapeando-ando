/**
 * Catálogo de capas. Los ids son CONTRATO: los usa la API, el pipeline
 * (nombre de la salida en /data/output/<sitio>/) y el frontend. Renombrar uno
 * es breaking change y se hace en un PR que toca todas las puntas.
 */

export type LayerGroup = "relieve" | "supervivencia";

import type { SourceInfo } from "../domain/provenance";

export interface LegendStop {
  readonly color: string;
  readonly label: string;
}

/**
 * Clases de pendiente: UNA sola definición para la capa del mapa, la leyenda y
 * el perfil de elevación. Si un tramo se ve rojo en el perfil, se ve rojo en el
 * mapa.
 *
 * Los mismos cortes están en `RAMPAS["pendiente"]` de `pipeline/tiles.py`, que
 * es quien colorea el PNG. Si se cambian acá, hay que cambiarlos allá.
 */
export interface SlopeClass {
  /** Límite superior en grados; el último es Infinity. */
  readonly maxDeg: number;
  readonly color: string;
  readonly label: string;
}

export const SLOPE_CLASSES: readonly SlopeClass[] = [
  { maxDeg: 10, color: "#2f7d4f", label: "0–10° transitable" },
  { maxDeg: 20, color: "#e0a24a", label: "10–20° con cuidado" },
  // 25° es el límite duro de pendiente del planificador (api/safety.py): lo que se pinta
  // "no transitable" es lo que la ruta no pisa.
  { maxDeg: 25, color: "#e07a4a", label: "20–25° límite del rover" },
  { maxDeg: Infinity, color: "#e0564a", label: "> 25° no transitable" },
];

/** Clase de una pendiente en grados. Fuera de rango cae en la más severa. */
export function slopeClass(deg: number): SlopeClass {
  return (
    SLOPE_CLASSES.find((c) => deg < c.maxDeg) ??
    SLOPE_CLASSES[SLOPE_CLASSES.length - 1]!
  );
}

const SLOPE_LEGEND: readonly LegendStop[] = SLOPE_CLASSES.map((c) => ({
  color: c.color,
  label: c.label,
}));

export interface LayerSpec {
  readonly id: string;
  readonly label: string;
  readonly group: LayerGroup;
  /** Unidad del valor que representa, para la leyenda y el inspector. */
  readonly unit: string | null;
  /** Procedencia: va en el badge. Sin esto la capa no se muestra. */
  readonly source: SourceInfo;
  readonly legend: readonly LegendStop[];
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
    label: "Ortoimagen",
    group: "relieve",
    unit: null,
    source: {
      provenance: "OBSERVED",
      mission: "MRO",
      instrument: "HiRISE",
      resolution: "25 cm/px",
      source: "Ortomosaico HiRISE (USGS)",
    },
    legend: [{ color: "#8a7a6a", label: "imagen real, sin realce" }],
    tiles: "/tiles/{site}/ortho/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: true,
  },
  {
    id: "relief-hillshade",
    label: "Hillshade",
    group: "relieve",
    unit: null,
    source: {
      provenance: "DERIVED",
      mission: "MRO",
      instrument: "HiRISE DTM",
      resolution: "1 m/px",
      source: "Calculado por el pipeline desde el DTM HiRISE (USGS)",
      assumptions: [
        "Iluminación sintética fija: no es la luz real del momento",
        "Relieve exagerado x3 en vertical",
      ],
    },
    legend: [
      { color: "#2a2520", label: "sombra" },
      { color: "#d8cec2", label: "luz" },
    ],
    tiles: "/tiles/{site}/hillshade/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: true,
  },
  {
    id: "relief-contours",
    label: "Curvas de nivel",
    group: "relieve",
    unit: "m",
    source: {
      provenance: "DERIVED",
      mission: "MRO",
      instrument: "HiRISE DTM",
      resolution: "1 m/px",
      source: "Calculado por el pipeline desde el DTM HiRISE (USGS)",
    },
    legend: [{ color: "#e0a24a", label: "equidistancia 10 m" }],
    tiles: "/tiles/{site}/contours.geojson",
    kind: "vector",
    defaultVisible: false,
  },
  {
    id: "relief-slope",
    label: "Pendiente",
    group: "relieve",
    unit: "°",
    source: {
      provenance: "DERIVED",
      mission: "MRO",
      instrument: "HiRISE DTM",
      resolution: "1 m/px",
      source: "Calculado por el pipeline desde el DTM HiRISE (USGS)",
    },
    legend: SLOPE_LEGEND,
    tiles: "/tiles/{site}/slope/{z}/{x}/{y}.png",
    kind: "raster",
    categorical: true,
    defaultVisible: false,
  },
  {
    id: "survival-hazard",
    label: "Peligro",
    group: "supervivencia",
    unit: "índice 0–1",
    source: {
      provenance: "MODELED",
      mission: "MRO",
      instrument: "HiRISE DTM + ortho",
      resolution: "1 m/px",
      source: "Índice del pipeline a partir del DTM y la ortoimagen HiRISE",
      assumptions: ["Índice propio, no una medición: combina terreno con pesos definidos por el equipo"],
    },
    legend: [
      { color: "#2f7d4f", label: "bajo" },
      { color: "#e0a24a", label: "medio" },
      { color: "#e0564a", label: "alto" },
    ],
    tiles: "/tiles/{site}/hazard/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: false,
  },
  {
    id: "survival-shelter",
    label: "Refugio",
    group: "supervivencia",
    unit: "índice 0–1",
    source: {
      provenance: "MODELED",
      mission: "MRO",
      instrument: "HiRISE DTM",
      resolution: "1 m/px",
      source: "Índice del pipeline a partir del DTM HiRISE",
      assumptions: ["Índice propio, no una medición"],
    },
    legend: [
      { color: "#5fbf86", label: "protegido" },
      { color: "#3a342e", label: "expuesto" },
    ],
    tiles: "/tiles/{site}/shelter/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: false,
  },
  {
    id: "survival-dose",
    label: "Dosis",
    group: "supervivencia",
    unit: "µSv/h",
    source: {
      provenance: "MODELED",
      mission: "MSL",
      instrument: "RAD",
      resolution: "derivada, 200 m/px",
      source: "Base medida por MSL RAD en Gale (Hassler et al. 2014, reference/rad_surface_dose.json)",
      assumptions: [
        "Valor de base medido en Gale, 2012–2013; se extrapola al terreno",
        "Varía con el ciclo solar, la presión estacional y eventos solares",
      ],
    },
    legend: [
      { color: "#2f7d4f", label: "nominal" },
      { color: "#e0a24a", label: "elevada" },
      { color: "#e0564a", label: "limitar exposición" },
    ],
    tiles: "/tiles/{site}/dose/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: false,
  },
  {
    id: "survival-shadows",
    label: "Sombras",
    group: "supervivencia",
    unit: "hora solar local",
    source: {
      provenance: "DERIVED",
      mission: "MRO",
      instrument: "HiRISE DTM + NAIF SPICE",
      // La pila sale a la resolución del DTM, pero lo que se dibuja son tiles
      // hasta z15: ~2,5 m/px en Marte (el badge del deslizador da el número del sitio).
      resolution: "pila a la del DTM; se dibuja hasta z15 (~2,5 m/px)",
      source: "pipeline/illumination.py: geometría solar (SPICE) sobre el DTM",
      assumptions: [
        "Sol puntual, sin refracción ni polvo; solo sol directo",
        "Una máscara por hora: la hora la elige el deslizador del sol",
        "De noche (Sol bajo el horizonte plano), un velo sobre todo el sitio",
      ],
    },
    // Colores de pipeline/shadow_tiles.py (COLORES). Al sol no se pinta.
    legend: [
      { color: "#0c0a09", label: "en sombra" },
      { color: "#788296", label: "sin dato" },
    ],
    // No se usa: las horas salen de illumination/<sol>/tiles.json (map/sun.ts).
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
