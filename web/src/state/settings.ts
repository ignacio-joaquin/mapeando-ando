/**
 * Ajustes del planificador que cambió el usuario (límites, pesos, traje). Solo
 * se guardan las diferencias con el default del server: lo que no está acá
 * viaja sin tocar. Quedan en el navegador de cada uno (localStorage), así un
 * recargo no las pierde; si el almacenamiento no anda, viven en memoria.
 */
import { create } from "zustand";
import type { RouteParams, RouteSettings, SettingsGroup } from "../api/schemas";

const KEY = "mapeando.route-params.v1";

function load(): RouteParams {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as RouteParams) : {};
  } catch {
    return {};
  }
}

function save(p: RouteParams) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Sin almacenamiento (ventana privada, bloqueado): quedan en memoria.
  }
}

interface SettingsState {
  readonly overrides: RouteParams;
  /** Qué se puede ajustar (GET /api/route/params). null = todavía no llegó o no existe. */
  readonly schema: RouteSettings | null;
  readonly schemaState: "loading" | "ready" | "missing" | "error";
  /** null = volver al default. */
  set: (group: SettingsGroup, id: string, value: number | null) => void;
  reset: () => void;
  setSchema: (schema: RouteSettings | null, state: SettingsState["schemaState"]) => void;
}

export const useSettings = create<SettingsState>((set) => ({
  overrides: load(),
  schema: null,
  schemaState: "loading",
  set: (group, id, value) =>
    set((s) => {
      const g = { ...(s.overrides[group] ?? {}) };
      if (value === null) delete g[id];
      else g[id] = value;
      const overrides = { ...s.overrides, [group]: g };
      if (Object.keys(g).length === 0) delete overrides[group];
      save(overrides);
      return { overrides };
    }),
  reset: () => {
    save({});
    set({ overrides: {} });
  },
  setSchema: (schema, schemaState) =>
    set((s) => {
      // Un ajuste que el server ya no acepta (o un valor fuera de rango) no se manda:
      // el pedido entero volvería con 422.
      if (!schema) return { schema, schemaState };
      const clean: RouteParams = {};
      for (const g of schema.groups) {
        const mine = s.overrides[g.id];
        if (!mine) continue;
        const kept: Record<string, number> = {};
        for (const f of g.fields) {
          const v = mine[f.id];
          if (v === undefined) continue;
          if ((f.min !== null && v < f.min) || (f.max !== null && v > f.max)) continue;
          kept[f.id] = v;
        }
        if (Object.keys(kept).length > 0) clean[g.id] = kept;
      }
      save(clean);
      return { schema, schemaState, overrides: clean };
    }),
}));

/** Cuántos ajustes difieren del default. */
export function countOverrides(p: RouteParams): number {
  return Object.values(p).reduce((n, g) => n + Object.keys(g ?? {}).length, 0);
}
