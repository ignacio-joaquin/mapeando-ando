/**
 * Estado del deslizador de tiempo del sol. El sol que se muestra es el que
 * contiene la hora de salida del planificador (state/plan.ts).
 */
import { create } from "zustand";
import type { IlluminationCatalog, SolTiles } from "../api/schemas";

type Load =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string };

interface SunState {
  /** catalog.json del sitio. null = el pipeline no lo generó (o sin backend). */
  readonly catalog: IlluminationCatalog | null;
  /** tiles.json del sol de la hora de salida. null = no hay pila para ese sol. */
  readonly sol: SolTiles | null;
  readonly load: Load;
  /** Posición del deslizador (ms UTC). null = todavía no hay sol cargado. */
  readonly time: number | null;
  readonly playing: boolean;
  setCatalog: (c: IlluminationCatalog | null) => void;
  setSol: (s: SolTiles | null) => void;
  setLoad: (l: Load) => void;
  setTime: (t: number | null) => void;
  setPlaying: (p: boolean) => void;
}

export const useSun = create<SunState>((set) => ({
  catalog: null,
  sol: null,
  load: { kind: "idle" },
  time: null,
  playing: false,
  setCatalog: (catalog) => set({ catalog }),
  setSol: (sol) => set({ sol }),
  setLoad: (load) => set({ load }),
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),
}));
