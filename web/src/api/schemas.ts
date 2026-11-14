/**
 * Única frontera entre el frontend y la API.
 *
 * Si el backend cambia una forma, rompe acá con un mensaje claro y en un solo
 * lugar, no en cinco componentes. Toda respuesta se valida antes de usarse.
 * Contrato: api/main.py + el manifest que escribe pipeline/download.py.
 */
import { z } from "zod";

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

export type LatLonDto = z.infer<typeof LatLonSchema>;
export type Bbox = z.infer<typeof BboxSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type SiteSummary = z.infer<typeof SiteSummarySchema>;
export type Sites = z.infer<typeof SitesSchema>;
export type SiteDetail = z.infer<typeof SiteDetailSchema>;
export type ManifestFile = z.infer<typeof ManifestFileSchema>;
