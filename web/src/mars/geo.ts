import { MARS_RADIUS_M } from "./constants";

const rad = (deg: number) => (deg * Math.PI) / 180;

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/**
 * Distancia great-circle sobre Marte, en metros (haversine).
 * Usa el radio marciano, no el terrestre: medir con 6371 km da ~88% de error.
 */
export function marsDistanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Metros por pixel en pantalla, para la barra de escala, a una latitud dada. */
export function marsMetersPerPixel(lat: number, zoom: number, tileSize = 512): number {
  const worldPx = tileSize * 2 ** zoom;
  const circumference = 2 * Math.PI * MARS_RADIUS_M * Math.cos(rad(lat));
  return circumference / worldPx;
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

/** Lat/lon en el formato que se lee con guantes: 18.4880° N, 77.4030° E. */
export function formatLatLon({ lat, lon }: LatLon): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

/** Rumbo inicial (0–360°, 0 = norte, 90 = este) de a hacia b, sobre la esfera. */
export function marsBearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δλ = rad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
