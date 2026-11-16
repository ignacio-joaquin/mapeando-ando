/**
 * Idioma de la interfaz: español o inglés (para el jurado de Space Apps).
 *
 * Arranca según el navegador (inglés salvo que esté en español) y la elección
 * del botón ES/EN queda guardada en el navegador. Dos mecanismos:
 *
 * - Texto de la UI escrito en los componentes: `t("español", "English")`,
 *   los dos idiomas juntos en el mismo lugar (useT).
 * - Texto que llega como dato en español (respuestas de la API, constantes de
 *   capas, procedencias): `tr(texto)` lo busca en el diccionario de
 *   ./data.en.ts. Si no está, se muestra el original: no se inventa una
 *   traducción (useTr).
 */
import { create } from "zustand";
import { translateData } from "./translate";

export type Lang = "es" | "en";

const KEY = "mapeando.lang.v1";

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "es" || saved === "en") return saved;
  } catch {
    // sin almacenamiento: se decide por el navegador
  }
  const nav = typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language ?? "") : "";
  return nav.toLowerCase().startsWith("es") ? "es" : "en";
}

interface LangState {
  readonly lang: Lang;
  setLang: (l: Lang) => void;
}

export const useLang = create<LangState>((set) => ({
  lang: initial(),
  setLang: (lang) => {
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      // queda en memoria
    }
    document.documentElement.lang = lang;
    set({ lang });
  },
}));

if (typeof document !== "undefined") document.documentElement.lang = useLang.getState().lang;

/** Elige entre las dos versiones (sirve para texto y para JSX). */
export type T = <V>(es: V, en: V) => V;

// Una función fija por idioma: así cambia de identidad solo cuando cambia el
// idioma, y el React Compiler vuelve a renderizar justo ahí.
const PICK: Record<Lang, T> = {
  es: (es) => es,
  en: (_es, en) => en,
};

/**
 * Todo componente que muestra texto tiene que llamar a useT, useTr o useLocale
 * (aunque sea para un solo texto): con el React Compiler, un componente que no
 * depende del idioma no se vuelve a renderizar al cambiarlo.
 */
export function useT(): T {
  return PICK[useLang((s) => s.lang)];
}

/** Fuera de React (ej. un mensaje de error armado en un callback). */
export function tNow<V>(es: V, en: V): V {
  return useLang.getState().lang === "en" ? en : es;
}

/** Traduce texto que llega como dato en español. Sin traducción conocida, lo deja igual. */
type Tr = (s: string | null | undefined) => string;
const TR: Record<Lang, Tr> = {
  es: (s) => s ?? "",
  en: (s) => (s == null ? "" : translateData(s)),
};

export function useTr(): Tr {
  return TR[useLang((s) => s.lang)];
}

export function trNow(s: string | null | undefined): string {
  if (s == null) return "";
  return useLang.getState().lang === "en" ? translateData(s) : s;
}

/** Locale para números y fechas. */
export function useLocale(): string {
  return useLang((s) => s.lang) === "en" ? "en-US" : "es-AR";
}

export function localeNow(): string {
  return useLang.getState().lang === "en" ? "en-US" : "es-AR";
}
