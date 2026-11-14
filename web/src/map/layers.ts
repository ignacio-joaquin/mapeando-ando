/**
 * Catálogo de capas. Los ids son CONTRATO: los usa la API, el pipeline
 * (nombre de la salida en /data/output/<sitio>/) y el frontend. Renombrar uno
 * es breaking change y se hace en un PR que toca todas las puntas.
 */

export type LayerGroup = "relieve" | "supervivencia";

export interface LegendStop {
  readonly color: string;
  readonly label: string;
}

export interface LayerSpec {
  readonly id: string;
  readonly label: string;
  readonly group: LayerGroup;
  /** Unidad del valor que representa, para la leyenda y el inspector. */
  readonly unit: string | null;
  /** Procedencia: va en el badge. Sin esto la capa no se muestra. */
  readonly source: { readonly mission: string; readonly instrument: string };
  readonly resolution: string;
  readonly legend: readonly LegendStop[];
  /** Plantilla de tiles, relativa. `{site}` se reemplaza por el id del sitio. */
  readonly tiles: string;
  readonly kind: "raster" | "vector";
  readonly defaultVisible: boolean;
}

export const LAYERS: readonly LayerSpec[] = [
  {
    id: "base-ortho",
    label: "Ortoimagen",
    group: "relieve",
    unit: null,
    source: { mission: "MRO", instrument: "HiRISE" },
    resolution: "25 cm/px",
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
    source: { mission: "MRO", instrument: "HiRISE DTM" },
    resolution: "1 m/px",
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
    source: { mission: "MRO", instrument: "HiRISE DTM" },
    resolution: "1 m/px",
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
    source: { mission: "MRO", instrument: "HiRISE DTM" },
    resolution: "1 m/px",
    legend: [
      { color: "#2f7d4f", label: "0–10° transitable" },
      { color: "#e0a24a", label: "10–20° con cuidado" },
      { color: "#e07a4a", label: "20–30° límite del rover" },
      { color: "#e0564a", label: "> 30° no transitable" },
    ],
    tiles: "/tiles/{site}/slope/{z}/{x}/{y}.png",
    kind: "raster",
    defaultVisible: false,
  },
  {
    id: "survival-hazard",
    label: "Peligro",
    group: "supervivencia",
    unit: "índice 0–1",
    source: { mission: "MRO", instrument: "HiRISE DTM + ortho" },
    resolution: "1 m/px",
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
    source: { mission: "MRO", instrument: "HiRISE DTM" },
    resolution: "1 m/px",
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
    source: { mission: "MSL", instrument: "RAD" },
    resolution: "derivada, 200 m/px",
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
    source: { mission: "MRO", instrument: "HiRISE DTM + SPICE" },
    resolution: "1 m/px",
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
