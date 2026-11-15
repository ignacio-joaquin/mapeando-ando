/**
 * Estado del modo entrenamiento (web/src/edu/). Separado del planificador: el
 * alumno usa el planificador de siempre y las lecciones solo miran lo que el
 * /api/route real le contesta. Ninguna lección trae números propios.
 */
import { create } from "zustand";
import type { LimitingFactor } from "../api/schemas";

/** Una evaluación del planificador mientras hay una lección abierta. */
export interface Attempt {
  /** Puntos y permanencias, sin la hora: dos intentos con la misma geometría comparan la hora. */
  readonly geometryKey: string;
  readonly departMs: number;
  readonly status: "GO" | "CAUTION" | "NO_GO";
  readonly limiting: LimitingFactor | null;
  /** Escenarios de estrés que aguanta, de los que se pudieron evaluar. */
  readonly passed: number | null;
  readonly evaluated: number | null;
}

/** La predicción del alumno: un factor, o "nada me limita" (null). */
export type Prediction = LimitingFactor | "none";

interface EduState {
  /** Lista de lecciones abierta (sin lección elegida). */
  readonly open: boolean;
  readonly lessonId: string | null;
  readonly step: number;
  /** Predicción del paso actual, si el paso pide una. */
  readonly prediction: Prediction | null;
  /** Intentos de la lección actual, del más viejo al más nuevo. */
  readonly attempts: readonly Attempt[];
  /** Se salteó un paso que los datos de hoy no dejan cumplir: la lección no queda hecha. */
  readonly skipped: boolean;
  /** Lecciones terminadas (por id). Se guarda en el navegador si se puede. */
  readonly done: Readonly<Record<string, true>>;
  setOpen: (open: boolean) => void;
  start: (lessonId: string) => void;
  goTo: (step: number) => void;
  skip: (step: number) => void;
  predict: (p: Prediction) => void;
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
  setOpen: (open) => set({ open }),
  start: (lessonId) => set({ open: true, lessonId, step: 0, prediction: null, attempts: [], skipped: false }),
  goTo: (step) => set({ step, prediction: null }),
  skip: (step) => set({ step, prediction: null, skipped: true }),
  predict: (prediction) => set({ prediction }),
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
  exit: () => set({ lessonId: null, step: 0, prediction: null, attempts: [], skipped: false }),
}));
