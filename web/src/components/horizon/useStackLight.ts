import { useEffect, useState } from "react";
import { fetchPointIllumination, fetchSolTiles, type PointIllumination } from "../../api/client";
import type { SolTiles } from "../../api/schemas";
import type { SourceInfo } from "../../domain/provenance";
import { SOL_REUSE_MAX_DLS_DEG, frameAt, pickSol, reuseAssumptions, shiftSolTiles } from "../../map/sun";
import { useSun } from "../../state/sun";
import { tNow } from "../../i18n/lang";

/**
 * ¿Le da el Sol a este punto? Según la pila de sombras precomputada
 * (pipeline/illumination.py: SPICE sobre el DTM de 1 m), que es el mismo dato
 * que usan el veredicto del planificador y el deslizador del sol. Así la vista
 * del horizonte nunca contradice al planificador.
 *
 * Elige el sol con pickSol y la hora con frameAt (la máscara más cercana, sin
 * interpolar), igual que el deslizador, y le pide a la API el valor en el
 * punto. Si no hay pila para esa hora, devuelve "missing" con el motivo y la
 * vista cae a su propia estimación con el relieve, declarada MODELED.
 *
 * El sol se elige con la longitud del punto y no con la del centro del sitio:
 * la medianoche local se corre unos minutos, que solo pesan si la hora cae
 * justo entre dos máscaras.
 */
export type StackLight =
  | { readonly kind: "pending" }
  | {
      readonly kind: "ok";
      readonly lit: boolean;
      /** Hora LTST de la máscara usada. */
      readonly ltst: string;
      /** Minutos entre la hora pedida y la de la máscara. */
      readonly offsetMin: number;
      readonly source: SourceInfo;
    }
  | { readonly kind: "missing"; readonly reason: string };

type SolTilesLoad = { readonly path: string; readonly data: SolTiles } | { readonly path: string; readonly error: string };
type PointLoad = { readonly key: string; readonly result: PointIllumination };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useStackLight(siteId: string, lat: number, lon: number, when: Date): StackLight {
  const catalog = useSun((s) => s.catalog);
  const catalogLoad = useSun((s) => s.load);
  const pick = pickSol(catalog, when, lon);
  const tilesPath = pick?.sol.tiles ?? null;

  // 1. tiles.json del sol elegido: qué horas tienen máscara.
  const [solTiles, setSolTiles] = useState<SolTilesLoad | null>(null);
  useEffect(() => {
    if (!tilesPath) return;
    let alive = true;
    fetchSolTiles(siteId, tilesPath).then(
      (data) => {
        if (alive) setSolTiles({ path: tilesPath, data });
      },
      (e: unknown) => {
        if (alive) setSolTiles({ path: tilesPath, error: message(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [siteId, tilesPath]);

  const loaded = solTiles && solTiles.path === tilesPath ? solTiles : null;
  const tiles = loaded && "data" in loaded ? loaded.data : null;
  const shifted = tiles && pick?.reuse ? shiftSolTiles(tiles, pick.reuse.shiftMs) : tiles;
  const frame = shifted ? frameAt(shifted, when.getTime()) : null;
  const band = frame?.kind === "band" ? frame.band : null;
  const solTag = pick?.sol.tag ?? null;
  const bandNo = band?.band ?? null;
  const key = solTag !== null && bandNo !== null ? `${siteId}|${solTag}|${bandNo}|${lat}|${lon}` : null;

  // 2. El valor de la pila en el punto, para esa hora.
  const [point, setPoint] = useState<PointLoad | null>(null);
  useEffect(() => {
    if (key === null || solTag === null || bandNo === null) return;
    const ctl = new AbortController();
    fetchPointIllumination(siteId, solTag, bandNo, { lat, lon }, ctl.signal).then(
      (result) => {
        if (!ctl.signal.aborted) setPoint({ key, result });
      },
      (e: unknown) => {
        if (!ctl.signal.aborted) setPoint({ key, result: { kind: "missing", reason: message(e) } });
      },
    );
    return () => ctl.abort();
  }, [key, siteId, solTag, bandNo, lat, lon]);

  // 3. Qué se sabe, de lo más básico a lo más fino.
  if (!catalog) {
    if (catalogLoad.kind === "loading") return { kind: "pending" };
    if (catalogLoad.kind === "error") {
      return { kind: "missing", reason: tNow(`no se pudo leer el catálogo de sombras: ${catalogLoad.message}`, `could not read the shadow catalog: ${catalogLoad.message}`) };
    }
    return { kind: "missing", reason: tNow("el pipeline todavía no precomputó sombras para este sitio", "the pipeline has not precomputed shadows for this site yet") };
  }
  if (!pick) {
    return {
      kind: "missing",
      reason: tNow(
        `no hay sombras precomputadas para este sol ni para uno de la misma estación (|ΔLs| ≤ ${SOL_REUSE_MAX_DLS_DEG}°)`,
        `there are no precomputed shadows for this sol nor for one from the same season (|ΔLs| ≤ ${SOL_REUSE_MAX_DLS_DEG}°)`,
      ),
    };
  }
  if (!tilesPath) return { kind: "missing", reason: tNow(`las sombras del sol ${pick.sol.tag} están calculadas pero sin teselar`, `the shadows of sol ${pick.sol.tag} are computed but not tiled`) };
  if (!loaded) return { kind: "pending" };
  if ("error" in loaded) return { kind: "missing", reason: tNow(`no se pudieron leer las horas del sol: ${loaded.error}`, `could not read the hours of the sol: ${loaded.error}`) };
  if (frame?.kind === "night") {
    return { kind: "missing", reason: tNow("para la pila de sombras a esta hora ya es de noche (horizonte plano)", "for the shadow stack it is already night at this time (flat horizon)") };
  }
  if (!band || frame?.kind !== "band") return { kind: "missing", reason: tNow(`el sol ${pick.sol.tag} no tiene horas con máscara`, `sol ${pick.sol.tag} has no hours with a mask`) };
  if (!point || point.key !== key) return { kind: "pending" };
  if (point.result.kind === "missing") return point.result;

  const data = point.result.data;
  const value = data.values[0]?.[0] ?? null;
  if (value === null) {
    return { kind: "missing", reason: tNow(
        "la pila de sombras no tiene dato en este punto (sin horizonte completo o fuera del DTM)",
        "the shadow stack has no data at this point (no complete horizon or outside the DTM)",
      ) };
  }
  const reuse = pick.reuse;
  const source: SourceInfo = {
    provenance: reuse ? "MODELED" : data.provenance,
    mission: data.mission,
    instrument: data.instrument,
    resolution: data.resolution ?? undefined,
    source: reuse ? `${data.source ?? "pipeline/illumination.py"}, ${tNow("reutilizado por estación", "reused by season")}` : data.source,
    assumptions: [
      ...(data.assumptions ?? []),
      ...(reuse ? reuseAssumptions(reuse) : []),
      tNow(
        `Máscara de las ${band.ltst} LTST, la hora precomputada más cercana: no se interpola entre horas`,
        `Mask for ${band.ltst} LTST, the nearest precomputed hour: no interpolation between hours`,
      ),
    ],
  };
  return { kind: "ok", lit: value, ltst: band.ltst, offsetMin: frame.offsetMin, source };
}
