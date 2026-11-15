/**
 * Dónde está el Sol en el cielo de un punto de Marte, para un instante UTC.
 *
 * Sale de Mars24 (mars24.ts): declinación por Ls y ángulo horario por LTST.
 * Precisión de décimas de grado: alcanza para dibujar el Sol y saber de qué
 * lado viene la luz, no para navegar. Esfera, sin refracción (la atmósfera de
 * Marte casi no desvía) y la latitud planetocéntrica tomada como la del
 * observador.
 */
import { MARS24, type SourceInfo } from "../domain/provenance";
import { declinationDeg, ltstAt, marsTime } from "./mars24";

const DEG = Math.PI / 180;

export interface SunPosition {
  /** Azimut desde el norte, hacia el este, 0–360°. */
  readonly azimuthDeg: number;
  /** Elevación sobre el horizonte plano, −90–90°. */
  readonly elevationDeg: number;
  /** Vector unitario hacia el Sol en el marco local: este, norte, arriba. */
  readonly enu: readonly [number, number, number];
  /** Hora solar verdadera local, 0–24 h. */
  readonly ltst: number;
  readonly ls: number;
}

/** Procedencia de la posición del Sol (badge). */
export const SUN_SOURCE: SourceInfo = {
  ...MARS24,
  assumptions: [
    "Declinación por Ls y ángulo horario por hora solar verdadera local: error de décimas de grado",
    "Elevación sobre el horizonte plano; si el relieve tapa el Sol se dice aparte",
  ],
};

export function sunPosition(date: Date, lat: number, lonEast: number): SunPosition {
  const { ls } = marsTime(date);
  const ltst = ltstAt(date, lonEast);
  const dec = declinationDeg(ls) * DEG;
  const h = (ltst - 12) * 15 * DEG; // ángulo horario: positivo a la tarde (Sol al oeste)
  const phi = lat * DEG;

  const east = -Math.cos(dec) * Math.sin(h);
  const north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(h);
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h);

  const az = (Math.atan2(east, north) / DEG + 360) % 360;
  const el = Math.asin(Math.max(-1, Math.min(1, up))) / DEG;
  return { azimuthDeg: az, elevationDeg: el, enu: [east, north, up], ltst, ls };
}
