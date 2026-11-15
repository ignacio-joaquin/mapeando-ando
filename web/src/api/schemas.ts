/**
 * Única frontera entre el frontend y la API.
 *
 * Si el backend cambia una forma, rompe acá con un mensaje claro y en un solo
 * lugar, no en cinco componentes. Toda respuesta se valida antes de usarse.
 * Contrato: api/main.py + el manifest que escribe pipeline/download.py.
 */
import { z } from "zod";
import type { DataValue } from "../domain/provenance";

export const LatLonSchema = z.object({ lat: z.number(), lon: z.number() });

export const BboxSchema = z.object({
  lat_min: z.number(),
  lat_max: z.number(),
  lon_min: z.number(),
  lon_max: z.number(),
});

/** Estado de un archivo en el manifest. `optional_missing` NO es un fallo. */
export const FileStatusSchema = z.enum(["ok", "error", "optional_missing"]);

export const RasterInfoSchema = z
  .object({
    size: z.array(z.number()).optional(),
    pixel_m: z.number().optional(),
    crs: z.string().optional(),
  })
  .loose();

export const ManifestFileSchema = z.object({
  key: z.string(),
  kind: z.string().nullable(),
  desc: z.string().nullable(),
  mission: z.string().nullable(),
  status: FileStatusSchema,
  url: z.string().optional(),
  path: z.string().optional(),
  bytes: z.number().optional(),
  error: z.string().optional(),
  raster: RasterInfoSchema.optional(),
});

export const HealthSchema = z.object({
  ok: z.boolean(),
  commit: z.string().nullable(),
  data_ready: z.boolean(),
  manifest_generated_at: z.string().nullable(),
});

export const SiteSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  rover: z.string(),
  center: LatLonSchema,
  bbox: BboxSchema,
  files_ok: z.number(),
  files_total: z.number(),
});

export const SitesSchema = z.object({
  sites: z.array(SiteSummarySchema),
  note: z.string().optional(),
});

export const SiteDetailSchema = z.object({
  name: z.string(),
  rover: z.string(),
  center: LatLonSchema,
  bbox: BboxSchema,
  notes: z.string().nullable(),
  files: z.array(ManifestFileSchema),
});

/**
 * Formato común de todo número que devuelve la API (point query, /api/route,
 * veredicto, fichas). Contrato documentado en docs/context.md §4.
 * Lo consume <Measure>; ver src/domain/provenance.ts.
 */
export const ProvenanceSchema = z.enum(["OBSERVED", "DERIVED", "MODELED", "ASSUMED"]);

export const MeasuredValueSchema = z.object({
  /** null = el dato falta (todavía no se bajó o no existe). Nunca se rellena. */
  value: z.number().nullable(),
  unit: z.string().nullable(),
  provenance: ProvenanceSchema,
  mission: z.string().nullable(),
  instrument: z.string().nullable(),
  resolution: z.string().optional(),
  source: z.string().optional(),
  assumptions: z.array(z.string()).readonly().optional(),
});

/**
 * /api/route — PROPUESTA de contrato (ticket del planificador). El modelo de
 * costo es decisión abierta del equipo (docs/context.md §5); esto fija solo
 * qué entra y qué sale. Documentado en docs/context.md §4.
 *
 * Request (POST, JSON):
 *   { site, depart_utc, waypoints: [{ lat, lon, task, dwell_min }], cargo_kg? }
 *   waypoints[0] = salida, el último = llegada, el resto = estaciones en orden.
 *   cargo_kg = equipo encima además del traje (kg, 0 si falta); entra a Pandolf.
 */
export interface RouteRequest {
  readonly site: string;
  readonly depart_utc: string;
  readonly waypoints: readonly {
    readonly lat: number;
    readonly lon: number;
    readonly task: string | null;
    readonly dwell_min: number;
  }[];
  readonly cargo_kg?: number;
}

/**
 * Clase de terreno de un tramo, para colorear la línea. `unknown` = no se pudo
 * evaluar (ej. falta el DTM): se dibuja distinto y lo dice, no se asume "ok".
 */
export const LegClassSchema = z.enum(["ok", "caution", "limit", "blocked", "unknown"]);

/**
 * Indicaciones por landmarks de un tramo (`legs[].directions[]`), PROPUESTA
 * del ticket de navegación por landmarks. Documentado en docs/context.md §4.
 *
 * - Una indicación por trecho (el tramo se parte donde el rumbo gira más de
 *   30°), en orden. Las calcula api/directions.py.
 * - `toward` / `keep_left` / `keep_right` / `away` / `turn` nombran un landmark
 *   que se ve desde el trecho: `landmark` es obligatorio. `turn` = el trecho
 *   empieza con un giro.
 * - `fallback_sun` / `fallback_bearing` = no hay nada visible: `landmark` va
 *   en null. Nunca se inventa un landmark para no caer en el respaldo.
 */
export const DirectionKindSchema = z.enum([
  "toward",
  "keep_left",
  "keep_right",
  "away",
  "turn",
  "fallback_sun",
  "fallback_bearing",
]);

/** De dónde sale el landmark: catálogo IAU, cráteres de Robbins o pico extraído del DEM. */
export const LandmarkCatalogSchema = z.enum(["IAU", "Robbins", "DEM"]);

export const LandmarkSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: LandmarkCatalogSchema,
  lat: z.number(),
  lon: z.number(),
  /** El punto que se mira, si no es el centro (ej. el borde de un cráter visto desde adentro). */
  target: LatLonSchema.optional(),
});

const FALLBACK_KINDS: readonly string[] = ["fallback_sun", "fallback_bearing"];

export const DirectionSchema = z
  .object({
    kind: DirectionKindSchema,
    /** La indicación lista para leer, con la distancia del tramo. */
    text: z.string(),
    landmark: LandmarkSchema.nullable(),
    distance: MeasuredValueSchema,
    /** Ángulo del landmark respecto de la marcha (0 = al frente, + = derecha). null en los respaldos. */
    relative_bearing_deg: z.number().nullable(),
    /** Fracción 0–1 del tramo desde la que se ve el landmark. `value: null` en los respaldos. */
    visible_fraction: MeasuredValueSchema,
  })
  .refine((d) => FALLBACK_KINDS.includes(d.kind) === (d.landmark === null), {
    message: "Una indicación con landmark necesita `landmark`; un respaldo (fallback_*) no lo lleva.",
    path: ["landmark"],
  });

export const RouteLegSchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
  /** [lon, lat] como GeoJSON. */
  coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  class: LegClassSchema,
  distance: MeasuredValueSchema,
  duration: MeasuredValueSchema,
  bearing: MeasuredValueSchema,
  max_slope: MeasuredValueSchema,
  /** % de la ruta en sombra a la hora de paso. Solo si hay pila de sombras de ese sol. */
  shadow_fraction: MeasuredValueSchema.optional(),
  /** Indicaciones por landmarks. Opcional: el server todavía no las calcula. */
  directions: z.array(DirectionSchema).optional(),
});

export const RouteStopSchema = z.object({
  index: z.number().int(),
  lat: z.number(),
  lon: z.number(),
  task: z.string().nullable(),
  /** null en la salida (no hay llegada) y en la llegada final (no hay salida). */
  arrive_utc: z.string().nullable(),
  depart_utc: z.string().nullable(),
  o2_remaining: MeasuredValueSchema,
  battery_remaining: MeasuredValueSchema,
  dose_accumulated: MeasuredValueSchema,
  /** Reserva: cuánto sobra del recurso limitante después de llegar al destino. */
  margin: MeasuredValueSchema,
});

/** Ids de los límites duros (api/safety.py, docs/seguridad.md). `terrain` = pendiente. */
export const LimitingFactorSchema = z.enum([
  "o2",
  "battery",
  "dose",
  "daylight",
  "terrain",
  "contact",
  "calories",
]);

/**
 * Un límite duro evaluado en el peor punto de la ruta. `margin` = 1 − usado/límite
 * (< 0 = roto, recortado a −1). `limit` viaja ASSUMED cuando el número entero lo eligió
 * el equipo (pendiente, contacto, dosis, calorías); O2, batería y luz salen MODELED
 * (capacidad del traje o atardecer) con la parte del equipo en `assumptions`.
 * `undefined` = el equipo todavía no fijó el valor.
 */
export const SafetyLimitSchema = z.object({
  id: LimitingFactorSchema,
  label: z.string(),
  status: z.enum(["ok", "broken", "not_evaluated", "undefined"]),
  complete: z.boolean(),
  note: z.string().nullable(),
  margin: z.number().nullable(),
  used: MeasuredValueSchema,
  limit: MeasuredValueSchema,
});

/** "Robusta en N de M escenarios": cuenta escenarios, no es una probabilidad. */
export const RobustnessSchema = z.object({
  passed: z.number().int(),
  evaluated: z.number().int(),
  scenarios: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: z.enum(["pass", "fail", "not_evaluated"]),
      limiting_factor: LimitingFactorSchema.nullable(),
      score: z.number().nullable(),
      note: z.string().nullable(),
    }),
  ),
});

export const VerdictSchema = z.object({
  status: z.enum(["GO", "CAUTION", "NO_GO"]),
  limiting_factor: LimitingFactorSchema.nullable(),
  /** Una frase, en español, para leer con el casco puesto. */
  summary: z.string(),
  margin: MeasuredValueSchema,
  /** Puntaje 0–100 = 100 · el margen más chico. Opcional: el planificador de ejemplo no lo calcula. */
  score: MeasuredValueSchema.optional(),
  limits: z.array(SafetyLimitSchema).optional(),
  robustness: RobustnessSchema.optional(),
});

/** Desglose del costo del A*: cuántos minutos-equivalentes aporta cada factor. */
export const RouteCostSchema = z.object({
  formula: z.string(),
  unit: z.string(),
  base_minutes: z.number().nullable(),
  total_minutes: z.number().nullable(),
  factors: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      weight: z.number(),
      active: z.boolean(),
      minutes: z.number().nullable(),
      note: z.string().nullable(),
    }),
  ),
});

/**
 * Perfil de elevación de la ruta. Es la serie que el backend ya muestrea del
 * DTM al densificar cada tramo (api/main.py, `_profile`): distancia acumulada,
 * elevación y pendiente por muestra, más dónde arranca cada tramo.
 *
 * Opcional a propósito: mientras el planificador no lo mande, el perfil se
 * dibuja vacío y dice qué falta, en vez de inventar una curva.
 */
export const ProfileSchema = z.object({
  distance_m: z.array(z.number()),
  elevation_m: z.array(z.number()),
  slope_deg: z.array(z.number()),
  leg_starts: z.array(z.number()),
});

export const TerrainStatusSchema = z.enum(["complete", "partial", "missing"]);
export const LightStatusSchema = z.enum(["complete", "partial", "missing"]);

export const DataQualitySchema = z.object({
  terrain_status: TerrainStatusSchema.optional(),
  terrain_evaluated: z.boolean(),
  terrain_source: z.enum(["processed", "missing"]).optional(),
  light_status: LightStatusSchema.optional(),
  light_evaluated: z.boolean(),
  light_source: z.enum(["exact", "reused", "missing"]).optional(),
  contact_evaluated: z.boolean().optional(),
});

export const RouteResponseSchema = z.object({
  site: z.string(),
  depart_utc: z.string(),
  legs: z.array(RouteLegSchema),
  stops: z.array(RouteStopSchema),
  verdict: VerdictSchema,
  cost: RouteCostSchema.optional(),
  profile: ProfileSchema.optional(),
  data_quality: DataQualitySchema.optional(),
});

/** Un elemento u óxido medido por el rover, ej. "SiO₂" en % en peso. */
export const RoverElementSchema = MeasuredValueSchema.extend({
  element: z.string(),
  note: z.string().optional(),
});

/** Composición elemental medida cerca del waypoint de una foto (ficha de estación). */
export const RoverCompositionSchema = z.object({
  summary: z.string().optional(),
  elements: z.array(RoverElementSchema),
  note: z.string().optional(),
});

/**
 * GET /api/sites/{site}/photos?lat=&lon= — PROPUESTA de contrato (MAP-33).
 * Fotos reales del rover más cercanas a un punto. El cruce (punto → waypoint
 * MMGIS → sol → fotos) es del backend; el frontend solo dibuja.
 * Documentado en docs/context.md §4.
 */
export const RoverPhotoSchema = z.object({
  /** Imagen para la ficha (tamaño chico o mediano). */
  url: z.string(),
  /** Imagen completa, para abrir aparte. */
  url_full: z.string().optional(),
  mission: z.string(),
  rover: z.string(),
  camera: z.string(),
  sol: z.number().int(),
  taken_utc: z.string().nullable().optional(),
  /** Crédito obligatorio, ej. "NASA/JPL-Caltech/ASU". */
  credit: z.string(),
  /** Dónde estaba el rover (waypoint MMGIS del sol de la foto). */
  lat: z.number(),
  lon: z.number(),
  /** Distancia entre el punto pedido y el waypoint de la foto. */
  distance: MeasuredValueSchema,
  /** Composición elemental medida cerca de ese waypoint, si la API la reporta. */
  composition: RoverCompositionSchema.optional(),
});

export const RoverPhotosSchema = z.object({
  photos: z.array(RoverPhotoSchema),
  note: z.string().optional(),
});

export type LatLonDto = z.infer<typeof LatLonSchema>;
export type Bbox = z.infer<typeof BboxSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type SiteSummary = z.infer<typeof SiteSummarySchema>;
/**
 * GET /api/sites/{site_id}/point?lat=&lon=
 *
 * Qué hay en un punto. Degrada en vez de romper: sin DTM descargado, fuera del
 * raster o sobre nodata devuelve 200 con `value: null` y una `note` que explica
 * por qué. `layers` se llena cuando el pipeline precompute las capas de
 * supervivencia; hoy viene vacío.
 */
export const PointSchema = z.object({
  site: z.string(),
  lat: z.number(),
  lon: z.number(),
  elevation: MeasuredValueSchema,
  slope: MeasuredValueSchema,
  layers: z.array(MeasuredValueSchema.extend({ id: z.string(), label: z.string() })),
  note: z.string().optional(),
});

/**
 * GET /tiles/{site}/terrain.json: el índice que escribe pipeline/precompute.py.
 *
 * Dice qué capas de relieve están listas y, para las que van en tiles, entre qué
 * zooms y dentro de qué límites (lon/lat de Marte) hay PNG. Sin este archivo
 * (404) las capas de relieve quedan en "esperando el pipeline". Las claves de
 * `layers` son los ids de capa de src/map/layers.ts.
 */
export const TileSetSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    template: z.string(),
    minzoom: z.number().int(),
    maxzoom: z.number().int(),
    /** [oeste, sur, este, norte] */
    bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    /** Solo tiles vectoriales: capa dentro del MVT (el `source-layer` del mapa). */
    layer: z.string().optional(),
  }),
  z.object({ status: z.literal("error"), error: z.string() }),
]);

/**
 * Cómo viene la altura escondida en el RGB de los tiles de relieve 3D
 * (`relief-dem`): h = R·red + G·green + B·blue − base. Lo decide
 * pipeline/tiles.py (DEM_ENCODING) y se le pasa tal cual a MapLibre.
 */
export const DemEncodingSchema = z.object({
  red_factor: z.number(),
  green_factor: z.number(),
  blue_factor: z.number(),
  base_shift: z.number(),
});

export const TerrainLayerSchema = z.object({
  file: z.string(),
  status: z.enum(["ok", "error"]),
  /** Tamaño real del píxel sobre el suelo, cuando el pipeline lo mide. */
  resolution: z.string().optional(),
  /** Misión e instrumento que de verdad usó la corrida (ej. peligro con o sin THEMIS). */
  mission: z.string().nullable().optional(),
  instrument: z.string().nullable().optional(),
  error: z.string().optional(),
  tiles: TileSetSchema.optional(),
  /** Solo `relief-dem`: altura (m) que corresponde al 0 de los tiles, el punto más bajo del DTM. */
  datum_m: z.number().optional(),
  /** Solo `relief-dem`: codificación de la altura en los PNG. */
  encoding: DemEncodingSchema.optional(),
  assumptions: z.array(z.string()).optional(),
});

export const TerrainIndexSchema = z.object({
  site: z.string(),
  generated_at: z.string(),
  mode: z.enum(["completo", "prueba"]),
  layers: z.record(z.string(), TerrainLayerSchema),
  warnings: z.array(z.string()),
});

/**
 * GET /tiles/{site}/places.json: índice de lugares que escribe pipeline/places.py.
 * Alimenta el buscador de destinos y los lugares sugeridos del planificador.
 * Sin este archivo (404) el buscador dice que espera al pipeline.
 * Documentado en docs/context.md §4.
 */
export const PlaceKindSchema = z.enum(["iau", "sample", "target", "heli", "rover", "crater", "landmark", "depression", "orbital"]);

export const PlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: PlaceKindSchema,
  /** Una línea para la lista: tipo de rasgo, diámetro, sol del rover. */
  detail: z.string(),
  lat: z.number(),
  lon: z.number(),
  suggested: z.boolean(),
  provenance: ProvenanceSchema,
  mission: z.string().nullable(),
  instrument: z.string().nullable(),
  resolution: z.string().optional(),
  source: z.string().optional(),
  assumptions: z.array(z.string()).readonly().optional(),
  link: z.string().nullable().optional(),
});

export const PlaceSourceSchema = z.object({
  status: z.enum(["ok", "missing", "error"]),
  desc: z.string(),
  count: z.number().int().optional(),
  error: z.string().optional(),
  /** Una fuente ok pero incompleta lo dice acá (ej. "falta PIXL", "N observaciones sin posición"). */
  note: z.string().optional(),
});

export const PlacesIndexSchema = z.object({
  site: z.string(),
  generated_at: z.string(),
  sources: z.record(z.string(), PlaceSourceSchema),
  places: z.array(PlaceSchema),
});

/**
 * GET /tiles/{site}/coverage.geojson: dónde hay DTM de 1 m de verdad
 * (pipeline/precompute.py, capa `coverage` de terrain.json). Polígonos en
 * lon/lat de Marte; el planificador rechaza destinos que caen afuera.
 */
const RingSchema = z.array(z.tuple([z.number(), z.number()]).rest(z.number())).min(4);
export const CoverageSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(
    z.object({
      geometry: z.discriminatedUnion("type", [
        z.object({ type: z.literal("Polygon"), coordinates: z.array(RingSchema).min(1) }),
        z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(RingSchema).min(1)) }),
      ]),
    }),
  ),
});

/**
 * Sol y sombra por hora para el deslizador de tiempo. Los escribe
 * pipeline/shadow_tiles.py y nginx los sirve en /tiles/<sitio>/illumination/.
 * Las plantillas son relativas a /tiles/<sitio>/, como en terrain.json.
 */
const SunCrossingSchema = z.object({ utc: z.string(), ltst: z.string() }).nullable().optional();

export const IlluminationCatalogSchema = z.object({
  generated_at: z.string(),
  sols: z.array(
    z.object({
      tag: z.string(),
      start_utc: z.string(),
      end_utc: z.string(),
      ls_deg: z.number().nullable().optional(),
      flat_sunrise: SunCrossingSchema,
      flat_sunset: SunCrossingSchema,
      step_min: z.number(),
      /** Ruta del tiles.json del sol, relativa a illumination/. null = sin teselar. */
      tiles: z.string().nullable(),
    }),
  ),
});

export const ShadowBandSchema = z.object({
  band: z.number().int(),
  ltst: z.string(),
  utc: z.string(),
  sun_az_deg: z.number(),
  sun_el_deg: z.number(),
  lit_fraction: z.number(),
  status: z.enum(["ok", "error"]),
  template: z.string().optional(),
  minzoom: z.number().int().optional(),
  maxzoom: z.number().int().optional(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  error: z.string().optional(),
});

export const SolTilesSchema = z.object({
  sol_tag: z.string(),
  generated_at: z.string(),
  step_min: z.number(),
  sol: z.object({
    start_utc: z.string(),
    end_utc: z.string(),
    ls_deg: z.number().nullable().optional(),
    flat_sunrise: SunCrossingSchema,
    flat_sunset: SunCrossingSchema,
  }),
  provenance: z.object({
    provenance: z.enum(["OBSERVED", "DERIVED", "MODELED"]),
    mission: z.string().nullable(),
    instrument: z.string().nullable(),
    resolution: z.string().nullable().optional(),
    source: z.string().optional(),
    assumptions: z.array(z.string()).readonly().optional(),
  }),
  warnings: z.array(z.string()).optional(),
  bands: z.array(ShadowBandSchema),
});

export type Sites = z.infer<typeof SitesSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type PlaceKind = z.infer<typeof PlaceKindSchema>;
export type PlacesIndex = z.infer<typeof PlacesIndexSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type TileSet = z.infer<typeof TileSetSchema>;
export type TerrainLayer = z.infer<typeof TerrainLayerSchema>;
export type TerrainIndex = z.infer<typeof TerrainIndexSchema>;
export type PointInfo = z.infer<typeof PointSchema>;
export type SiteDetail = z.infer<typeof SiteDetailSchema>;
export type ManifestFile = z.infer<typeof ManifestFileSchema>;
export type MeasuredValue = z.infer<typeof MeasuredValueSchema>;
export type LegClass = z.infer<typeof LegClassSchema>;
export type RouteLeg = z.infer<typeof RouteLegSchema>;
export type RouteStop = z.infer<typeof RouteStopSchema>;
export type LimitingFactor = z.infer<typeof LimitingFactorSchema>;
export type DirectionKind = z.infer<typeof DirectionKindSchema>;
export type LandmarkCatalog = z.infer<typeof LandmarkCatalogSchema>;
export type Landmark = z.infer<typeof LandmarkSchema>;
export type Direction = z.infer<typeof DirectionSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type SafetyLimit = z.infer<typeof SafetyLimitSchema>;
export type Robustness = z.infer<typeof RobustnessSchema>;
export type DataQuality = z.infer<typeof DataQualitySchema>;
export type RouteCost = z.infer<typeof RouteCostSchema>;
export type RouteResponse = z.infer<typeof RouteResponseSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type RoverElement = z.infer<typeof RoverElementSchema>;
export type RoverComposition = z.infer<typeof RoverCompositionSchema>;
export type RoverPhoto = z.infer<typeof RoverPhotoSchema>;
export type RoverPhotos = z.infer<typeof RoverPhotosSchema>;
export type IlluminationCatalog = z.infer<typeof IlluminationCatalogSchema>;
export type CatalogSol = IlluminationCatalog["sols"][number];
export type ShadowBand = z.infer<typeof ShadowBandSchema>;
export type SolTiles = z.infer<typeof SolTilesSchema>;

// Chequeo en tiempo de compilación: lo que valida la API se puede pasar tal
// cual a <Measure>, y los dos tienen los mismos campos. Si alguno cambia, esto
// deja de compilar.
type Assert<T extends true> = T;
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
export type _MeasuredValueFitsDataValue = Assert<MeasuredValue extends DataValue ? true : false>;
export type _MeasuredValueSameKeys = Assert<SameKeys<MeasuredValue, DataValue>>;
