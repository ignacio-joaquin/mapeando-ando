import { localeNow, tNow, useT, useTr } from "../../i18n/lang";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { RoverPhoto, TerrainLayer } from "../../api/schemas";
import type { DataValue, SourceInfo } from "../../domain/provenance";
import { DemSampler, demTileSet } from "../../horizon/demTiles";
import {
  buildHorizonMesh,
  EYE_HEIGHT_M,
  horizonAt,
  RADIAL_STEP,
  type BuildProgress,
  type HorizonMesh,
} from "../../horizon/mesh";
import { HorizonScene, SHADOW_RADIUS_M } from "../../horizon/scene";
import { formatLatLon } from "../../mars/geo";
import { formatMarsTime } from "../../mars/mars24";
import { SUN_SOURCE, sunPosition } from "../../mars/sunPosition";
import { useStore } from "../../state/store";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { creditFor } from "../route/StationPhoto";
import { useStackLight, type StackLight } from "./useStackLight";

/**
 * Horizonte en primera persona (MAP-43): el terreno real visto desde los ojos
 * de un astronauta parado en un punto, con el Sol donde está a esa hora.
 *
 * Es la base del modo HUD, la Postal y la comparación con la foto del rover:
 * por eso se puede abrir al lado de la foto y mirar desde el waypoint del rover.
 */
interface Props {
  readonly siteId: string;
  /** Nombre del punto, para el título ("Estación 2"). */
  readonly title: string;
  readonly lat: number;
  readonly lon: number;
  /** Instante de la vista (llegada a la estación o salida del plan). */
  readonly at: Date;
  /** Foto del rover para comparar, si la ficha tiene una. */
  readonly photo?: RoverPhoto | null;
  readonly onClose: () => void;
}

type Load =
  | { readonly kind: "loading"; readonly progress: BuildProgress | null }
  | { readonly kind: "ready"; readonly mesh: HorizonMesh }
  | { readonly kind: "error"; readonly message: string };

const COMPASS = [
  [0, "N"], [45, "NE"], [90, "E"], [135, "SE"], [180, "S"], [225, "SO"], [270, "O"], [315, "NO"],
] as const;
const COMPASS_EN: Readonly<Record<string, string>> = { SO: "SW", O: "W", NO: "NW" };

const deg = (x: number) => `${x.toLocaleString(localeNow(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })}°`;
const wrap = (a: number) => ((a % 360) + 360) % 360;
/** Diferencia de ángulos de `b` a `a`, entre −180 y 180. */
const diff = (a: number, b: number) => wrap(a - b + 180) - 180;

/**
 * Procedencia del horizonte que mide esta vista. Es una estimación: sale de
 * los tiles de relieve, que están remuestreados para dibujar (docs/context.md
 * §4). Para saber si hay luz manda la pila de sombras (useStackLight).
 */
function reliefSource(near: TerrainLayer | null, far: TerrainLayer | null, mesh: HorizonMesh): SourceInfo {
  const used = [mesh.counts.dtm > 0 ? near : null, mesh.counts.far > 0 ? far : null].filter(
    (l): l is TerrainLayer => l !== null,
  );
  const step = (RADIAL_STEP * 100).toLocaleString(localeNow(), { maximumFractionDigits: 1 });
  return {
    provenance: "MODELED",
    mission: used.map((l) => l.mission).filter(Boolean).join(" + ") || null,
    instrument: null,
    resolution: used.map((l) => l.resolution).filter(Boolean).join("; ") || undefined,
    source: tNow(
      "Estimado en el navegador con los tiles de relieve (relief-dem y relief-far), desde los ojos del observador",
      "Estimated in the browser with the relief tiles (relief-dem and relief-far), from the observer's eyes",
    ),
    assumptions: [
      tNow(
        "Los tiles de relieve están remuestreados para dibujar: es una estimación, no la pila de sombras del planificador",
        "The relief tiles are resampled for drawing: this is an estimate, not the planner's shadow stack",
      ),
      tNow(
        `Muestras cada 0,5° de azimut y cada ~${step} % de la distancia, con el relieve promediado al zoom de esa distancia: un pico angosto o lejano puede quedar más bajo`,
        `Samples every 0.5° of azimuth and every ~${step} % of the distance, with the relief averaged at that distance's zoom: a narrow or distant peak may come out lower`,
      ),
      tNow("Huecos chicos del DTM rellenados por interpolación para dibujar", "Small DTM gaps filled by interpolation for drawing"),
      tNow(`Ojos a ${EYE_HEIGHT_M.toLocaleString(localeNow())} m del suelo`, `Eyes ${EYE_HEIGHT_M.toLocaleString(localeNow())} m above the ground`),
      tNow("Esfera de Marte: incluye la caída por curvatura con la distancia", "Mars sphere: includes the curvature drop with distance"),
    ],
  };
}

export function HorizonView({ siteId, title, lat: stationLat, lon: stationLon, at, photo, onClose }: Props) {
  const terrain = useStore((s) => s.terrain);
  const nearLayer = terrain?.layers["relief-dem"] ?? null;
  const farLayer = terrain?.layers["relief-far"] ?? null;
  const nearSet = demTileSet(siteId, "relief-dem", nearLayer);
  const farSet = demTileSet(siteId, "relief-far", farLayer);
  const t = useT();
  const tr = useTr();

  const [from, setFrom] = useState<"station" | "rover">("station");
  const lat = from === "rover" && photo ? photo.lat : stationLat;
  const lon = from === "rover" && photo ? photo.lon : stationLon;

  const [offsetMin, setOffsetMin] = useState(0);
  const when = new Date(at.getTime() + offsetMin * 60_000);
  const sun = sunPosition(when, lat, lon);

  const [heading, setHeading] = useState(() => Math.round(sunPosition(at, stationLat, stationLon).azimuthDeg));
  const [pitch, setPitch] = useState(0);
  const [fov, setFov] = useState(50);
  const [showPhoto, setShowPhoto] = useState(Boolean(photo));
  const [load, setLoad] = useState<Load>({ kind: "loading", progress: null });
  // Aparte de `load`: si no hay WebGL, ningún estado del terreno lo tiene que tapar.
  const [glError, setGlError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HorizonScene | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  // La escena se crea una vez, como el mapa.
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = wrapRef.current;
    if (!canvas || !box) return;
    let scene: HorizonScene;
    try {
      scene = new HorizonScene(canvas);
    } catch (e) {
      setGlError(`${tNow("Este navegador no puede dibujar en 3D (WebGL).", "This browser cannot draw in 3D (WebGL).")} ${String(e)}`);
      return;
    }
    sceneRef.current = scene;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      scene.resize(width, height);
      setSize({ w: width, h: height });
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // El terreno se arma de nuevo solo si cambia el punto o los tiles.
  const nearKey = nearSet?.template ?? null;
  const farKey = farSet?.template ?? null;
  useEffect(() => {
    // Sin escena (no hay WebGL) no tiene sentido bajar tiles: el aviso ya está puesto.
    // Este efecto corre después del que crea la escena, en el mismo commit.
    if (!sceneRef.current) return;
    if (!nearKey && !farKey) {
      setLoad({
        kind: "error",
        message: tNow(
          "Todavía no hay relieve de este sitio: el pipeline no publicó relief-dem ni relief-far en terrain.json.",
          "There is no relief for this site yet: the pipeline did not publish relief-dem or relief-far in terrain.json.",
        ),
      });
      return;
    }
    const ctl = new AbortController();
    const near = nearSet ? new DemSampler(nearSet) : null;
    const far = farSet ? new DemSampler(farSet) : null;
    setLoad({ kind: "loading", progress: null });
    buildHorizonMesh(lat, lon, near, far, ctl.signal, (progress) => {
      if (!ctl.signal.aborted) setLoad({ kind: "loading", progress });
    })
      .then((mesh) => {
        if (ctl.signal.aborted) return;
        sceneRef.current?.setMesh(mesh);
        setLoad({ kind: "ready", mesh });
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => ctl.abort();
    // nearSet/farSet se rearman en cada render: la identidad la dan sus plantillas.
  }, [siteId, lat, lon, nearKey, farKey]);

  const mesh = load.kind === "ready" ? load.mesh : null;
  const shown: Load = glError ? { kind: "error", message: glError } : load;
  // Estimación de esta vista: el Sol contra el horizonte de los tiles de relieve (MODELED).
  const horizonToSun = mesh ? horizonAt(mesh, sun.azimuthDeg) : null;
  const viewLit = horizonToSun === null ? sun.elevationDeg > 0 : sun.elevationDeg > horizonToSun;
  // Lo que manda es la pila de sombras, el mismo dato que el veredicto y el
  // deslizador. Sin pila para esa hora, la estimación de la vista, y se dice.
  const stack = useStackLight(siteId, lat, lon, when);
  const night = sun.elevationDeg <= 0;
  const lit = night ? false : stack.kind === "ok" ? stack.lit : viewLit;

  useEffect(() => {
    sceneRef.current?.setSun(sun, lit);
  }, [sun.azimuthDeg, sun.elevationDeg, lit, mesh]);

  useEffect(() => {
    sceneRef.current?.setView({ headingDeg: heading, pitchDeg: pitch, fovDeg: fov });
  }, [heading, pitch, fov]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Con el foco en un deslizador (hora, campo de visión) las flechas son suyas.
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.isContentEditable || t.closest("input, select, textarea") !== null);
      if (e.key === "Escape") onClose();
      else if (typing) return;
      else if (e.key === "ArrowLeft") setHeading((h) => wrap(h - 5));
      else if (e.key === "ArrowRight") setHeading((h) => wrap(h + 5));
      else if (e.key === "ArrowUp") setPitch((p) => Math.min(p + 2, 60));
      else if (e.key === "ArrowDown") setPitch((p) => Math.max(p - 2, -60));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Campo de visión horizontal: cuántos grados de la brújula entran en el ancho.
  const hfov = (2 * Math.atan(Math.tan((fov * Math.PI) / 360) * (size.w / size.h)) * 180) / Math.PI;
  const pxPerDeg = size.w / hfov;

  const onPointerDown = (e: ReactPointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Arrastrar mueve el paisaje con el dedo, como mirar con la cabeza.
    setHeading((h) => wrap(h - (e.clientX - d.x) / pxPerDeg));
    setPitch((p) => Math.max(-60, Math.min(60, p + (e.clientY - d.y) / pxPerDeg)));
    dragRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const sunValue = (value: number): DataValue => ({ ...SUN_SOURCE, value, unit: null });
  const nearMissing = !nearSet;
  const farMissing = !farSet;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${t("Horizonte desde", "Horizon from")} ${title}`}
      className="fixed inset-0 z-50 flex flex-col bg-bg text-fg"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {t("Horizonte desde", "Horizon from")} {title}
          </h2>
          <p className="font-mono text-[11px] text-muted">
            {formatLatLon({ lat, lon })} ·{" "}
            {t(
              `ojos a ${EYE_HEIGHT_M.toLocaleString(localeNow())} m del suelo`,
              `eyes ${EYE_HEIGHT_M.toLocaleString(localeNow())} m above the ground`,
            )}
          </p>
        </div>
        {photo ? (
          <div className="flex gap-1 text-xs" role="group" aria-label={t("Punto de vista", "Viewpoint")}>
            <button
              type="button"
              aria-pressed={from === "station"}
              onClick={() => setFrom("station")}
              className={`rounded border px-2 py-1 ${from === "station" ? "border-rust bg-rust/15" : "border-line"}`}
            >
              {t("Desde la estación", "From the stop")}
            </button>
            <button
              type="button"
              aria-pressed={from === "rover"}
              onClick={() => setFrom("rover")}
              className={`rounded border px-2 py-1 ${from === "rover" ? "border-rust bg-rust/15" : "border-line"}`}
            >
              {t(`Desde el rover (sol ${photo.sol})`, `From the rover (sol ${photo.sol})`)}
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-line px-3 py-1.5 text-sm font-semibold hover:border-rust"
          aria-label={t("Cerrar el horizonte (Esc)", "Close the horizon (Esc)")}
        >
          {t("✕ Cerrar", "✕ Close")}
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div ref={wrapRef} className="relative min-h-[50vh] flex-1 overflow-hidden">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 size-full cursor-grab touch-none active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            aria-label={t("Vista del terreno. Arrastrá o usá las flechas para girar.", "Terrain view. Drag or use the arrow keys to turn.")}
          />

          {/* Brújula: rumbos y Sol dentro del campo de visión. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-9 border-b border-fg/20 bg-bg/60 font-mono text-xs">
            {COMPASS.map(([a, label]) => {
              const x = size.w / 2 + diff(a, heading) * pxPerDeg;
              return Math.abs(diff(a, heading)) < hfov / 2 ? (
                <span key={label} className="absolute top-1.5 -translate-x-1/2 font-bold" style={{ left: x }}>
                  {t(label, COMPASS_EN[label] ?? label)}
                </span>
              ) : null;
            })}
            {Math.abs(diff(sun.azimuthDeg, heading)) < hfov / 2 ? (
              <span
                className="absolute top-1.5 -translate-x-1/2 text-warn"
                style={{ left: size.w / 2 + diff(sun.azimuthDeg, heading) * pxPerDeg }}
              >
                ☀
              </span>
            ) : null}
            <span className="absolute bottom-0 left-1/2 h-2 w-0.5 -translate-x-1/2 bg-rust" aria-hidden />
            <span className="absolute top-1.5 right-2 text-muted">
              {t("rumbo", "heading")} {Math.round(heading)}°
            </span>
          </div>

          {shown.kind !== "ready" ? (
            <div className="absolute inset-0 grid place-items-center bg-bg/80 p-4 text-center text-sm">
              {shown.kind === "loading" ? (
                <p>
                  {t("Armando el terreno…", "Building the terrain…")}
                  {shown.progress ? (
                    <span className="block font-mono text-xs text-muted">
                      {shown.progress.stage === "dtm" ? "DTM" : "DEM 200 m"}: {shown.progress.done}/
                      {shown.progress.total} tiles
                    </span>
                  ) : null}
                </p>
              ) : (
                <p role="alert" className="max-w-md rounded border border-alert bg-alert/15 p-3">
                  <strong className="text-alert">{t("No se puede dibujar el horizonte.", "The horizon cannot be drawn.")}</strong>{" "}
                  {tr(shown.message)}
                </p>
              )}
            </div>
          ) : null}

          {photo && showPhoto ? (
            <figure className="absolute bottom-16 left-2 w-[min(46%,420px)] rounded border border-line bg-panel/95 p-1.5 shadow-lg">
              <img
                src={photo.url}
                alt={`${photo.rover}, ${photo.camera}, sol ${photo.sol}`}
                className="w-full rounded"
              />
              <figcaption className="mt-1 text-[10px] text-muted">
                {t("Foto real", "Real photo")}: {photo.camera}, sol {photo.sol} ·{" "}
                <span className="text-fg">{photo.credit.trim() || creditFor(photo.camera)}</span>.{" "}
                {t(
                  "No se sabe hacia dónde miraba la cámara: girá hasta que coincida.",
                  "We do not know which way the camera was pointing: turn until it matches.",
                )}
              </figcaption>
            </figure>
          ) : null}

          {/* Controles grandes, para usar con guantes. */}
          <div className="absolute inset-x-0 bottom-2 flex flex-wrap items-center justify-center gap-2 px-2">
            <button
              type="button"
              onClick={() => setHeading((h) => wrap(h - 15))}
              className="rounded border border-line bg-panel/90 px-4 py-2 text-lg font-bold"
              aria-label={t("Girar 15° a la izquierda", "Turn 15° left")}
            >
              ◀
            </button>
            <button
              type="button"
              onClick={() => {
                setHeading(Math.round(sun.azimuthDeg));
                setPitch(Math.max(0, Math.min(45, Math.round(sun.elevationDeg))));
              }}
              className="rounded border border-line bg-panel/90 px-3 py-2 text-sm"
            >
              {t("☀ Mirar al Sol", "☀ Look at the Sun")}
            </button>
            {photo ? (
              <button
                type="button"
                aria-pressed={showPhoto}
                onClick={() => setShowPhoto(!showPhoto)}
                className="rounded border border-line bg-panel/90 px-3 py-2 text-sm"
              >
                {showPhoto ? t("Ocultar foto", "Hide photo") : t("Comparar con la foto", "Compare with the photo")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setHeading((h) => wrap(h + 15))}
              className="rounded border border-line bg-panel/90 px-4 py-2 text-lg font-bold"
              aria-label={t("Girar 15° a la derecha", "Turn 15° right")}
            >
              ▶
            </button>
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-line p-3 text-xs lg:w-80 lg:border-t-0 lg:border-l">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("Sol", "Sun")}</h3>
            <label className="flex flex-col gap-1">
              <span className="flex justify-between">
                <span>{t("Hora solar local", "Local solar time")}</span>
                <span className="font-mono">{formatMarsTime(sun.ltst).slice(0, 5)}</span>
              </span>
              <input
                type="range"
                min={-720}
                max={720}
                step={5}
                value={offsetMin}
                onChange={(e) => setOffsetMin(Number(e.target.value))}
                aria-label={t("Mover la hora", "Move the time")}
              />
              <span className="font-mono text-[10px] text-muted">
                {when.toISOString().slice(0, 16).replace("T", " ")} UTC
                {offsetMin !== 0 ? (
                  <button type="button" className="ml-2 text-rust hover:underline" onClick={() => setOffsetMin(0)}>
                    {t("volver a la hora del plan", "back to the plan's time")}
                  </button>
                ) : null}
              </span>
            </label>
            <div className="flex items-center justify-between">
              <span>{t("Azimut", "Azimuth")}</span>
              <Measure data={sunValue(sun.azimuthDeg)} format={deg} />
            </div>
            <div className="flex items-center justify-between">
              <span>{t("Elevación", "Elevation")}</span>
              <Measure data={sunValue(sun.elevationDeg)} format={deg} />
            </div>
            {mesh && horizonToSun !== null ? (
              <div className="flex items-center justify-between">
                <span>{t("Relieve hacia el Sol (estimado)", "Relief toward the Sun (estimated)")}</span>
                <Measure
                  data={{ ...reliefSource(nearLayer, farLayer, mesh), value: horizonToSun, unit: null }}
                  format={deg}
                />
              </div>
            ) : null}
            <p
              className={`rounded border p-1.5 ${lit ? "border-ok/60 bg-ok/10" : "border-warn/60 bg-warn/10"}`}
              role="status"
            >
              {night ? (
                <>
                  <strong className="text-warn">{t("☾ De noche.", "☾ Night.")}</strong>{" "}
                  {t("El Sol está bajo el horizonte.", "The Sun is below the horizon.")}
                </>
              ) : lit ? (
                <>
                  <strong className="text-ok">
                    {t("☀ Sol a la vista", "☀ Sun in view")}
                    {stack.kind === "ok" ? "" : t(" (estimado)", " (estimated)")}.
                  </strong>{" "}
                  {t("Le da luz directa a este punto.", "It gives direct light to this point.")}
                </>
              ) : (
                <>
                  <strong className="text-warn">
                    {t("⚠ En sombra", "⚠ In shadow")}
                    {stack.kind === "ok" ? "" : t(" (estimado)", " (estimated)")}.
                  </strong>{" "}
                  {t("El Sol está detrás del relieve: este punto no tiene luz directa.", "The Sun is behind the relief: this point has no direct light.")}
                </>
              )}
            </p>
            {night ? null : (
              <LightSource
                stack={stack}
                viewLit={viewLit}
                estimate={mesh ? reliefSource(nearLayer, farLayer, mesh) : null}
              />
            )}
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("Vista", "View")}</h3>
            <label className="flex flex-col gap-1">
              <span className="flex justify-between">
                <span>{t("Campo de visión", "Field of view")}</span>
                <span className="font-mono">{fov}°</span>
              </span>
              <input
                type="range"
                min={15}
                max={90}
                value={fov}
                onChange={(e) => setFov(Number(e.target.value))}
                aria-label={t("Campo de visión vertical", "Vertical field of view")}
              />
            </label>
            <p className="text-[10px] text-muted">
              {t("Achicalo para acercar: sirve para igualar el zoom de la foto del rover.", "Narrow it to zoom in: useful to match the rover photo's zoom.")}
            </p>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("De dónde sale", "Where it comes from")}</h3>
            <SourceRow label={t("Terreno cercano", "Near terrain")} layer={nearLayer} missing={nearMissing} />
            <SourceRow label={t("Horizonte lejano", "Far horizon")} layer={farLayer} missing={farMissing} />
            {nearMissing ? (
              <p className="rounded border border-warn/60 bg-warn/10 p-1.5">
                <strong className="text-warn">{t("Sin DTM.", "No DTM.")}</strong>{" "}
                {t("Falta relief-dem: solo se ve el DEM de 200 m.", "relief-dem is missing: only the 200 m DEM is shown.")}
              </p>
            ) : null}
            {farMissing ? (
              <p className="rounded border border-warn/60 bg-warn/10 p-1.5">
                <strong className="text-warn">{t("Sin horizonte lejano.", "No far horizon.")}</strong>{" "}
                {t(
                  "Falta relief-far (DEM de 200 m): lo que queda fuera del DTM se ve como cielo.",
                  "relief-far (200 m DEM) is missing: whatever is outside the DTM shows as sky.",
                )}
              </p>
            ) : null}
            {mesh?.groundSource === "far" ? (
              <p className="rounded border border-warn/60 bg-warn/10 p-1.5">
                <strong className="text-warn">{t("Fuera del DTM de 1 m.", "Outside the 1 m DTM.")}</strong>{" "}
                {t(
                  "El suelo de este punto sale del DEM de 200 m: lo cercano no tiene detalle.",
                  "The ground at this point comes from the 200 m DEM: nearby terrain has no detail.",
                )}
              </p>
            ) : null}
            <ul className="list-disc pl-4 text-[10px] text-muted">
              <li>
                {t(
                  "La forma del terreno y la posición del Sol son datos; los colores, el cielo y la bruma son ilustrativos.",
                  "The terrain shape and the Sun position are data; the colors, sky and haze are illustrative.",
                )}
              </li>
              <li>
                {t(
                  `Sombras proyectadas solo hasta ~${SHADOW_RADIUS_M} m. Si el relieve tapa el Sol, se dibuja todo en sombra.`,
                  `Cast shadows only up to ~${SHADOW_RADIUS_M} m. If the relief blocks the Sun, everything is drawn in shadow.`,
                )}
              </li>
              <li>
                {t(
                  "Relieve remuestreado para dibujar: ninguna medida sale de esta vista salvo las que tienen badge.",
                  "Relief resampled for drawing: no measurement comes from this view except those with a badge.",
                )}
              </li>
            </ul>
          </section>

          <p className="mt-auto rounded border border-line p-1.5 text-[10px] text-muted">
            {t("Prototipo educativo, no software de vuelo.", "Educational prototype, not flight software.")}
          </p>
        </aside>
      </div>
    </div>,
    document.body,
  );
}

/**
 * De dónde sale el "Sol a la vista / En sombra": la pila de sombras (lo mismo
 * que el veredicto) o, si no hay, la estimación de esta vista, dicho con texto.
 */
function LightSource({
  stack,
  viewLit,
  estimate,
}: {
  readonly stack: StackLight;
  readonly viewLit: boolean;
  readonly estimate: SourceInfo | null;
}) {
  const t = useT();
  const tr = useTr();
  if (stack.kind === "ok") {
    const n = Math.abs(stack.offsetMin);
    const off =
      n === 0
        ? ""
        : t(`, ${n} min ${stack.offsetMin > 0 ? "antes" : "después"} de esta hora`, `, ${n} min ${stack.offsetMin > 0 ? "before" : "after"} this time`);
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span>
            {t(
              `Según la pila de sombras del planificador: máscara de las ${stack.ltst} LTST${off}.`,
              `According to the planner's shadow stack: mask for ${stack.ltst} LTST${off}.`,
            )}
          </span>
          <ProvenanceBadge source={stack.source} />
        </div>
        {viewLit !== stack.lit ? (
          <p className="text-[10px] text-muted">
            {t(
              `En esta vista el Sol ${viewLit ? "asoma sobre" : "queda detrás de"} el relieve, pero la pila de sombras dice lo contrario. Manda la pila: sale del DTM de 1 m sin remuestrear; esta vista está remuestreada para dibujar.`,
              `In this view the Sun ${viewLit ? "peeks over" : "is behind"} the relief, but the shadow stack says otherwise. The stack wins: it comes from the 1 m DTM without resampling; this view is resampled for drawing.`,
            )}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <span>
        {stack.kind === "pending"
          ? t(
              "Consultando la pila de sombras del planificador; mientras tanto, estimado con el relieve de esta vista.",
              "Querying the planner's shadow stack; meanwhile, estimated with this view's relief.",
            )
          : t(
              `Estimado con el relieve de esta vista, no con la pila de sombras del planificador: ${stack.reason}.`,
              `Estimated with this view's relief, not with the planner's shadow stack: ${tr(stack.reason)}.`,
            )}
      </span>
      {estimate ? <ProvenanceBadge source={estimate} /> : null}
    </div>
  );
}

function SourceRow({
  label,
  layer,
  missing,
}: {
  readonly label: string;
  readonly layer: TerrainLayer | null;
  readonly missing: boolean;
}) {
  const t = useT();
  const tr = useTr();
  return (
    <div className="flex items-center justify-between gap-2">
      <span>
        {label}
        <span className="block text-[10px] text-muted">{missing ? t("falta", "missing") : tr(layer?.resolution ?? "")}</span>
      </span>
      {!missing && layer ? (
        <ProvenanceBadge
          source={{
            provenance: "DERIVED",
            mission: layer.mission ?? null,
            instrument: null,
            resolution: layer.resolution,
            assumptions: layer.assumptions,
          }}
        />
      ) : null}
    </div>
  );
}
