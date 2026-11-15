/**
 * Convenciones visuales de la ruta, compartidas por el mapa y el panel.
 * Los colores salen del tema (index.css); MapLibre no lee variables CSS, por
 * eso van como hex acá, en un solo lugar.
 */
import type { LegClass } from "../api/schemas";

export const LEG_CLASS_COLOR: Record<LegClass, string> = {
  ok: "#5fbf86",
  caution: "#e0a24a",
  limit: "#e07a4a",
  blocked: "#e0564a",
  unknown: "#a39a8f",
};

/** Texto de la leyenda: nada crítico va solo por color. */
export const LEG_CLASS_LABEL: Record<LegClass, string> = {
  ok: "transitable",
  caution: "con cuidado",
  limit: "al límite",
  blocked: "no transitable",
  unknown: "sin evaluar (falta DTM)",
};

export type WaypointKind = "origin" | "station" | "destination" | "return";

/** A = hábitat (salida), B = destino, 1, 2… = paradas. Con un solo punto, es el hábitat. */
export function waypointLabel(
  index: number,
  total: number,
): { readonly kind: WaypointKind; readonly short: string; readonly long: string } {
  if (index === 0) return { kind: "origin", short: "A", long: "Hábitat (salida)" };
  if (index === total - 1) return { kind: "destination", short: "B", long: "Destino" };
  return { kind: "station", short: String(index), long: `Parada ${index}` };
}

/**
 * Etiqueta de una parada de la RESPUESTA. Con ida y vuelta, la última es el
 * hábitat otra vez (A, "vuelta") y el destino queda anteúltimo.
 */
export function stopLabel(
  index: number,
  stops: number,
  roundTrip: boolean,
): { readonly kind: WaypointKind; readonly short: string; readonly long: string } {
  if (roundTrip && stops > 2 && index === stops - 1) {
    return { kind: "return", short: "A", long: "Hábitat (vuelta)" };
  }
  return waypointLabel(index, roundTrip ? stops - 1 : stops);
}
