/**
 * Cliente de la API. Rutas SIEMPRE relativas (`/api/...`): en dev las proxea
 * vite al server real (VITE_API_TARGET), en producción las sirve nginx. El
 * mismo build funciona en los dos lados sin configurar nada.
 */
import {
  HealthSchema,
  RouteResponseSchema,
  RoverPhotosSchema,
  type RoverPhotos,
  type RouteRequest,
  type RouteResponse,
  SiteDetailSchema,
  SitesSchema,
  type Health,
  type SiteDetail,
  type Sites,
} from "./schemas";
import { fixtureHealth, fixtureSiteDetail, fixtureSites } from "./fixtures";
import { exampleRoute } from "./routeFixture";
import type { ZodType } from "zod";

/** `true` cuando no hay backend configurado: la UI tiene que avisarlo. */
export const usingFixtures = !import.meta.env["VITE_API_TARGET"];

async function get<T>(path: string, schema: ZodType<T>): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} respondió ${res.status}`);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    // El contrato cambió: que se vea acá y no como undefined tres capas arriba.
    throw new Error(`${path} no cumple el contrato: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function fetchHealth(): Promise<Health> {
  if (usingFixtures) return fixtureHealth;
  return get("/api/health", HealthSchema);
}

export async function fetchSites(): Promise<Sites> {
  if (usingFixtures) return fixtureSites;
  return get("/api/sites", SitesSchema);
}

export async function fetchSiteDetail(siteId: string): Promise<SiteDetail | null> {
  if (usingFixtures) return fixtureSiteDetail[siteId] ?? null;
  try {
    return await get(`/api/sites/${siteId}`, SiteDetailSchema);
  } catch {
    // 404 mientras la descarga no terminó: degradar, no romper.
    return null;
  }
}

/**
 * ¿Existe esta salida del pipeline? Las capas se prenden solo si el tile está.
 * Mientras MAP-9 no haya corrido, esto devuelve false y la capa queda en
 * "esperando pipeline" en vez de pintar un mapa vacío.
 */
export async function tileExists(url: string): Promise<boolean> {
  if (usingFixtures) return false;
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

export interface PlannedRoute {
  readonly route: RouteResponse;
  /**
   * true = la calculó el planificador de ejemplo del frontend, no el server.
   * La UI tiene que decirlo al lado del veredicto.
   */
  readonly example: boolean;
}

/**
 * Planifica una travesía. Sin backend, o mientras el server no tenga
 * /api/route (404/405/501), usa el planificador de ejemplo: degradar, no romper.
 * Cualquier otro error (contrato roto, 500) se muestra tal cual.
 */
export async function planRoute(req: RouteRequest, signal?: AbortSignal): Promise<PlannedRoute> {
  if (usingFixtures) return { route: exampleRoute(req), example: true };

  const res = await fetch("/api/route", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(req),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { route: exampleRoute(req), example: true };
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "detail" in body) detail = `: ${String(body.detail)}`;
    } catch {
      // sin cuerpo JSON
    }
    throw new Error(`/api/route respondió ${res.status}${detail}`);
  }
  const parsed = RouteResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`/api/route no cumple el contrato: ${parsed.error.message}`);
  }
  return { route: parsed.data, example: false };
}

/**
 * Fotos reales del rover más cercanas a un punto (MAP-33). Sin backend, o
 * mientras el endpoint no exista, devuelve la lista vacía con una nota: las
 * fotos tienen que ser reales, así que no hay fotos de ejemplo.
 */
export async function fetchRoverPhotos(
  siteId: string,
  p: { readonly lat: number; readonly lon: number },
  signal?: AbortSignal,
): Promise<RoverPhotos> {
  const missing: RoverPhotos = {
    photos: [],
    note: "Falta el endpoint de fotos del server (MAP-33): todavía no hay fotos reales para mostrar.",
  };
  if (usingFixtures) return missing;
  const qs = new URLSearchParams({ lat: String(p.lat), lon: String(p.lon) });
  const res = await fetch(`/api/sites/${siteId}/photos?${qs.toString()}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (res.status === 404 || res.status === 405 || res.status === 501) return missing;
  if (!res.ok) throw new Error(`fotos: el server respondió ${res.status}`);
  const parsed = RoverPhotosSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`fotos: no cumple el contrato: ${parsed.error.message}`);
  return parsed.data;
}
