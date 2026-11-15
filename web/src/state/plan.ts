/**
 * Estado del planificador de travesía, estilo Google Maps: el hábitat (salida),
 * el destino (llegada) y paradas en el medio, en orden. Separado de store.ts
 * para que el planificador se pueda leer de punta a punta en un archivo.
 *
 * El hábitat no es un punto fijo del sitio: lo marca el usuario cada vez.
 *
 * Con `roundTrip` (prendido por defecto) el cálculo suma la vuelta del destino
 * al hábitat: una EVA termina adentro, y un GO que solo alcanza para ir no
 * sirve para decidir. La vuelta no es un punto más de la lista: se agrega al
 * armar el pedido (ver routeWaypoints).
 *
 * La carga (equipo elegido + kilos a mano) es de la EVA, no de un punto: no
 * se borra al cambiar de sitio ni con "borrar todo". Va a /api/route como
 * `cargo_kg` y entra a Pandolf (MAP-50).
 */
import { create } from "zustand";
import type { RouteParams } from "../api/schemas";
import { countOverrides, useSettings } from "./settings";
import type { LatLon } from "../mars/geo";
import type { PlannedRoute } from "../api/client";
import { cargoKg, clampExtraKg } from "../domain/equipment";
import { useStore } from "./store";
import { planFromUrl } from "./share";

export interface Waypoint extends LatLon {
  readonly id: string;
  /** Qué se hace ahí. Texto libre; null en la salida si no se escribe nada. */
  readonly task: string;
  /** Minutos de permanencia. En la salida no cuenta: se sale a la hora elegida. */
  readonly dwellMin: number;
  /** Lugar de places.json elegido con el buscador o un chip. null = clic en el mapa. */
  readonly placeId: string | null;
}

export type ClickMode = "add" | "inspect";

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string };

interface PlanState {
  /** Sitio al que pertenecen los puntos. Al cambiar de sitio se arranca de cero. */
  readonly siteId: string;
  readonly waypoints: readonly Waypoint[];
  readonly departAt: Date;
  /** Calcular también la vuelta del destino al hábitat. */
  readonly roundTrip: boolean;
  /** Equipo elegido (ids de domain/equipment.ts), en el orden del catálogo no importa. */
  readonly kit: readonly string[];
  /** Carga libre a mano (muestras juntadas, otro equipo), en kg. */
  readonly extraKg: number;
  readonly clickMode: ClickMode;
  readonly result: PlannedRoute | null;
  /** Huella (planKey) del pedido que generó `result`. */
  readonly resultKey: string | null;
  readonly status: Status;
  /** Estación abierta en el panel (índice en waypoints). */
  readonly openStop: number | null;
  /**
   * Indicación resaltada en el mapa (índice en routeSteps). `pinned` = elegida
   * con un clic: el mapa la encuadra y queda hasta otro clic.
   */
  readonly activeStep: { readonly index: number; readonly pinned: boolean } | null;
  /** Aviso para el usuario (ej. un punto rechazado por falta de terreno). */
  readonly notice: string | null;
  /** Clic en el mapa: 1ro = hábitat, 2do = destino, después paradas antes del destino. */
  addPoint: (p: LatLon, placeId?: string | null) => void;
  /** Pone o cambia el destino. Necesita el hábitat marcado. */
  setDestination: (p: LatLon, placeId?: string | null) => void;
  /** Suma una parada justo antes del destino. Necesita hábitat y destino. */
  addStop: (p: LatLon, placeId?: string | null) => void;
  movePoint: (id: string, p: LatLon) => void;
  updatePoint: (id: string, patch: Partial<Pick<Waypoint, "task" | "dwellMin">>) => void;
  removePoint: (id: string) => void;
  shiftPoint: (id: string, delta: -1 | 1) => void;
  /** Mueve un punto a otra posición de la lista (arrastrar y soltar). */
  movePointTo: (id: string, toIndex: number) => void;
  reverse: () => void;
  clear: () => void;
  setDepartAt: (d: Date) => void;
  setRoundTrip: (on: boolean) => void;
  toggleEquipment: (id: string) => void;
  setExtraKg: (kg: number) => void;
  setClickMode: (m: ClickMode) => void;
  setResult: (r: PlannedRoute | null, key?: string | null) => void;
  setStatus: (s: Status) => void;
  setOpenStop: (i: number | null) => void;
  setActiveStep: (step: { index: number; pinned: boolean } | null) => void;
  setNotice: (notice: string | null) => void;
  /** Al cambiar de sitio: borra la travesía si era de otro. */
  switchSite: (siteId: string) => void;
  /**
   * Saca los puntos sin terreno de 1 m. Corre cuando llega la cobertura: un
   * enlace compartido (o un punto marcado antes de que llegara) pasa por el
   * mismo chequeo que un clic, en vez de calcular una ruta y dar GO afuera.
   * Si el que cae afuera es el hábitat, borra la travesía entera; si no, saca
   * esos puntos y el aviso dice cuáles.
   */
  dropOutside: (inside: (p: LatLon) => boolean) => void;
}

let seq = 0;
const newId = () => `wp-${++seq}`;

/** Duración por defecto de una estación nueva, editable en el panel. */
const DEFAULT_DWELL_MIN = 15;

const point = (p: LatLon, placeId: string | null, dwellMin = 0): Waypoint => ({
  id: newId(),
  lat: p.lat,
  lon: p.lon,
  task: "",
  dwellMin,
  placeId,
});

const insertStop = (wps: readonly Waypoint[], wp: Waypoint): Waypoint[] => [
  ...wps.slice(0, -1),
  { ...wp, dwellMin: DEFAULT_DWELL_MIN },
  ...wps.slice(-1),
];

// Un enlace compartido (?site=&depart=&pts=) arranca con esa travesía.
const shared = planFromUrl();

export const usePlan = create<PlanState>((set) => ({
  siteId: useStore.getState().activeSiteId,
  waypoints: (shared?.points ?? []).map((p) => point(p, p.placeId, p.dwellMin)),
  departAt: shared?.departAt ?? new Date(),
  roundTrip: shared?.roundTrip ?? true,
  kit: shared?.kit ?? [],
  extraKg: shared?.extraKg ?? 0,
  clickMode: "add",
  result: null,
  resultKey: null,
  status: { kind: "idle" },
  openStop: null,
  activeStep: null,
  notice: null,

  addPoint: (p, placeId = null) =>
    set((s) => {
      const wp = point(p, placeId);
      if (s.waypoints.length < 2) return { waypoints: [...s.waypoints, wp], notice: null };
      return { waypoints: insertStop(s.waypoints, wp), notice: null };
    }),
  setDestination: (p, placeId = null) =>
    set((s) => {
      if (s.waypoints.length === 0) return { notice: "Primero marcá el hábitat en el mapa: es de donde salís." };
      const wp = point(p, placeId);
      if (s.waypoints.length === 1) return { waypoints: [...s.waypoints, wp], notice: null };
      return { waypoints: [...s.waypoints.slice(0, -1), wp], notice: null, openStop: null };
    }),
  addStop: (p, placeId = null) =>
    set((s) => {
      if (s.waypoints.length < 2) return { notice: "Para sumar una parada, primero elegí el destino." };
      return { waypoints: insertStop(s.waypoints, point(p, placeId)), notice: null };
    }),
  // Arrastrar el marcador deja el punto en otro lado: ya no es el lugar con nombre.
  movePoint: (id, p) =>
    set((s) => ({
      waypoints: s.waypoints.map((w) =>
        w.id === id ? { ...w, lat: p.lat, lon: p.lon, placeId: null } : w,
      ),
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
  movePointTo: (id, toIndex) =>
    set((s) => {
      const from = s.waypoints.findIndex((w) => w.id === id);
      const to = Math.min(Math.max(0, toIndex), s.waypoints.length - 1);
      if (from < 0 || from === to) return s;
      const next = [...s.waypoints];
      const [moved] = next.splice(from, 1);
      if (!moved) return s;
      next.splice(to, 0, moved);
      return { waypoints: next, openStop: null };
    }),
  reverse: () => set((s) => ({ waypoints: [...s.waypoints].reverse(), openStop: null })),
  clear: () =>
    set({
      waypoints: [],
      result: null,
      resultKey: null,
      status: { kind: "idle" },
      openStop: null,
      activeStep: null,
      notice: null,
    }),
  setDepartAt: (departAt) => set({ departAt }),
  setRoundTrip: (roundTrip) => set({ roundTrip }),
  toggleEquipment: (id) =>
    set((s) => ({ kit: s.kit.includes(id) ? s.kit.filter((k) => k !== id) : [...s.kit, id] })),
  setExtraKg: (kg) => set({ extraKg: clampExtraKg(kg) }),
  setClickMode: (clickMode) => set({ clickMode }),
  // Una ruta nueva trae otras indicaciones: la resaltada ya no corresponde.
  setResult: (result, key = null) => set({ result, resultKey: result ? key : null, activeStep: null }),
  setStatus: (status) => set({ status }),
  setOpenStop: (openStop) => set({ openStop }),
  setActiveStep: (activeStep) => set({ activeStep }),
  setNotice: (notice) => set({ notice }),
  dropOutside: (inside) =>
    set((s) => {
      const wps = s.waypoints;
      const out = wps.flatMap((w, i) => (inside(w) ? [] : [i]));
      if (out.length === 0) return s;
      // Sin hábitat la travesía no tiene de dónde salir: se borra entera y se pide marcarlo
      // de nuevo, en vez de que la parada siguiente pase a ser el hábitat sin avisar.
      if (out.includes(0)) {
        return {
          waypoints: [],
          result: null,
          resultKey: null,
          status: { kind: "idle" },
          openStop: null,
          notice:
            "El hábitat cae fuera del terreno de 1 m real (DTM HiRISE): borré la travesía. " +
            "Marcá el hábitat de nuevo, adentro del contorno.",
        };
      }
      const last = wps.length - 1;
      const names = out.map((i) => (i === last ? "el destino" : `la parada ${i}`));
      const kept = wps.filter((_, i) => !out.includes(i));
      const lostDestination = out.includes(last);
      const after = !lostDestination
        ? ""
        : kept.length >= 2
          ? " Ahora el destino es la última parada que quedaba."
          : " Elegí otro destino.";
      return {
        waypoints: kept,
        openStop: null,
        notice: `Saqué ${names.join(", ").replace(/, ([^,]*)$/, " y $1")} de la travesía: ahí no hay terreno de 1 m real (DTM HiRISE).${after}`,
      };
    }),
  switchSite: (siteId) =>
    set((s) =>
      s.siteId === siteId
        ? s
        : {
            siteId,
            waypoints: [],
            result: null,
            resultKey: null,
            status: { kind: "idle" },
            openStop: null,
            notice: null,
          },
    ),
}));

/** Tarea de la vuelta: el último punto del pedido, una copia del hábitat. */
export const RETURN_TASK = "Vuelta al hábitat";

/**
 * Los puntos que van al pedido de /api/route, en orden. Con ida y vuelta se
 * agrega el hábitat otra vez al final: el contrato ya admite que la llegada
 * sea cualquier punto, así que la API no necesita saber nada nuevo. La
 * respuesta trae entonces una parada y un tramo más que `waypoints`.
 */
export function routeWaypoints(waypoints: readonly Waypoint[], roundTrip: boolean): Waypoint[] {
  const home = waypoints[0];
  if (!roundTrip || !home || waypoints.length < 2) return [...waypoints];
  return [...waypoints, { ...home, id: `${home.id}-return`, task: RETURN_TASK, dwellMin: 0 }];
}

/**
 * Huella de lo que cambia el cálculo: sitio, hora de salida, ida y vuelta,
 * carga, y posición y permanencia de cada punto, en orden. El texto de la tarea no
 * entra: no cambia tiempos ni consumos, y el veredicto no tiene que parpadear
 * por tecla.
 */
export function planKey(
  siteId: string,
  departAt: Date,
  waypoints: readonly Waypoint[],
  roundTrip: boolean,
  cargo: number,
  params: RouteParams | undefined,
): string {
  return JSON.stringify([
    siteId,
    departAt.getTime(),
    roundTrip,
    cargo,
    waypoints.map((w) => [w.lat, w.lon, w.dwellMin]),
    params ?? null,
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
  const params = useRouteParams();
  return usePlan((s) =>
    s.result !== null &&
    s.resultKey === planKey(siteId, s.departAt, s.waypoints, s.roundTrip, cargoKg(s.kit, s.extraKg), params)
      ? s.result : null,
  );
}

/**
 * Los ajustes que viajan en el pedido: solo si el server publicó cuáles acepta
 * (GET /api/route/params) y el usuario cambió alguno. Un server sin ese
 * endpoint rechazaría el campo con 422.
 */
export function useRouteParams(): RouteParams | undefined {
  const overrides = useSettings((s) => s.overrides);
  const ready = useSettings((s) => s.schemaState === "ready");
  return ready && countOverrides(overrides) > 0 ? overrides : undefined;
}
