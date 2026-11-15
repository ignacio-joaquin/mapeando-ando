/**
 * Landmarks de las indicaciones de ruta: de qué catálogo sale cada uno y cómo
 * se dibuja cada tipo de indicación.
 *
 * La procedencia es la misma que le da pipeline/places.py a esos lugares en
 * places.json (DERIVED: las posiciones de los catálogos salen de mapear
 * imágenes), para que un cráter no tenga dos badges distintos en la app. La
 * API manda solo el catálogo y acá se arma el badge.
 */
import type { DirectionKind, LandmarkCatalog } from "../api/schemas";
import type { SourceInfo } from "./provenance";

export const LANDMARK_SOURCE: Record<LandmarkCatalog, SourceInfo> = {
  IAU: {
    provenance: "DERIVED",
    mission: null,
    instrument: "Nomenclátor IAU",
    source: "Gazetteer of Planetary Nomenclature (IAU/USGS), centro del rasgo",
  },
  Robbins: {
    provenance: "DERIVED",
    mission: "Mars Odyssey",
    instrument: "THEMIS",
    resolution: "catálogo completo para cráteres de 1 km o más",
    source: "Robbins & Hynek 2012, mosaico diurno THEMIS IR (API OGC de USGS)",
  },
  DEM: {
    provenance: "DERIVED",
    mission: "MRO",
    instrument: "HiRISE (DTM)",
    source: "Máximos locales del DTM del sitio (pipeline/places.py, kind landmark)",
    assumptions: ["Sin nombre oficial: el número solo lo ordena por relieve"],
  },
};

export const LANDMARK_CATALOG_LABEL: Record<LandmarkCatalog, string> = {
  IAU: "nombre IAU",
  Robbins: "cráter Robbins",
  DEM: "cerro del DTM, sin nombre",
};

export function isFallback(kind: DirectionKind): boolean {
  return kind === "fallback_sun" || kind === "fallback_bearing";
}

/**
 * Símbolo de cada tipo. Es decorativo (va con aria-hidden): el sentido lo
 * lleva siempre el texto de la indicación, nunca el símbolo ni el color.
 */
export const DIRECTION_ICON: Record<DirectionKind, string> = {
  toward: "↑",
  keep_left: "←",
  keep_right: "→",
  away: "↓",
  turn: "↱",
  fallback_sun: "☀",
  fallback_bearing: "∠",
};

/** Etiqueta corta del respaldo: dice con qué se guía cuando no hay landmark. */
export const FALLBACK_LABEL: Partial<Record<DirectionKind, string>> = {
  fallback_sun: "Respaldo por el Sol",
  fallback_bearing: "Respaldo por rumbo",
};
