/**
 * Cliente de la API. Rutas SIEMPRE relativas (`/api/...`): en dev las proxea
 * vite al server real (VITE_API_TARGET), en producción las sirve nginx. El
 * mismo build funciona en los dos lados sin configurar nada.
 */
import {
  HealthSchema,
  SiteDetailSchema,
  SitesSchema,
  type Health,
  type SiteDetail,
  type Sites,
} from "./schemas";
import { fixtureHealth, fixtureSiteDetail, fixtureSites } from "./fixtures";
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
