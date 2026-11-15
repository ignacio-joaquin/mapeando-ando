/**
 * Landmarks de las indicaciones de ruta: de qué catálogo sale cada uno y cómo
 * se dibuja cada tipo de indicación.
 *
 * La posición del landmark es OBSERVED si viene de un catálogo (IAU, Robbins)
 * y DERIVED si es un pico que el pipeline extrajo del relieve. Así lo pide el
 * ticket; la API manda solo el catálogo y acá se arma el badge.
 */
import type { DirectionKind, LandmarkCatalog } from "../api/schemas";
import type { SourceInfo } from "./provenance";

export const LANDMARK_SOURCE: Record<LandmarkCatalog, SourceInfo> = {
  IAU: {
    provenance: "OBSERVED",
    mission: null,
    instrument: "IAU Gazetteer",
    source: "Gazetteer of Planetary Nomenclature (IAU / USGS), nombres oficiales",
  },
  Robbins: {
    provenance: "OBSERVED",
    mission: null,
    instrument: "Robbins & Hynek 2012",
    source: "Base de datos global de cráteres de Marte ≥ 1 km (Robbins & Hynek 2012)",
  },
  DEM: {
    provenance: "DERIVED",
    mission: null,
    instrument: "relieve (DTM / DEM)",
    source:
      "Pico o borde extraído por el pipeline del DTM HiRISE 1 m y del DEM MOLA-HRSC 200 m",
    assumptions: ["Elegido por su prominencia en el relieve: no tiene nombre oficial"],
  },
};

export const LANDMARK_CATALOG_LABEL: Record<LandmarkCatalog, string> = {
  IAU: "nombre IAU",
  Robbins: "cráter Robbins",
  DEM: "extraído del relieve",
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
  turn: "↱",
  fallback_sun: "☀",
  fallback_bearing: "∠",
};

/** Etiqueta corta del respaldo: dice con qué se guía cuando no hay landmark. */
export const FALLBACK_LABEL: Partial<Record<DirectionKind, string>> = {
  fallback_sun: "Respaldo por el Sol",
  fallback_bearing: "Respaldo por rumbo",
};
