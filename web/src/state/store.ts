/**
 * Estado del frontend. El mapa NO vive acá: la instancia de MapLibre es
 * imperativa y va en un ref. Acá va lo que la UI necesita compartir.
 */
import { create } from "zustand";
import { LAYERS } from "../map/layers";
import type { LatLon } from "../mars/geo";

export interface LayerState {
  readonly visible: boolean;
  readonly opacity: number;
  /** El tile existe en el server. false = esperando al pipeline. */
  readonly available: boolean;
}

interface AppState {
  readonly activeSiteId: string;
  readonly layers: Readonly<Record<string, LayerState>>;
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
  setCursor: (p: LatLon | null) => void;
  setPicked: (p: LatLon | null) => void;
  setInstant: (d: Date) => void;
  setView: (v: { zoom: number; lat: number }) => void;
}

const initialLayers: Record<string, LayerState> = Object.fromEntries(
  LAYERS.map((l) => [l.id, { visible: l.defaultVisible, opacity: 1, available: false }]),
);

export const useStore = create<AppState>((set) => ({
  activeSiteId: "jezero",
  layers: initialLayers,
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
  setCursor: (cursor) => set({ cursor }),
  setPicked: (picked) => set({ picked }),
  setInstant: (instant) => set({ instant }),
  setView: (view) => set({ view }),
}));
