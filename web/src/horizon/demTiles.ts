/**
 * Alturas desde los tiles raster-dem que escribe el pipeline (`relief-dem` del
 * DTM y `relief-far` del DEM global de 200 m; ver docs/context.md §4).
 *
 * Son los mismos PNG que dibuja MapLibre: lon/lat de Marte etiquetado como
 * EPSG:4326 y teselado como Web Mercator (pipeline/tiles.py). Acá se
 * decodifican a metros para armar el horizonte; son solo para dibujar.
 */
import type { TerrainLayer } from "../api/schemas";
import { MARS_RADIUS_M } from "../mars/constants";

const DEG = Math.PI / 180;

export interface DemTileSet {
  readonly id: string;
  /** URL con {z}/{x}/{y}. */
  readonly template: string;
  readonly minzoom: number;
  readonly maxzoom: number;
  /** [oeste, sur, este, norte] */
  readonly bounds: readonly [number, number, number, number];
  readonly datum: number;
  readonly factors: readonly [number, number, number, number];
}

/** El tile set de una capa raster-dem de terrain.json, o null si no está lista. */
export function demTileSet(siteId: string, id: string, layer: TerrainLayer | null | undefined): DemTileSet | null {
  if (layer?.status !== "ok" || layer.tiles?.status !== "ok") return null;
  if (layer.datum_m == null || !layer.encoding) return null;
  const e = layer.encoding;
  const t = layer.tiles;
  return {
    id,
    template: `/tiles/${siteId}/${t.template}`,
    minzoom: t.minzoom,
    maxzoom: t.maxzoom,
    bounds: t.bounds,
    datum: layer.datum_m,
    factors: [e.red_factor, e.green_factor, e.blue_factor, e.base_shift],
  };
}

/** Coordenadas de tile (fraccionarias) de un lon/lat, como pipeline/tiles.py tile_de. */
export function tileXY(lon: number, lat: number, z: number): readonly [number, number] {
  const n = 2 ** z;
  const la = Math.max(Math.min(lat, 85.0511), -85.0511) * DEG;
  return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan(la)) / Math.PI) / 2) * n];
}

/** Metros de Marte por píxel de tile en un zoom y latitud (el ancho, el lado más corto). */
export function tilePixelM(z: number, lat: number, tilePx: number): number {
  return ((2 * Math.PI * MARS_RADIUS_M) / (2 ** z * tilePx)) * Math.cos(lat * DEG);
}

interface Tile {
  readonly size: number;
  /** Altura absoluta (m) por píxel; NaN = sin dato. */
  readonly h: Float32Array;
}

/**
 * Baja y decodifica tiles bajo demanda. Un tile que no está (404, fuera de los
 * límites) cuenta como sin dato, no como error: el horizonte se arma con lo que haya.
 */
export class DemSampler {
  private readonly tiles = new Map<string, Tile | null>();

  constructor(readonly set: DemTileSet) {}

  /** El zoom del set con el píxel más parecido a `spacingM` (sin pasarse del máximo). */
  zoomFor(spacingM: number, lat: number): number {
    const z = Math.floor(Math.log2(tilePixelM(0, lat, 256) / Math.max(spacingM, 1e-3)));
    return Math.max(this.set.minzoom, Math.min(this.set.maxzoom, z));
  }

  covers(lon: number, lat: number): boolean {
    const [w, s, e, n] = this.set.bounds;
    return lon >= w && lon <= e && lat >= s && lat <= n;
  }

  /** Clave del tile que hace falta para muestrear ese punto en ese zoom. */
  tileKey(lon: number, lat: number, z: number): string | null {
    if (!this.covers(lon, lat)) return null;
    const [x, y] = tileXY(lon, lat, z);
    return `${z}/${Math.floor(x)}/${Math.floor(y)}`;
  }

  /** Baja los tiles pedidos, de a pocos por vez (nginx de una EC2 chica). */
  async load(keys: Iterable<string>, signal: AbortSignal, onProgress?: (done: number, total: number) => void) {
    const pending = [...new Set(keys)].filter((k) => !this.tiles.has(k));
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const key = pending[next++]!;
        this.tiles.set(key, await this.fetchTile(key, signal));
        onProgress?.(++done, pending.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  /** Altura absoluta (m) bilineal en ese zoom. NaN si no hay dato o el tile no se bajó. */
  sample(lon: number, lat: number, z: number): number {
    if (!this.covers(lon, lat)) return NaN;
    const [fx, fy] = tileXY(lon, lat, z);
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const tile = this.tiles.get(`${z}/${tx}/${ty}`);
    if (!tile) return NaN;
    const s = tile.size;
    // Centro de píxel en .5: mismo criterio que el remuestreo de GDAL.
    const px = Math.min(Math.max((fx - tx) * s - 0.5, 0), s - 1);
    const py = Math.min(Math.max((fy - ty) * s - 0.5, 0), s - 1);
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, s - 1);
    const y1 = Math.min(y0 + 1, s - 1);
    const ax = px - x0;
    const ay = py - y0;
    const h = tile.h;
    const a = h[y0 * s + x0]!;
    const b = h[y0 * s + x1]!;
    const c = h[y1 * s + x0]!;
    const d = h[y1 * s + x1]!;
    // Un vecino sin dato alcanza para no inventar: el borde de la huella queda como hueco.
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
  }

  private async fetchTile(key: string, signal: AbortSignal): Promise<Tile | null> {
    const [z, x, y] = key.split("/");
    const url = this.set.template.replace("{z}", z!).replace("{x}", x!).replace("{y}", y!);
    const res = await fetch(url, { signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${this.set.id}: HTTP ${res.status} en ${url}`);
    // Sin conversión de color ni premultiplicado: el RGB es la altura, no un color.
    const bmp = await createImageBitmap(await res.blob(), {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    const size = bmp.width;
    const ctx = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("El navegador no deja leer píxeles (OffscreenCanvas 2D)");
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const [fr, fg, fb, shift] = this.set.factors;
    const h = new Float32Array(size * size);
    for (let i = 0; i < h.length; i++) {
      const r = rgba[i * 4]!;
      const g = rgba[i * 4 + 1]!;
      const b = rgba[i * 4 + 2]!;
      // RGB 0 es lo que el pipeline escribe fuera de la huella (codificar_relieve): sin dato.
      h[i] = r === 0 && g === 0 && b === 0 ? NaN : r * fr + g * fg + b * fb - shift + this.set.datum;
    }
    return { size, h };
  }
}
