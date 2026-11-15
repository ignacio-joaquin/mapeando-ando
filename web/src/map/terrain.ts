/**
 * Qué dice terrain.json (pipeline/precompute.py) de cada capa del mapa.
 *
 * Una capa se puede prender solo si su salida salió bien Y sus tiles también
 * (PNG las raster, MVT las vectoriales). Una vectorial de una corrida de antes
 * de los tiles se puede prender igual con su GeoJSON (`spec.geojson`). Lo que el
 * índice no menciona (ortoimagen, capas de supervivencia) sigue esperando al
 * pipeline.
 */
import type { TerrainIndex, TerrainLayer, TileSet } from "../api/schemas";
import type { LayerSpec } from "./layers";

export type ReadyTiles = Extract<TileSet, { status: "ok" }>;

export function terrainLayer(terrain: TerrainIndex | null, id: string): TerrainLayer | null {
  return terrain?.layers[id] ?? null;
}

/** Tiles listos de una capa, o null si todavía no hay. */
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
  return readyTiles(terrain, spec.id) !== null || (spec.geojson !== undefined && !layer.tiles);
}

/** Por qué el pipeline no pudo generar la capa, si lo intentó y falló. */
export function pipelineError(terrain: TerrainIndex | null, id: string): string | null {
  const layer = terrainLayer(terrain, id);
  if (!layer) return null;
  if (layer.status === "error") return layer.error ?? "error sin detalle";
  if (layer.tiles?.status === "error") return `tiles: ${layer.tiles.error}`;
  return null;
}
