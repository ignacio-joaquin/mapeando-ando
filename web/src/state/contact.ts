/**
 * Capa "Contacto con el hábitat" (id `habitat-contact`): desde dónde hay línea
 * de vista por radio con el hábitat (A). La calcula la API cada vez que se
 * mueve el hábitat (api/viewshed.py); el panel la pide y el mapa la dibuja.
 */
import { create } from "zustand";
import type { Viewshed } from "../api/schemas";

type Load =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "missing" } // el server todavía no tiene el endpoint
  | { readonly kind: "error"; readonly message: string };

interface ContactState {
  /** Prendida por defecto: es lo que explica un NO-GO por contacto. */
  readonly visible: boolean;
  /** Respuesta para el hábitat actual. null = todavía no hay (o no hay hábitat). */
  readonly viewshed: Viewshed | null;
  readonly load: Load;
  setVisible: (on: boolean) => void;
  setViewshed: (v: Viewshed | null) => void;
  setLoad: (l: Load) => void;
}

export const useContact = create<ContactState>((set) => ({
  visible: true,
  viewshed: null,
  load: { kind: "idle" },
  setVisible: (visible) => set({ visible }),
  setViewshed: (viewshed) => set({ viewshed }),
  setLoad: (load) => set({ load }),
}));

export const CONTACT_LAYER_ID = "habitat-contact";
export const CONTACT_HATCH_IMAGE = "habitat-contact-hatch";

/** Colores de la capa. MapLibre no lee variables CSS: van como hex, en un solo lugar. */
export const CONTACT_COLOR = {
  contact: "#5fbf86",
  no_contact: "#e0564a",
  unknown: "#a39a8f",
} as const;

/** Texto de la leyenda: nada crítico va solo por color (sin contacto lleva rayado). */
export const CONTACT_LABEL = {
  contact: "con vista al hábitat",
  no_contact: "sin contacto (rayado)",
  unknown: "sin dato",
} as const;
