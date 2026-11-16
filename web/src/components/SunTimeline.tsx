import { useEffect, useRef } from "react";
import { fetchIlluminationCatalog, fetchSolTiles } from "../api/client";
import type { CatalogSol, SolTiles } from "../api/schemas";
import { MARS24_LTST, type SourceInfo } from "../domain/provenance";
import {
  SHADOWS_LAYER_ID,
  SOL_REUSE_MAX_DLS_DEG,
  type SolReuse,
  type TimeRange,
  clamp,
  daylightRange,
  flatCrossings,
  formatDeg,
  frameAt,
  okBands,
  pickSol,
  reuseAssumptions,
  shiftSolTiles,
  tileGroundM,
  timelineRange,
} from "../map/sun";
import { usePlan } from "../state/plan";
import { useStore } from "../state/store";
import { useSun } from "../state/sun";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { earthShort, ltstShort } from "./route/format";
import { useT, useTr, type T } from "../i18n/lang";

/**
 * Deslizador de tiempo del sol: hace visible el 4D. Recorre el sol de la hora
 * de salida, de medianoche a medianoche local; al moverlo, el mapa cambia la
 * máscara de sombra de esa hora (capa "survival-shadows") o, de noche, pone un
 * velo sobre el sitio. "Reproducir" va de amanecer a atardecer.
 *
 * Las máscaras son por hora (pipeline/illumination.py + shadow_tiles.py). No se
 * interpola entre horas: se muestra la más cercana y se dice de qué hora es.
 */
const PLAY_MS = 5_000; // "el 4D en cinco segundos de demo"

interface Props {
  readonly siteId: string;
  /** Centro del sitio: la longitud da la hora solar local; la latitud, el tamaño real del píxel dibujado. */
  readonly lat: number;
  readonly lon: number;
}

/** El deslizador existe para mover sombras: si la capa está apagada, la prende. */
function showShadows() {
  const st = useStore.getState();
  const l = st.layers[SHADOWS_LAYER_ID];
  if (l?.available && !l.visible) st.toggleLayer(SHADOWS_LAYER_ID);
}

export function SunTimeline({ siteId, lat, lon }: Props) {
  const t = useT();
  const tr = useTr();
  const departAt = usePlan((s) => s.departAt);
  const catalog = useSun((s) => s.catalog);
  const sol = useSun((s) => s.sol);
  const reuse = useSun((s) => s.reuse);
  const load = useSun((s) => s.load);
  const time = useSun((s) => s.time);
  const playing = useSun((s) => s.playing);
  const { setCatalog, setSol, setLoad, setTime, setPlaying } = useSun.getState();
  const shadows = useStore((s) => s.layers[SHADOWS_LAYER_ID]);

  // 1. Catálogo de soles del sitio.
  useEffect(() => {
    let alive = true;
    setCatalog(null);
    setSol(null);
    setTime(null);
    setLoad({ kind: "loading" });
    fetchIlluminationCatalog(siteId)
      .then((c) => {
        if (!alive) return;
        setCatalog(c);
        setLoad({ kind: "idle" });
      })
      .catch((e: unknown) => {
        if (alive) setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [siteId, setCatalog, setSol, setTime, setLoad]);

  // 2. El sol de la hora de salida (o uno de la misma estación, llevado a esa
  //    fecha: mismo criterio que el veredicto) y su tiles.json.
  const pick = pickSol(catalog, departAt, lon);
  const target = pick?.sol ?? null;
  const pickReuse = pick?.reuse ?? null;
  const targetTiles = target?.tiles ?? null;
  const targetTag = target?.tag ?? null;
  // Al minuto: dos salidas en el mismo sol dan el mismo corrimiento salvo ruido numérico.
  const shiftKey = pickReuse ? Math.round(pickReuse.shiftMs / 60_000) : 0;
  useEffect(() => {
    if (!targetTiles) {
      setSol(null);
      return;
    }
    const cur = useSun.getState();
    const curShift = cur.reuse ? Math.round(cur.reuse.shiftMs / 60_000) : 0;
    if (cur.sol?.sol_tag === targetTag && curShift === shiftKey) return;
    let alive = true;
    fetchSolTiles(siteId, targetTiles)
      .then((s) => {
        if (alive) setSol(pickReuse ? shiftSolTiles(s, pickReuse.shiftMs) : s, pickReuse);
      })
      .catch((e: unknown) => {
        if (alive) setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
    // `pickReuse` va por `shiftKey`: es un objeto nuevo en cada render.
  }, [siteId, targetTiles, targetTag, shiftKey, setSol, setLoad]);

  // 3. La hora de salida mueve el deslizador (y cambiar de sol lo ubica). Si la
  //    salida es de noche, el deslizador queda de noche: no salta al amanecer.
  const range = sol ? timelineRange(sol) : null;
  const rangeKey = range ? `${range.start}-${range.end}` : "";
  useEffect(() => {
    const r = useSun.getState().sol ? timelineRange(useSun.getState().sol!) : null;
    setTime(r ? clamp(departAt.getTime(), r) : null);
  }, [departAt, rangeKey, setTime]);

  // 4. La capa de sombras se puede prender solo si hay horas teseladas.
  const hasTiles = sol !== null && okBands(sol).length > 0;
  useEffect(() => {
    const l = useStore.getState().layers[SHADOWS_LAYER_ID];
    if (l && l.available !== hasTiles) useStore.getState().setAvailable(SHADOWS_LAYER_ID, hasTiles);
  }, [hasTiles, shadows?.available]);

  // 5. Reproducir: amanecer → atardecer en cinco segundos. Arranca desde donde
  //    está el deslizador si es de día; si no, desde el amanecer.
  const day = sol ? daylightRange(sol) : null;
  const dayKey = day ? `${day.start}-${day.end}` : "";
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !day) return;
    const from = time !== null && time >= day.start && time < day.end - 60_000 ? time : day.start;
    const t0 = performance.now();
    const span = day.end - from;
    const total = (PLAY_MS * span) / (day.end - day.start);
    const step = (now: number) => {
      const f = Math.min(1, (now - t0) / total);
      setTime(from + f * span);
      if (f < 1) raf.current = requestAnimationFrame(step);
      else setPlaying(false);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
    // `time` queda afuera a propósito: es el punto de partida, no un disparador.
  }, [playing, dayKey]);

  return (
    <section
      data-edu="sun-timeline"
      aria-label={t("Deslizador de tiempo del sol", "Sun time slider")}
      className="border-t border-line bg-panel/40 px-3 py-2"
    >
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Sol y sombra", "Sun and shadow")}
          {sol ? (
            <span className="ml-2 font-normal normal-case">
              {reuse
                ? t(`sombras del sol ${sol.sol_tag}, reutilizado`, `shadows from sol ${sol.sol_tag}, reused`)
                : `sol ${sol.sol_tag}`}
            </span>
          ) : null}
          {reuse ? (
            <span className="ml-2 font-normal normal-case">Ls {formatDeg(reuse.targetLs)}°</span>
          ) : sol?.sol.ls_deg != null ? (
            <span className="ml-2 font-normal normal-case">Ls {formatDeg(sol.sol.ls_deg)}°</span>
          ) : null}
        </h2>
        {sol ? <ProvenanceBadge source={tilesSource(sol, lat, reuse, t)} /> : null}
      </div>

      {sol && reuse ? (
        <p className="mb-1 text-[11px] text-warn">
          {t(
            `⚠ Estimado: no hay sombras calculadas para este sol. Se muestran las del sol ${reuse.sourceTag}, de la misma estación (ΔLs ${formatDeg(reuse.dls, 1, true)}°, declinación del Sol ${formatDeg(reuse.ddecl, 2)}° distinta), a la misma hora solar local.`,
            `⚠ Estimate: there are no shadows computed for this sol. Showing those of sol ${reuse.sourceTag}, from the same season (ΔLs ${formatDeg(reuse.dls, 1, true)}°, Sun declination differs by ${formatDeg(reuse.ddecl, 2)}°), at the same local solar time.`,
          )}
        </p>
      ) : null}

      {load.kind === "error" ? (
        <p className="text-[11px] text-alert">
          {t("No se pudo leer la pila de sombras.", "Could not read the shadow stack.")} {tr(load.message)}
        </p>
      ) : load.kind === "loading" ? (
        <p className="text-[11px] text-muted">{t("Buscando la pila de sombras…", "Looking for the shadow stack…")}</p>
      ) : !catalog ? (
        <p className="text-[11px] text-warn">
          {t(
            <>
              Falta la pila de sombras de este sitio. La generan <code>pipeline/illumination.py</code> y{" "}
              <code>pipeline/shadow_tiles.py</code> en el server.
            </>,
            <>
              This site's shadow stack is missing. It is generated by <code>pipeline/illumination.py</code> and{" "}
              <code>pipeline/shadow_tiles.py</code> on the server.
            </>,
          )}
        </p>
      ) : !target ? (
        <NoSolForDeparture sols={catalog.sols} />
      ) : !target.tiles ? (
        <p className="text-[11px] text-warn">
          {t(`El sol ${target.tag} está calculado pero sin teselar: falta correr `, `Sol ${target.tag} is computed but not tiled: run `)}
          <code>pipeline/shadow_tiles.py --sol {target.tag}</code>.
        </p>
      ) : !sol || !range || time === null ? (
        <p className="text-[11px] text-muted">
          {t(`Cargando las horas del sol ${target.tag}…`, `Loading the hours of sol ${target.tag}…`)}
        </p>
      ) : (
        <Timeline sol={sol} range={range} time={time} lon={lon} playing={playing} shadowsOn={shadows?.visible ?? false} />
      )}
    </section>
  );
}

function tilesSource(sol: SolTiles, lat: number, reuse: SolReuse | null, t: T): SourceInfo {
  const p = sol.provenance;
  // Lo que se ve no es la resolución de la pila: los tiles llegan hasta un zoom
  // y, más cerca, el mapa agranda el último nivel.
  const z = Math.max(0, ...okBands(sol).map((b) => b.maxzoom ?? 0));
  const drawn =
    z > 0
      ? [
          t(
            `Se dibuja con tiles hasta z${z} (~${tileGroundM(z, lat).toFixed(1)} m/px); más cerca, el mapa agranda el último nivel`,
            `Drawn with tiles up to z${z} (~${tileGroundM(z, lat).toFixed(1)} m/px); closer in, the map enlarges the last level`,
          ),
        ]
      : [];
  return {
    // Las sombras de otro sol no son las de este: es una estimación.
    provenance: reuse ? "MODELED" : p.provenance,
    mission: p.mission,
    instrument: p.instrument,
    ...(p.resolution ? { resolution: p.resolution } : {}),
    ...(p.source ? { source: reuse ? `${p.source} · ${t("reutilizado por estación", "reused by season")}` : p.source } : {}),
    assumptions: [
      ...(p.assumptions ?? []),
      ...(reuse ? reuseAssumptions(reuse) : []),
      t("Una máscara por hora; entre horas se muestra la más cercana", "One mask per hour; between hours the nearest is shown"),
      t("Noche: Sol bajo el horizonte plano", "Night: Sun below the flat horizon"),
      ...drawn,
    ],
  };
}

function NoSolForDeparture({ sols }: { readonly sols: readonly CatalogSol[] }) {
  const setDepartAt = usePlan((s) => s.setDepartAt);
  const usable = sols.filter((s) => s.tiles);
  const t = useT();
  return (
    <div className="text-[11px]">
      <p className="text-warn">
        {t(
          `No hay sombras precomputadas para el sol de la hora de salida, ni para uno de la misma estación (±${SOL_REUSE_MAX_DLS_DEG}° Ls). Elegí una salida en un sol calculado:`,
          `There are no precomputed shadows for the departure sol, nor for one from the same season (±${SOL_REUSE_MAX_DLS_DEG}° Ls). Pick a departure on a computed sol:`,
        )}
      </p>
      {usable.length === 0 ? (
        <p className="mt-1 text-muted">{t("Ningún sol de este sitio está teselado todavía.", "No sol of this site is tiled yet.")}</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {usable.map((s) => (
            <li key={s.tag}>
              <button
                type="button"
                onClick={() => {
                  // Una hora después del amanecer, o el comienzo del sol si no lo trae.
                  const base = s.flat_sunrise ? new Date(s.flat_sunrise.utc).getTime() + 3_600_000 : new Date(s.start_utc).getTime();
                  setDepartAt(new Date(base));
                }}
                className="rounded border border-line px-2 py-0.5 text-fg hover:border-rust"
              >
                sol {s.tag}
                {s.ls_deg != null ? <span className="text-muted"> · Ls {formatDeg(s.ls_deg)}°</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Timeline({
  sol,
  range,
  time,
  lon,
  playing,
  shadowsOn,
}: {
  readonly sol: SolTiles;
  readonly range: TimeRange;
  readonly time: number;
  readonly lon: number;
  readonly playing: boolean;
  readonly shadowsOn: boolean;
}) {
  const { setTime, setPlaying } = useSun.getState();
  const setDepartAt = usePlan((s) => s.setDepartAt);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const t = useT();
  const frame = frameAt(sol, time);
  const bands = okBands(sol);
  const { rise, set } = flatCrossings(sol);
  const span = range.end - range.start;
  const pos = (t: number) => `${(((t - range.start) / span) * 100).toFixed(2)}%`;
  const at = new Date(time);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (!playing) showShadows();
            setPlaying(!playing);
          }}
          aria-label={playing ? t("Pausar", "Pause") : t("Reproducir de amanecer a atardecer", "Play from sunrise to sunset")}
          className="rounded border border-rust bg-rust/15 px-2 py-0.5 text-xs text-fg"
        >
          {playing ? t("❚❚ pausa", "❚❚ pause") : t("▶ amanecer → atardecer", "▶ sunrise → sunset")}
        </button>
        <span className="font-mono text-base text-rust">{ltstShort(at, lon)}</span>
        <span className="text-[11px] text-muted">LTST</span>
        <ProvenanceBadge source={MARS24_LTST} align="left" />
        <span className="text-[11px] text-muted">
          ({earthShort(at)} {t("hora Tierra", "Earth time")})
        </span>
        <span className="ml-auto flex gap-1.5">
          {!shadowsOn ? (
            <button
              type="button"
              onClick={() => toggleLayer(SHADOWS_LAYER_ID)}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-fg hover:border-rust"
            >
              {t("mostrar sombras en el mapa", "show shadows on the map")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setDepartAt(new Date(time))}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-fg hover:border-rust"
            title={t("Pone esta hora como salida del planificador y recalcula la ruta", "Sets this time as the planner's departure and recalculates the route")}
          >
            {t("usar como hora de salida", "use as departure time")}
          </button>
        </span>
      </div>

      {/* Pista: franjas de noche y barras con el % del sitio al sol en cada hora (con terreno). */}
      <div className="relative">
        <div aria-hidden className="relative h-6 overflow-hidden rounded bg-bg">
          {rise !== null ? (
            <span className="absolute inset-y-0 left-0 bg-line" style={{ width: pos(rise) }} />
          ) : null}
          {set !== null ? (
            <span className="absolute inset-y-0 right-0 bg-line" style={{ left: pos(set) }} />
          ) : null}
          {bands.map((b) => (
            <span
              key={b.band}
              title={`${b.ltst} LTST · ${(b.lit_fraction * 100).toFixed(0)} % ${t("del sitio al sol", "of the site in sunlight")}`}
              className="absolute bottom-0 w-1.5 -translate-x-1/2 rounded-t-sm bg-warn/70"
              style={{ left: pos(new Date(b.utc).getTime()), height: `${Math.max(4, b.lit_fraction * 100)}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          min={range.start}
          max={range.end}
          step={60_000}
          value={time}
          onChange={(e) => {
            setPlaying(false);
            showShadows();
            setTime(Number(e.target.value));
          }}
          aria-label={t("Hora del sol", "Sun time")}
          aria-valuetext={`${ltstShort(at, lon)} ${t("hora solar local", "local solar time")}${frame.kind === "night" ? t(", de noche", ", night") : ""}`}
          className="w-full accent-rust"
        />
        <div className="flex justify-between gap-2 text-[10px] text-muted">
          <span>00:00</span>
          <span className="text-center">
            {t("amanecer", "sunrise")} {sol.sol.flat_sunrise?.ltst ?? "—"} · {t("atardecer", "sunset")}{" "}
            {sol.sol.flat_sunset?.ltst ?? "—"} LTST, {t("con horizonte plano", "with a flat horizon")}
          </span>
          <span>24:00</span>
        </div>
        <p className="text-[10px] text-muted">
          {t(
            "Franjas oscuras: noche. Barras: % del sitio al sol, con el relieve; por el relieve, en partes del sitio el sol sale más tarde y se pone antes que con horizonte plano.",
            "Dark bands: night. Bars: % of the site in sunlight, with the terrain; because of the terrain, in parts of the site the Sun rises later and sets earlier than with a flat horizon.",
          )}
        </p>
      </div>

      <p className="text-[11px]">
        {frame.kind === "night" ? (
          <span className="text-warn">
            {t(
              "☾ De noche (Sol bajo el horizonte plano): todo el sitio en sombra.",
              "☾ Night (Sun below the flat horizon): the whole site is in shadow.",
            )}
          </span>
        ) : frame.kind === "none" ? (
          <span className="text-warn">{t("No hay máscara teselada para este sol.", "There is no tiled mask for this sol.")}</span>
        ) : (
          <>
            <span className="text-fg">{t(`Máscara de las ${frame.band.ltst} LTST`, `Mask for ${frame.band.ltst} LTST`)}</span>
            {frame.offsetMin !== 0 ? (
              <span className="text-muted">{t(" (la más cercana: hay una máscara por hora)", " (the nearest: there is one mask per hour)")}</span>
            ) : null}
            <span className="text-muted">
              {" "}·{" "}
              {t(
                `Sol a ${frame.band.sun_el_deg.toFixed(0)}° de altura, azimut ${frame.band.sun_az_deg.toFixed(0)}° · ${(frame.band.lit_fraction * 100).toFixed(0)} % del sitio al sol`,
                `Sun at ${frame.band.sun_el_deg.toFixed(0)}° elevation, azimuth ${frame.band.sun_az_deg.toFixed(0)}° · ${(frame.band.lit_fraction * 100).toFixed(0)} % of the site in sunlight`,
              )}
            </span>
          </>
        )}
      </p>
      <p className="text-[10px] text-muted">
        {t(
          "Ventana de comunicaciones y envolvente de regreso: todavía no hay datos; se suman a esta línea de tiempo cuando existan.",
          "Communications window and return envelope: no data yet; they will be added to this timeline when they exist.",
        )}
      </p>
    </div>
  );
}
