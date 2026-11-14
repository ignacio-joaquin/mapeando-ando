/**
 * Fixtures para trabajar sin backend.
 *
 * REGLA (core value): nunca se muestran como medición. Cuando la app corre con
 * fixtures, la UI muestra un cartel visible y cada valor queda marcado como
 * ejemplo. Los números de abajo son los del repo (sites/*.json), no inventados.
 */
import type { Health, SiteDetail, Sites } from "./schemas";

export const fixtureHealth: Health = {
  ok: true,
  commit: null,
  data_ready: false,
  manifest_generated_at: null,
};

export const fixtureSites: Sites = {
  sites: [
    {
      id: "jezero",
      name: "Jezero",
      rover: "Perseverance (Mars 2020)",
      center: { lat: 18.488, lon: 77.403 },
      bbox: { lat_min: 18.3068, lat_max: 18.6693, lon_min: 77.2229, lon_max: 77.584 },
      files_ok: 0,
      files_total: 5,
    },
    {
      id: "gale",
      name: "Gale",
      rover: "Curiosity (MSL)",
      center: { lat: -4.5895, lon: 137.4417 },
      bbox: { lat_min: -4.9, lat_max: -4.2, lon_min: 137.1, lon_max: 137.8 },
      files_ok: 0,
      files_total: 5,
    },
  ],
  note: "Fixtures locales: el backend no está conectado.",
};

export const fixtureSiteDetail: Record<string, SiteDetail> = {
  jezero: {
    name: "Jezero",
    rover: "Perseverance (Mars 2020)",
    center: { lat: 18.488, lon: 77.403 },
    bbox: { lat_min: 18.3068, lat_max: 18.6693, lon_min: 77.2229, lon_max: 77.584 },
    notes:
      "DTM HiRISE 1 m del Terrain Relative Navigation de Mars 2020 (~21 x 21 km).",
    files: [
      { key: "dtm", kind: "raster", desc: "HiRISE DTM mosaic 1 m (MRO HiRISE, USGS)", mission: "MRO HiRISE", status: "error" },
      { key: "ortho", kind: "raster", desc: "HiRISE orthomosaic 25 cm (MRO HiRISE, USGS)", mission: "MRO HiRISE", status: "error" },
      { key: "dem200_crop", kind: "raster", desc: "MOLA + HRSC blended DEM 200 m", mission: "MGS MOLA + MEX HRSC", status: "error" },
    ],
  },
};
