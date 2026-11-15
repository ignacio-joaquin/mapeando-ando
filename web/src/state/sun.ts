/**
 * Estado del deslizador de tiempo del sol. El sol que se muestra es el que
 * contiene la hora de salida del planificador (state/plan.ts) o, si no se
 * precomputó, otro de la misma estación llevado a esa fecha (map/sun.ts, pickSol).
 */
import { create } from "zustand";
import type { IlluminationCatalog, SolTiles } from "../api/schemas";
import type { SolReuse } from "../map/sun";

type Load =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string };

interface SunState {
  /** catalog.json del sitio. null = el pipeline no lo generó (o sin backend). */
  readonly catalog: IlluminationCatalog | null;
  /**
   * tiles.json del sol de la hora de salida, con los instantes ya en esa fecha.
   * null = no hay pila para ese sol ni para uno de la misma estación.
   */
  readonly sol: SolTiles | null;
  /** Si `sol` es de otro sol de la misma estación, de cuál y cuánto se aparta. */
  readonly reuse: SolReuse | null;
  readonly load: Load;
  /** Posición del deslizador (ms UTC). null = todavía no hay sol cargado. */
  readonly time: number | null;
  readonly playing: boolean;
  setCatalog: (c: IlluminationCatalog | null) => void;
  setSol: (s: SolTiles | null, reuse?: SolReuse | null) => void;
  setLoad: (l: Load) => void;
  setTime: (t: number | null) => void;
  setPlaying: (p: boolean) => void;
}

export const useSun = create<SunState>((set) => ({
  catalog: null,
  sol: null,
  reuse: null,
  load: { kind: "idle" },
  time: null,
  playing: false,
  setCatalog: (catalog) => set({ catalog }),
  setSol: (sol, reuse = null) => set({ sol, reuse: sol ? reuse : null }),
  setLoad: (load) => set({ load }),
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),
}));
