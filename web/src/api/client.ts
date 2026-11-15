/**
 * Cliente de la API. Rutas SIEMPRE relativas (`/api/...`): en dev las proxea
 * vite al server real (VITE_API_TARGET), en producción las sirve nginx en el
 * mismo origen. El build de producción no necesita ninguna variable.
 */
import {
  HealthSchema,
  IlluminationCatalogSchema,
  SolTilesSchema,
  type IlluminationCatalog,
  type SolTiles,
  PointSchema,
  type PointInfo,
  RouteResponseSchema,
  RoverPhotosSchema,
  type RoverPhotos,
  type RouteRequest,
  type RouteResponse,
  SiteDetailSchema,
  SitesSchema,
  TerrainIndexSchema,
  type TerrainIndex,
  type Health,
  type SiteDetail,
  type Sites,
} from "./schemas";
import { fixtureHealth, fixtureSiteDetail, fixtureSites } from "./fixtures";
import { exampleRoute } from "./routeFixture";
import type { ZodType } from "zod";

/**
 * `true` cuando no hay backend: la UI tiene que avisarlo.
 *
 * Solo en desarrollo (`npm run dev`) sin VITE_API_TARGET. El build de
 * producción NUNCA usa fixtures: nginx sirve /api en el mismo origen.
 * OJO: no leer VITE_API_TARGET acá. Vite incrusta en el JS público las
 * variables VITE_* que usa el código, y con ella iría la IP del server; por
 * eso vite.config.ts pasa solo el booleano __API_PROXY__.
 */
export const usingFixtures = import.meta.env.DEV && !__API_PROXY__;

/**
 * Mensaje legible de un error de FastAPI. `detail` es un texto en los
 * HTTPException, pero una lista de objetos en los 422 de validación (que sin
 * esto se mostraban como "[object Object]").
 */
async function errorDetail(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return ""; // sin cuerpo JSON
  }
  if (!body || typeof body !== "object" || !("detail" in body)) return "";
  const { detail } = body;
  if (typeof detail === "string") return `: ${detail}`;
  if (Array.isArray(detail)) {
    const msgs = detail.map((d: unknown) => {
      if (d && typeof d === "object" && "msg" in d) {
        const loc = "loc" in d && Array.isArray(d.loc) ? ` (${d.loc.join(".")})` : "";
        return `${String(d.msg)}${loc}`;
      }
      return JSON.stringify(d);
    });
    return `: ${msgs.join("; ")}`;
  }
  return `: ${JSON.stringify(detail)}`;
}

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
 * Qué hay en un punto del mapa. Sin backend no hay nada que consultar: devuelve
 * null y el inspector lo dice, en vez de inventar una elevación.
 */
export async function fetchPoint(
  siteId: string,
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<PointInfo | null> {
  if (usingFixtures) return null;
  const q = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  const res = await fetch(`/api/sites/${siteId}/point?${q}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) return null;
  const parsed = PointSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`/api/sites/${siteId}/point no cumple el contrato: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Índice de las capas del sitio que ya generó el pipeline. Junta dos archivos
 * con el mismo formato: terrain.json (relieve, pipeline/precompute.py) y
 * shelter.json (refugios, pipeline/shelter.py). null = no corrió ninguno: las
 * capas quedan esperando.
 *
 * Si uno de los dos falla (500, JSON roto o no pasa el schema), las capas del
 * otro siguen andando y el problema va a `warnings`: un índice roto no apaga
 * las capas del otro. Solo si fallan los dos (o falla uno y el otro no existe)
 * no hay nada que dibujar y se tira el error.
 */
export async function fetchTerrain(siteId: string): Promise<TerrainIndex | null> {
  if (usingFixtures) return null;
  const asError = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const [relief, shelter] = await Promise.all(
    ["terrain.json", "shelter.json"].map((file) => fetchLayerIndex(siteId, file).catch(asError)),
  );
  const errors = [relief, shelter].filter((r): r is string => typeof r === "string");
  const indexes = [relief, shelter].filter((r): r is TerrainIndex => r !== null && typeof r !== "string");
  const [base] = indexes;
  if (!base) {
    if (errors.length) throw new Error(errors.join(" · "));
    return null;
  }
  return {
    ...base,
    // MapView rearma las fuentes cuando cambia: tiene que cambiar si corre cualquiera de los dos.
    generated_at: indexes.map((i) => i.generated_at).join(" + "),
    // Los ids no se repiten entre los dos archivos (shelter.py usa los suyos).
    layers: indexes.reduce<TerrainIndex["layers"]>((all, i) => ({ ...all, ...i.layers }), {}),
    warnings: [...indexes.flatMap((i) => i.warnings), ...errors],
  };
}

/**
 * Un índice del pipeline. `no-cache` porque nginx manda `expires 1h` en
 * /tiles/ y, después de volver a correr el pipeline, el navegador seguiría con
 * el índice viejo.
 */
async function fetchLayerIndex(siteId: string, file: string): Promise<TerrainIndex | null> {
  const path = `/tiles/${siteId}/${file}`;
  const res = await fetch(path, { headers: { accept: "application/json" }, cache: "no-cache" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} respondió ${res.status}`);
  const parsed = TerrainIndexSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`${path} no cumple el contrato: ${parsed.error.message}`);
  }
  return parsed.data;
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
    throw new Error(`/api/route respondió ${res.status}${await errorDetail(res)}`);
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
  if (!res.ok) throw new Error(`fotos: el server respondió ${res.status}${await errorDetail(res)}`);
  const parsed = RoverPhotosSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`fotos: no cumple el contrato: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Catálogo de soles con sombras precomputadas (pipeline/shadow_tiles.py).
 * null = el pipeline todavía no lo generó para este sitio. `no-cache` por lo
 * mismo que terrain.json: nginx cachea /tiles/ una hora.
 */
export async function fetchIlluminationCatalog(siteId: string): Promise<IlluminationCatalog | null> {
  if (usingFixtures) return null;
  const path = `/tiles/${siteId}/illumination/catalog.json`;
  const res = await fetch(path, { headers: { accept: "application/json" }, cache: "no-cache" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} respondió ${res.status}`);
  const parsed = IlluminationCatalogSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`${path} no cumple el contrato: ${parsed.error.message}`);
  return parsed.data;
}

/** tiles.json de un sol: qué horas están teseladas y con qué zoom. */
export async function fetchSolTiles(siteId: string, relPath: string): Promise<SolTiles> {
  const path = `/tiles/${siteId}/illumination/${relPath}`;
  const res = await fetch(path, { headers: { accept: "application/json" }, cache: "no-cache" });
  if (!res.ok) throw new Error(`${path} respondió ${res.status}`);
  const parsed = SolTilesSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`${path} no cumple el contrato: ${parsed.error.message}`);
  return parsed.data;
}
