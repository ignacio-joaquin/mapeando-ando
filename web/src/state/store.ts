/**
 * Estado del frontend. El mapa NO vive acá: la instancia de MapLibre es
 * imperativa y va en un ref. Acá va lo que la UI necesita compartir.
 */
import { create } from "zustand";
import { LAYERS } from "../map/layers";
import type { LatLon } from "../mars/geo";
import type { Coverage, PlacesIndex, TerrainIndex } from "../api/schemas";
import { siteFromUrl } from "./share";

export interface LayerState {
  readonly visible: boolean;
  readonly opacity: number;
  /** El tile existe en el server. false = esperando al pipeline. */
  readonly available: boolean;
}

interface AppState {
  readonly activeSiteId: string;
  readonly layers: Readonly<Record<string, LayerState>>;
  /** terrain.json del sitio activo (pipeline/precompute.py). null = todavía no hay. */
  readonly terrain: TerrainIndex | null;
  /** terrain.json existe pero no se pudo leer (contrato roto, error del server). */
  readonly terrainError: string | null;
  /** places.json del sitio activo (pipeline/places.py). null = todavía no hay. */
  readonly places: PlacesIndex | null;
  /** places.json existe pero no se pudo leer. */
  readonly placesError: string | null;
  /** Huella del DTM de 1 m (coverage.geojson). null = todavía no hay: no se puede verificar. */
  readonly coverage: Coverage | null;
  /** Posición del cursor sobre el mapa. */
  readonly cursor: LatLon | null;
  /** Punto fijado con un clic (inspector). */
  readonly picked: LatLon | null;
  /** Instante del planificador. Entrada del reloj y del deslizador. */
  readonly instant: Date;
  /** Vista actual del mapa (zoom y latitud del centro), para la barra de escala. */
  readonly view: { readonly zoom: number; readonly lat: number } | null;
  setActiveSite: (id: string) => void;
  toggleLayer: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
  setAvailable: (id: string, available: boolean) => void;
  /** Disponibilidad de todas las capas de una vez (al cambiar de sitio o de índice). */
  setAvailability: (available: Readonly<Record<string, boolean>>) => void;
  setTerrain: (terrain: TerrainIndex | null, error?: string | null) => void;
  setPlaces: (places: PlacesIndex | null, error?: string | null) => void;
  setCoverage: (coverage: Coverage | null) => void;
  setCursor: (p: LatLon | null) => void;
  setPicked: (p: LatLon | null) => void;
  setInstant: (d: Date) => void;
  setView: (v: { zoom: number; lat: number }) => void;
}

const initialLayers: Record<string, LayerState> = Object.fromEntries(
  LAYERS.map((l) => [l.id, { visible: l.defaultVisible, opacity: 1, available: false }]),
);

export const useStore = create<AppState>((set) => ({
  // Un enlace compartido elige el sitio; si no, Jezero.
  activeSiteId: siteFromUrl() ?? "jezero",
  layers: initialLayers,
  terrain: null,
  terrainError: null,
  places: null,
  placesError: null,
  coverage: null,
  cursor: null,
  picked: null,
  instant: new Date(),
  view: null,
  setActiveSite: (id) => set({ activeSiteId: id, picked: null }),
  toggleLayer: (id) =>
    set((s) => {
      const l = s.layers[id];
      if (!l) return s;
      return { layers: { ...s.layers, [id]: { ...l, visible: !l.visible } } };
    }),
  setOpacity: (id, opacity) =>
    set((s) => {
      const l = s.layers[id];
      if (!l) return s;
      return { layers: { ...s.layers, [id]: { ...l, opacity } } };
    }),
  setAvailable: (id, available) =>
    set((s) => {
      const l = s.layers[id];
      if (!l) return s;
      return { layers: { ...s.layers, [id]: { ...l, available } } };
    }),
  setAvailability: (available) =>
    set((s) => ({
      layers: Object.fromEntries(
        Object.entries(s.layers).map(([id, l]) => [id, { ...l, available: available[id] ?? false }]),
      ),
    })),
  setTerrain: (terrain, error = null) => set({ terrain, terrainError: error }),
  setPlaces: (places, error = null) => set({ places, placesError: error }),
  setCoverage: (coverage) => set({ coverage }),
  setCursor: (cursor) => set({ cursor }),
  setPicked: (picked) => set({ picked }),
  setInstant: (instant) => set({ instant }),
  setView: (view) => set({ view }),
}));
