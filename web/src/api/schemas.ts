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
export const ProvenanceSchema = z.enum(["OBSERVED", "DERIVED", "MODELED"]);

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
 *   { site, depart_utc, waypoints: [{ lat, lon, task, dwell_min }] }
 *   waypoints[0] = salida, el último = llegada, el resto = estaciones en orden.
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
}

/**
 * Clase de terreno de un tramo, para colorear la línea. `unknown` = no se pudo
 * evaluar (ej. falta el DTM): se dibuja distinto y lo dice, no se asume "ok".
 */
export const LegClassSchema = z.enum(["ok", "caution", "limit", "blocked", "unknown"]);

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

export const LimitingFactorSchema = z.enum(["o2", "battery", "dose", "daylight", "terrain"]);

export const VerdictSchema = z.object({
  status: z.enum(["GO", "NO_GO"]),
  limiting_factor: LimitingFactorSchema.nullable(),
  /** Una frase, en español, para leer con el casco puesto. */
  summary: z.string(),
  margin: MeasuredValueSchema,
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

export const RouteResponseSchema = z.object({
  site: z.string(),
  depart_utc: z.string(),
  legs: z.array(RouteLegSchema),
  stops: z.array(RouteStopSchema),
  verdict: VerdictSchema,
  profile: ProfileSchema.optional(),
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
  }),
  z.object({ status: z.literal("error"), error: z.string() }),
]);

export const TerrainLayerSchema = z.object({
  file: z.string(),
  status: z.enum(["ok", "error"]),
  /** Tamaño real del píxel sobre el suelo, cuando el pipeline lo mide. */
  resolution: z.string().optional(),
  error: z.string().optional(),
  tiles: TileSetSchema.optional(),
});

export const TerrainIndexSchema = z.object({
  site: z.string(),
  generated_at: z.string(),
  mode: z.enum(["completo", "prueba"]),
  layers: z.record(z.string(), TerrainLayerSchema),
  warnings: z.array(z.string()),
});

export type Sites = z.infer<typeof SitesSchema>;
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
export type Verdict = z.infer<typeof VerdictSchema>;
export type RouteResponse = z.infer<typeof RouteResponseSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type RoverPhoto = z.infer<typeof RoverPhotoSchema>;
export type RoverPhotos = z.infer<typeof RoverPhotosSchema>;

// Chequeo en tiempo de compilación: lo que valida la API se puede pasar tal
// cual a <Measure>, y los dos tienen los mismos campos. Si alguno cambia, esto
// deja de compilar.
type Assert<T extends true> = T;
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
export type _MeasuredValueFitsDataValue = Assert<MeasuredValue extends DataValue ? true : false>;
export type _MeasuredValueSameKeys = Assert<SameKeys<MeasuredValue, DataValue>>;
