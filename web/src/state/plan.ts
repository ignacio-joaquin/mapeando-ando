/**
 * Estado del planificador de travesía, estilo Google Maps: una salida, una
 * llegada y estaciones en el medio, en orden. Separado de store.ts para que el
 * planificador se pueda leer de punta a punta en un archivo.
 */
import { create } from "zustand";
import type { LatLon } from "../mars/geo";
import type { PlannedRoute } from "../api/client";
import { useStore } from "./store";

export interface Waypoint extends LatLon {
  readonly id: string;
  /** Qué se hace ahí. Texto libre; null en la salida si no se escribe nada. */
  readonly task: string;
  /** Minutos de permanencia. En la salida no cuenta: se sale a la hora elegida. */
  readonly dwellMin: number;
}

export type ClickMode = "add" | "inspect";

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string };

interface PlanState {
  readonly waypoints: readonly Waypoint[];
  readonly departAt: Date;
  readonly clickMode: ClickMode;
  readonly result: PlannedRoute | null;
  /** Huella (planKey) del pedido que generó `result`. */
  readonly resultKey: string | null;
  readonly status: Status;
  /** Estación abierta en el panel (índice en waypoints). */
  readonly openStop: number | null;
  addPoint: (p: LatLon) => void;
  movePoint: (id: string, p: LatLon) => void;
  updatePoint: (id: string, patch: Partial<Pick<Waypoint, "task" | "dwellMin">>) => void;
  removePoint: (id: string) => void;
  shiftPoint: (id: string, delta: -1 | 1) => void;
  reverse: () => void;
  clear: () => void;
  setDepartAt: (d: Date) => void;
  setClickMode: (m: ClickMode) => void;
  setResult: (r: PlannedRoute | null, key?: string | null) => void;
  setStatus: (s: Status) => void;
  setOpenStop: (i: number | null) => void;
}

let seq = 0;
const newId = () => `wp-${++seq}`;

/** Duración por defecto de una estación nueva, editable en el panel. */
const DEFAULT_DWELL_MIN = 15;

export const usePlan = create<PlanState>((set) => ({
  waypoints: [],
  departAt: new Date(),
  clickMode: "add",
  result: null,
  resultKey: null,
  status: { kind: "idle" },
  openStop: null,

  // 1er clic = salida, 2do = llegada, los siguientes = estaciones antes de la llegada.
  addPoint: (p) =>
    set((s) => {
      const wp: Waypoint = { id: newId(), lat: p.lat, lon: p.lon, task: "", dwellMin: 0 };
      if (s.waypoints.length < 2) return { waypoints: [...s.waypoints, wp] };
      const station = { ...wp, dwellMin: DEFAULT_DWELL_MIN };
      return {
        waypoints: [...s.waypoints.slice(0, -1), station, ...s.waypoints.slice(-1)],
      };
    }),
  movePoint: (id, p) =>
    set((s) => ({
      waypoints: s.waypoints.map((w) => (w.id === id ? { ...w, lat: p.lat, lon: p.lon } : w)),
    })),
  updatePoint: (id, patch) =>
    set((s) => ({ waypoints: s.waypoints.map((w) => (w.id === id ? { ...w, ...patch } : w)) })),
  removePoint: (id) =>
    set((s) => ({ waypoints: s.waypoints.filter((w) => w.id !== id), openStop: null })),
  shiftPoint: (id, delta) =>
    set((s) => {
      const i = s.waypoints.findIndex((w) => w.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= s.waypoints.length) return s;
      const next = [...s.waypoints];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { waypoints: next, openStop: null };
    }),
  reverse: () => set((s) => ({ waypoints: [...s.waypoints].reverse(), openStop: null })),
  clear: () =>
    set({ waypoints: [], result: null, resultKey: null, status: { kind: "idle" }, openStop: null }),
  setDepartAt: (departAt) => set({ departAt }),
  setClickMode: (clickMode) => set({ clickMode }),
  setResult: (result, key = null) => set({ result, resultKey: result ? key : null }),
  setStatus: (status) => set({ status }),
  setOpenStop: (openStop) => set({ openStop }),
}));

/**
 * Huella de lo que cambia el cálculo: sitio, hora de salida, posición y
 * permanencia de cada punto, en orden. El texto de la tarea no entra: no
 * cambia tiempos ni consumos, y el veredicto no tiene que parpadear por tecla.
 */
export function planKey(siteId: string, departAt: Date, waypoints: readonly Waypoint[]): string {
  return JSON.stringify([
    siteId,
    departAt.getTime(),
    waypoints.map((w) => [w.lat, w.lon, w.dwellMin]),
  ]);
}

/**
 * La ruta calculada, solo si corresponde a los puntos y la hora de AHORA.
 *
 * Mientras se recalcula (respiro de 300 ms + el pedido), `result` todavía es
 * el de antes: mostrarlo dejaba un GO viejo en pantalla y corría los datos de
 * cada estación una fila (al sumar una estación, la llegada aparecía debajo de
 * la estación 1). Panel, mapa y tira imprimible leen la ruta por acá.
 */
export function useFreshRoute(): PlannedRoute | null {
  const siteId = useStore((s) => s.activeSiteId);
  return usePlan((s) =>
    s.result !== null && s.resultKey === planKey(siteId, s.departAt, s.waypoints) ? s.result : null,
  );
}
