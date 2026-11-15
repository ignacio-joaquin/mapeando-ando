/**
 * Qué dice terrain.json (pipeline/precompute.py) de cada capa del mapa.
 *
 * Una capa raster se puede prender solo si su COG salió bien Y sus tiles PNG
 * también; una vectorial, si su GeoJSON salió bien. Lo que el índice no
 * menciona (ortoimagen, capas de supervivencia) sigue esperando al pipeline.
 */
import type { TerrainIndex, TerrainLayer, TileSet } from "../api/schemas";
import type { LayerSpec } from "./layers";
import { getT } from "../i18n";

export type ReadyTiles = Extract<TileSet, { status: "ok" }>;

export function terrainLayer(terrain: TerrainIndex | null, id: string): TerrainLayer | null {
  return terrain?.layers[id] ?? null;
}

/** Tiles listos de una capa raster, o null si todavía no hay. */
export function readyTiles(terrain: TerrainIndex | null, id: string): ReadyTiles | null {
  const tiles = terrainLayer(terrain, id)?.tiles;
  return tiles?.status === "ok" ? tiles : null;
}

/**
 * true / false según terrain.json. null = el índice no habla de esta capa y
 * hay que averiguarlo de otro modo (o seguir esperando).
 */
export function availableFromTerrain(spec: LayerSpec, terrain: TerrainIndex | null): boolean | null {
  const layer = terrainLayer(terrain, spec.id);
  if (!layer) return null;
  if (layer.status !== "ok") return false;
  return spec.kind === "vector" || readyTiles(terrain, spec.id) !== null;
}

/** Por qué el pipeline no pudo generar la capa, si lo intentó y falló. */
export function pipelineError(terrain: TerrainIndex | null, id: string): string | null {
  const layer = terrainLayer(terrain, id);
  if (!layer) return null;
  if (layer.status === "error") return layer.error ?? getT().layerStack.noErrorDetail;
  if (layer.tiles?.status === "error") return `tiles: ${layer.tiles.error}`;
  return null;
}
