/**
 * Convenciones visuales de la ruta, compartidas por el mapa y el panel.
 * Los colores salen del tema (index.css); MapLibre no lee variables CSS, por
 * eso van como hex acá, en un solo lugar.
 */
import type { LegClass } from "../api/schemas";
import type { Messages } from "../i18n";

export const LEG_CLASS_COLOR: Record<LegClass, string> = {
  ok: "#5fbf86",
  caution: "#e0a24a",
  limit: "#e07a4a",
  blocked: "#e0564a",
  unknown: "#a39a8f",
};

// El texto de cada clase está en src/i18n (`legClass`): nada crítico va solo por color.

export type WaypointKind = "origin" | "station" | "destination";

/** A = salida, B = llegada, 1, 2… = estaciones. Con un solo punto, es la salida. */
export function waypointLabel(
  index: number,
  total: number,
  t: Messages,
): { readonly kind: WaypointKind; readonly short: string; readonly long: string } {
  if (index === 0) return { kind: "origin", short: "A", long: t.waypoint.origin };
  if (index === total - 1) return { kind: "destination", short: "B", long: t.waypoint.destination };
  return { kind: "station", short: String(index), long: t.waypoint.station(index) };
}
