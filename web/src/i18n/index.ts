/**
 * Idioma de la interfaz (ES / EN).
 *
 * El idioma vive en su propio store: lo leen los componentes con `useT()` y el
 * código fuera de React (cliente de la API, planificador de ejemplo) con
 * `getT()`. Se recuerda por navegador en localStorage; la primera vez se toma
 * el idioma del navegador, y todo lo que no es español arranca en inglés,
 * que es lo que leen los jueces.
 */
import { create } from "zustand";
import { en, es, type Messages } from "./messages";

export type Lang = "es" | "en";
export const LANGS: readonly Lang[] = ["es", "en"];

const MESSAGES: Record<Lang, Messages> = { es, en };
const STORAGE_KEY = "mapa-marciano:lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "es" || saved === "en") return saved;
  } catch {
    // Sin storage (modo privado, iframe): se decide por el navegador.
  }
  const nav = typeof navigator === "undefined" ? "" : navigator.language;
  return nav.toLowerCase().startsWith("es") ? "es" : "en";
}

interface LangState {
  readonly lang: Lang;
  setLang: (lang: Lang) => void;
}

export const useLang = create<LangState>((set) => ({
  lang: initialLang(),
  setLang: (lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // No se pudo guardar: el cambio vale igual para esta pestaña.
    }
    set({ lang });
  },
}));

/** Textos del idioma activo, para componentes. */
export function useT(): Messages {
  return useLang((s) => MESSAGES[s.lang]);
}

/** Textos del idioma activo, para código fuera de React. */
export function getT(): Messages {
  return MESSAGES[useLang.getState().lang];
}

export type { Messages };
