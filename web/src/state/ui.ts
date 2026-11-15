/**
 * Estado de la interfaz del planificador que no es la travesía: qué pestaña
 * está abierta y en qué paso va la navegación.
 */
import { create } from "zustand";

export type PlannerTab = "navigate" | "route" | "safety" | "settings";

interface UiState {
  readonly tab: PlannerTab;
  /** Paso de la navegación (índice global de routeSteps). */
  readonly navStep: number;
  setTab: (tab: PlannerTab) => void;
  setNavStep: (i: number) => void;
}

export const useUi = create<UiState>((set) => ({
  tab: "route",
  navStep: 0,
  setTab: (tab) => set({ tab }),
  setNavStep: (navStep) => set({ navStep }),
}));
