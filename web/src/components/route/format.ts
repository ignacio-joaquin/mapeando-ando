import { localeNow } from "../../i18n/lang";
import { ltstAt, formatMarsTime } from "../../mars/mars24";
import type { SourceInfo } from "../../domain/provenance";

/** Hora solar local "HH:MM" en una longitud, para un instante UTC. */
export function ltstShort(iso: string | Date, lon: number): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return formatMarsTime(ltstAt(d, lon)).slice(0, 5);
}

/** Hora terrestre de esta computadora, "HH:MM". */
export function earthShort(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleTimeString(localeNow(), { hour: "2-digit", minute: "2-digit" });
}

/** Valor para <input type="datetime-local"> en la zona horaria local. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDistanceM(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const r = Math.round(min - h * 60);
  return `${h} h ${String(r).padStart(2, "0")} min`;
}

const COMPASS = {
  es: ["N", "NE", "E", "SE", "S", "SO", "O", "NO"],
  en: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
} as const;
export function formatBearing(deg: number): string {
  const card = COMPASS[localeNow() === "en-US" ? "en" : "es"][Math.round(deg / 45) % 8] ?? "N";
  return `${String(Math.round(deg)).padStart(3, "0")}° ${card}`;
}

/** ¿Dos valores vienen de la misma fuente? Para no repetir el badge por fila. */
export function sameSource(a: SourceInfo, b: SourceInfo): boolean {
  return (
    a.provenance === b.provenance &&
    a.mission === b.mission &&
    a.instrument === b.instrument &&
    a.source === b.source
  );
}
