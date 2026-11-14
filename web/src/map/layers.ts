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
  { maxDeg: 30, color: "#e07a4a", label: "20–30° límite del rover" },
  { maxDeg: Infinity, color: "#e0564a", label: "> 30° no transitable" },
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
  /** Script del pipeline que la genera, para el aviso cuando falla. Default: precompute.py. */
  readonly script?: string;
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
    id: "survival-shelter-minutes",
    label: "Minutos al refugio",
    group: "supervivencia",
    unit: "min",
    script: "shelter.py",
    source: {
      provenance: "MODELED",
      mission: "MRO",
      instrument: "HiRISE DTM",
      resolution: "10 m/px",
      source: "Calculado por el pipeline desde el DTM HiRISE (USGS) y la capa de refugios",
      assumptions: [
        "Caminata de Tobler (1993) escalada a 0,8 m/s en plano",
        "Más de 30° no se pisa",
        "Provisorio hasta que exista el costo del planificador",
      ],
    },
    // Los mismos cortes que RAMPAS["minutos"] de pipeline/tiles.py.
    legend: [
      { color: "#2f7d4f", label: "< 5 min" },
      { color: "#e0a24a", label: "5–15 min" },
      { color: "#e07a4a", label: "15–30 min" },
      { color: "#e0564a", label: "> 30 min" },
    ],
    tiles: "/tiles/{site}/shelter-minutes/{z}/{x}/{y}.png",
    kind: "raster",
    categorical: true,
    defaultVisible: false,
  },
  {
    id: "survival-shelter-strong-minutes",
    label: "Minutos al refugio fuerte",
    group: "supervivencia",
    unit: "min",
    script: "shelter.py",
    source: {
      provenance: "MODELED",
      mission: "MRO",
      instrument: "HiRISE DTM",
      resolution: "10 m/px",
      source: "Calculado por el pipeline desde el DTM HiRISE (USGS) y la capa de refugios",
      assumptions: [
        "Caminata de Tobler (1993) escalada a 0,8 m/s en plano",
        "Más de 30° no se pisa",
        "Refugio fuerte = cielo visible ≤ 75 %",
        "Provisorio hasta que exista el costo del planificador",
      ],
    },
    // Los mismos cortes que RAMPAS["minutos"] de pipeline/tiles.py.
    legend: [
      { color: "#2f7d4f", label: "< 5 min" },
      { color: "#e0a24a", label: "5–15 min" },
      { color: "#e07a4a", label: "15–30 min" },
      { color: "#e0564a", label: "> 30 min" },
    ],
    tiles: "/tiles/{site}/shelter-strong-minutes/{z}/{x}/{y}.png",
    kind: "raster",
    categorical: true,
    defaultVisible: false,
  },
  {
    id: "survival-skyview",
    label: "Cielo visible",
    group: "supervivencia",
    unit: "fracción",
    script: "shelter.py",
    source: {
      provenance: "DERIVED",
      mission: "MRO",
      instrument: "HiRISE DTM",
      resolution: "2 m/px",
      source: "Sky-view factor (Zakšek et al. 2011) calculado desde el DTM HiRISE (USGS)",
      assumptions: [
        "Solo el terreno a menos de 500 m",
        "Sin dato a menos de 500 m del borde del DTM",
      ],
    },
    // Los mismos cortes que RAMPAS["cielo"] de pipeline/tiles.py.
    legend: [
      { color: "#b07cf0", label: "≤ 75 % (refugio fuerte)" },
      { color: "#56c8e8", label: "75–85 % (refugio)" },
      { color: "#8a9a8c", label: "85–92 %" },
      { color: "#786c60", label: "92–97 %" },
      { color: "transparent", label: "> 97 % cielo abierto" },
    ],
    tiles: "/tiles/{site}/skyview/{z}/{x}/{y}.png",
    kind: "raster",
    categorical: true,
    defaultVisible: false,
  },
  {
    id: "survival-shelter",
    label: "Refugios",
    group: "supervivencia",
    unit: null,
    script: "shelter.py",
    source: {
      provenance: "DERIVED",
      mission: "MRO",
      instrument: "HiRISE DTM",
      resolution: "2 m/px",
      source: "Calculado por el pipeline desde el DTM HiRISE (USGS)",
      assumptions: [
        "Refugio = cielo visible ≤ 85 %; fuerte = ≤ 75 %",
        "Pendiente ≤ 30° y al menos ~10 m² (dos o tres personas)",
        "Reparo geométrico, no una dosis calculada",
      ],
    },
    // Los mismos valores que RAMPAS["refugio"] de pipeline/tiles.py.
    legend: [
      { color: "#b07cf0", label: "refugio fuerte (cielo ≤ 75 %)" },
      { color: "#56c8e8", label: "refugio (cielo ≤ 85 %)" },
    ],
    tiles: "/tiles/{site}/shelter/{z}/{x}/{y}.png",
    kind: "raster",
    categorical: true,
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
      provenance: "MODELED",
      mission: "MRO",
      instrument: "HiRISE DTM + SPICE",
      resolution: "1 m/px",
      source: "Geometría solar (SPICE) sobre el DTM HiRISE",
      assumptions: ["Solo geometría: no considera polvo ni atmósfera"],
    },
    legend: [
      { color: "#161412", label: "en sombra" },
      { color: "#e0a24a", label: "al sol" },
    ],
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
