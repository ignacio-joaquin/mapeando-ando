/**
 * La travesía en la URL, para compartirla: sitio, hora de salida y puntos.
 *
 *   ?site=jezero&depart=2026-11-14T15:00:00.000Z&pts=18.44463,77.45089,0;18.48,77.38,15,iau-15872
 *
 * Cada punto es `lat,lon,minutos[,id de lugar]`, en orden: hábitat, paradas,
 * destino. `ret=0` = solo ida; sin `ret`, la travesía vuelve al hábitat. El texto de las tareas no viaja (alarga el enlace y no cambia el
 * cálculo). La carga sí: `kit=drill,camera` (ids de domain/equipment.ts) y
 * `kg=5` (carga libre), también sin puntos: la carga es de la EVA, no de la
 * travesía. Este módulo no importa los stores: store.ts lo usa al arrancar.
 */
import { clampExtraKg, isEquipmentId } from "../domain/equipment";
import type { LatLon } from "../mars/geo";

export interface SharedPoint extends LatLon {
  readonly dwellMin: number;
  readonly placeId: string | null;
}

export interface SharedPlan {
  readonly departAt: Date | null;
  readonly roundTrip: boolean;
  readonly points: readonly SharedPoint[];
  /** Equipo elegido (ids de EQUIPMENT) y carga libre en kg. */
  readonly kit: readonly string[];
  readonly extraKg: number;
}

export interface SharedCargo {
  readonly kit: readonly string[];
  readonly extraKg: number;
}

/** Tope de puntos que se aceptan de un enlace: más que esto no es una EVA. */
const MAX_POINTS = 25;
const DECIMALS = 6; // 1e-6° ≈ 6 cm en Marte
// Letras y números de cualquier idioma (places.py arma ids como `target-señal`); nunca `,` ni `;`,
// que separan campos y puntos.
const PLACE_ID = /^[\p{L}\p{N}_.-]{1,64}$/u;

function search(): URLSearchParams | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search);
}

export function siteFromUrl(): string | null {
  const site = search()?.get("site");
  return site && /^[a-z0-9_-]{1,32}$/.test(site) ? site : null;
}

export function encodePlan(
  siteId: string,
  departAt: Date,
  points: readonly SharedPoint[],
  roundTrip: boolean,
  cargo: SharedCargo = { kit: [], extraKg: 0 },
): string {
  const q = new URLSearchParams({ site: siteId, depart: departAt.toISOString() });
  if (!roundTrip) q.set("ret", "0");
  setCargo(q, cargo);
  if (points.length > 0) {
    q.set(
      "pts",
      points
        .map((p) => {
          const base = [p.lat.toFixed(DECIMALS), p.lon.toFixed(DECIMALS), String(p.dwellMin)];
          return (p.placeId ? [...base, p.placeId] : base).join(",");
        })
        .join(";"),
    );
  }
  return `?${q.toString()}`;
}

/**
 * Enlace sin travesía: solo el sitio y la carga. Sin `depart`, para que
 * recargar no deje fija una hora vieja.
 */
export function encodeSite(siteId: string, cargo: SharedCargo = { kit: [], extraKg: 0 }): string {
  const q = new URLSearchParams({ site: siteId });
  setCargo(q, cargo);
  return `?${q.toString()}`;
}

function setCargo(q: URLSearchParams, cargo: SharedCargo): void {
  if (cargo.kit.length > 0) q.set("kit", cargo.kit.join(","));
  if (cargo.extraKg > 0) q.set("kg", String(cargo.extraKg));
}

/** Lee la travesía de un query string. Lo que no se entiende se descarta, no se adivina. */
export function decodePlan(qs: string): SharedPlan {
  const q = new URLSearchParams(qs);
  const depart = q.get("depart");
  const d = depart ? new Date(depart) : null;
  const points: SharedPoint[] = [];
  for (const chunk of (q.get("pts") ?? "").split(";")) {
    if (points.length >= MAX_POINTS) break;
    const [lat, lon, dwell, placeId] = chunk.split(",");
    const p = { lat: Number(lat), lon: Number(lon), dwellMin: Number(dwell ?? 0) };
    if (!lat || !lon || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue;
    points.push({
      ...p,
      dwellMin: Number.isFinite(p.dwellMin) ? Math.min(Math.max(0, Math.round(p.dwellMin)), 24 * 60) : 0,
      placeId: placeId && PLACE_ID.test(placeId) ? placeId : null,
    });
  }
  const kit = [...new Set((q.get("kit") ?? "").split(",").filter(isEquipmentId))];
  const kg = Number(q.get("kg") ?? 0);
  return {
    departAt: d && !Number.isNaN(d.getTime()) ? d : null,
    roundTrip: q.get("ret") !== "0",
    points,
    kit,
    extraKg: clampExtraKg(kg),
  };
}

export function planFromUrl(): SharedPlan | null {
  const q = search();
  if (!q || !["pts", "depart", "kit", "kg"].some((k) => q.has(k))) return null;
  return decodePlan(q.toString());
}

/** Deja la travesía en la barra de direcciones sin sumar entradas al historial. */
export function writePlanToUrl(qs: string): void {
  if (typeof window === "undefined" || window.location.search === qs) return;
  window.history.replaceState(null, "", `${window.location.pathname}${qs}${window.location.hash}`);
}
