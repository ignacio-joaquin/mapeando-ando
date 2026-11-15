/**
 * Estado del modo entrenamiento (web/src/edu/). Separado del planificador: el
 * alumno usa el planificador de siempre y las lecciones solo miran lo que el
 * /api/route real le contesta. Ninguna lección trae números propios.
 */
import { create } from "zustand";
import type { LimitingFactor, RouteResponse } from "../api/schemas";

/** Una evaluación del planificador mientras hay una lección abierta. */
export interface Attempt {
  /** Puntos, permanencias, ida y vuelta y carga, sin la hora: dos intentos con la misma geometría comparan la hora. */
  readonly geometryKey: string;
  readonly departMs: number;
  readonly status: "GO" | "CAUTION" | "NO_GO";
  readonly limiting: LimitingFactor | null;
  /** Escenarios de estrés que aguanta, de los que se pudieron evaluar. */
  readonly passed: number | null;
  readonly evaluated: number | null;
  /**
   * ¿Se pudo evaluar la luz? Si no, un cambio de veredicto entre dos horas
   * puede venir de que una hora tiene pila de sombras y la otra no: eso es
   * cobertura de datos, no el efecto de la hora.
   */
  readonly daylightEvaluated: boolean;
}

/** La respuesta del alumno y la ruta contra la que respondió (congelada). */
export interface PredictionRecord {
  readonly choice: Prediction;
  readonly route: RouteResponse;
}

/** La predicción del alumno: un factor, o "nada me limita" (null). */
export type Prediction = LimitingFactor | "none";

/**
 * A dónde lleva la cámara un paso. No hay coordenadas escritas a mano: todo
 * sale del sitio (bbox de /api/sites) o de la travesía del alumno.
 */
export type CameraSpec =
  | { readonly kind: "site" }
  /** Centrado en el hábitat (si no hay, el sitio). */
  | { readonly kind: "habitat"; readonly zoom: number }
  /** Encuadra la ruta calculada; si no hay, los puntos; si no, el sitio. */
  | { readonly kind: "route" };

export interface CameraRequest {
  /** Sube en cada pedido: el mapa vuela una vez por pedido. */
  readonly seq: number;
  readonly spec: CameraSpec;
}

interface EduState {
  /** Lista de lecciones abierta (sin lección elegida). */
  readonly open: boolean;
  readonly lessonId: string | null;
  readonly step: number;
  /** Predicción del paso actual, si el paso pide una. */
  readonly prediction: PredictionRecord | null;
  /** Intentos de la lección actual, del más viejo al más nuevo. */
  readonly attempts: readonly Attempt[];
  /** Se salteó un paso que los datos de hoy no dejan cumplir: la lección no queda hecha. */
  readonly skipped: boolean;
  /** Lecciones terminadas (por id). Se guarda en el navegador si se puede. */
  readonly done: Readonly<Record<string, true>>;
  /** Último pedido de cámara de la lección. */
  readonly camera: CameraRequest | null;
  /** Zoom trabado por la lección (se puede seguir moviendo el mapa). */
  readonly zoomLock: boolean;
  requestCamera: (spec: CameraSpec) => void;
  setZoomLock: (lock: boolean) => void;
  setOpen: (open: boolean) => void;
  start: (lessonId: string) => void;
  goTo: (step: number) => void;
  skip: (step: number) => void;
  predict: (choice: Prediction, route: RouteResponse) => void;
  record: (a: Attempt) => void;
  complete: (lessonId: string) => void;
  exit: () => void;
}

const STORAGE_KEY = "mapa-marciano.edu.done";
/** Tope de intentos guardados: alcanza para comparar, no crece sin fin. */
const MAX_ATTEMPTS = 30;

function loadDone(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.keys(parsed).filter((k) => /^[a-z0-9-]{1,32}$/.test(k)).map((k) => [k, true as const]),
    );
  } catch {
    return {};
  }
}

function saveDone(done: Readonly<Record<string, true>>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(done));
  } catch {
    // Sin almacenamiento (ventana privada): el progreso dura lo que la pestaña.
  }
}

export const useEdu = create<EduState>((set) => ({
  open: false,
  lessonId: null,
  step: 0,
  prediction: null,
  attempts: [],
  skipped: false,
  done: typeof window === "undefined" ? {} : loadDone(),
  camera: null,
  zoomLock: false,
  requestCamera: (spec) => set((s) => ({ camera: { seq: (s.camera?.seq ?? 0) + 1, spec } })),
  setZoomLock: (zoomLock) => set({ zoomLock }),
  setOpen: (open) => set({ open }),
  start: (lessonId) => set({ open: true, lessonId, step: 0, prediction: null, attempts: [], skipped: false }),
  goTo: (step) => set({ step, prediction: null }),
  skip: (step) => set({ step, prediction: null, skipped: true }),
  predict: (choice, route) => set({ prediction: { choice, route } }),
  record: (a) =>
    set((s) => {
      const last = s.attempts.at(-1);
      // El mismo pedido dos veces (re-render, vuelta atrás) no es un intento nuevo.
      if (last && last.geometryKey === a.geometryKey && last.departMs === a.departMs) return s;
      return { attempts: [...s.attempts, a].slice(-MAX_ATTEMPTS) };
    }),
  complete: (lessonId) =>
    set((s) => {
      if (s.skipped) return s;
      const done = { ...s.done, [lessonId]: true as const };
      saveDone(done);
      return { done };
    }),
  exit: () => set({ lessonId: null, step: 0, prediction: null, attempts: [], skipped: false, zoomLock: false }),
}));
