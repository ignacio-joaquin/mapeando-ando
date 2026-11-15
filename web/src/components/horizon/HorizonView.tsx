import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { RoverPhoto, TerrainLayer } from "../../api/schemas";
import type { DataValue, SourceInfo } from "../../domain/provenance";
import { DemSampler, demTileSet } from "../../horizon/demTiles";
import { buildHorizonMesh, EYE_HEIGHT_M, horizonAt, type BuildProgress, type HorizonMesh } from "../../horizon/mesh";
import { HorizonScene, SHADOW_RADIUS_M } from "../../horizon/scene";
import { formatLatLon } from "../../mars/geo";
import { formatMarsTime } from "../../mars/mars24";
import { SUN_SOURCE, sunPosition } from "../../mars/sunPosition";
import { useStore } from "../../state/store";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { creditFor } from "../route/StationPhoto";

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

const deg = (x: number) => `${x.toLocaleString("es-AR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}°`;
const wrap = (a: number) => ((a % 360) + 360) % 360;
/** Diferencia de ángulos de `b` a `a`, entre −180 y 180. */
const diff = (a: number, b: number) => wrap(a - b + 180) - 180;

function reliefSource(near: TerrainLayer | null, far: TerrainLayer | null, mesh: HorizonMesh): SourceInfo {
  const used = [mesh.counts.dtm > 0 ? near : null, mesh.counts.far > 0 ? far : null].filter(
    (l): l is TerrainLayer => l !== null,
  );
  return {
    provenance: "DERIVED",
    mission: used.map((l) => l.mission).filter(Boolean).join(" + ") || null,
    instrument: null,
    resolution: used.map((l) => l.resolution).filter(Boolean).join("; ") || undefined,
    source: "Tiles de relieve del pipeline (relief-dem y relief-far), desde los ojos del observador",
    assumptions: [
      `Ojos a ${EYE_HEIGHT_M.toLocaleString("es-AR")} m del suelo`,
      "Esfera de Marte: incluye la caída por curvatura con la distancia",
      "Muestreado cada 0,5° de azimut: un pico más angosto puede quedar bajo",
    ],
  };
}

export function HorizonView({ siteId, title, lat: stationLat, lon: stationLon, at, photo, onClose }: Props) {
  const terrain = useStore((s) => s.terrain);
  const nearLayer = terrain?.layers["relief-dem"] ?? null;
  const farLayer = terrain?.layers["relief-far"] ?? null;
  const nearSet = demTileSet(siteId, "relief-dem", nearLayer);
  const farSet = demTileSet(siteId, "relief-far", farLayer);

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
      setLoad({ kind: "error", message: `Este navegador no puede dibujar en 3D (WebGL). ${String(e)}` });
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
    if (!nearKey && !farKey) {
      setLoad({
        kind: "error",
        message: "Todavía no hay relieve de este sitio: el pipeline no publicó relief-dem ni relief-far en terrain.json.",
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
  const horizonToSun = mesh ? horizonAt(mesh, sun.azimuthDeg) : null;
  const lit = horizonToSun === null ? sun.elevationDeg > 0 : sun.elevationDeg > horizonToSun;

  useEffect(() => {
    sceneRef.current?.setSun(sun, lit);
  }, [sun.azimuthDeg, sun.elevationDeg, lit, mesh]);

  useEffect(() => {
    sceneRef.current?.setView({ headingDeg: heading, pitchDeg: pitch, fovDeg: fov });
  }, [heading, pitch, fov]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
      aria-label={`Horizonte desde ${title}`}
      className="fixed inset-0 z-50 flex flex-col bg-bg text-fg"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Horizonte desde {title}</h2>
          <p className="font-mono text-[11px] text-muted">
            {formatLatLon({ lat, lon })} · ojos a {EYE_HEIGHT_M.toLocaleString("es-AR")} m del suelo
          </p>
        </div>
        {photo ? (
          <div className="flex gap-1 text-xs" role="group" aria-label="Punto de vista">
            <button
              type="button"
              aria-pressed={from === "station"}
              onClick={() => setFrom("station")}
              className={`rounded border px-2 py-1 ${from === "station" ? "border-rust bg-rust/15" : "border-line"}`}
            >
              Desde la estación
            </button>
            <button
              type="button"
              aria-pressed={from === "rover"}
              onClick={() => setFrom("rover")}
              className={`rounded border px-2 py-1 ${from === "rover" ? "border-rust bg-rust/15" : "border-line"}`}
            >
              Desde el rover (sol {photo.sol})
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-line px-3 py-1.5 text-sm font-semibold hover:border-rust"
          aria-label="Cerrar el horizonte (Esc)"
        >
          ✕ Cerrar
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
            aria-label="Vista del terreno. Arrastrá o usá las flechas para girar."
          />

          {/* Brújula: rumbos y Sol dentro del campo de visión. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-9 border-b border-fg/20 bg-bg/60 font-mono text-xs">
            {COMPASS.map(([a, label]) => {
              const x = size.w / 2 + diff(a, heading) * pxPerDeg;
              return Math.abs(diff(a, heading)) < hfov / 2 ? (
                <span key={label} className="absolute top-1.5 -translate-x-1/2 font-bold" style={{ left: x }}>
                  {label}
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
            <span className="absolute top-1.5 right-2 text-muted">rumbo {Math.round(heading)}°</span>
          </div>

          {load.kind !== "ready" ? (
            <div className="absolute inset-0 grid place-items-center bg-bg/80 p-4 text-center text-sm">
              {load.kind === "loading" ? (
                <p>
                  Armando el terreno…
                  {load.progress ? (
                    <span className="block font-mono text-xs text-muted">
                      {load.progress.stage === "dtm" ? "DTM" : "DEM 200 m"}: {load.progress.done}/
                      {load.progress.total} tiles
                    </span>
                  ) : null}
                </p>
              ) : (
                <p role="alert" className="max-w-md rounded border border-alert bg-alert/15 p-3">
                  <strong className="text-alert">No se puede dibujar el horizonte.</strong> {load.message}
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
                Foto real: {photo.camera}, sol {photo.sol} ·{" "}
                <span className="text-fg">{photo.credit.trim() || creditFor(photo.camera)}</span>. No se sabe
                hacia dónde miraba la cámara: girá hasta que coincida.
              </figcaption>
            </figure>
          ) : null}

          {/* Controles grandes, para usar con guantes. */}
          <div className="absolute inset-x-0 bottom-2 flex flex-wrap items-center justify-center gap-2 px-2">
            <button
              type="button"
              onClick={() => setHeading((h) => wrap(h - 15))}
              className="rounded border border-line bg-panel/90 px-4 py-2 text-lg font-bold"
              aria-label="Girar 15° a la izquierda"
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
              ☀ Mirar al Sol
            </button>
            {photo ? (
              <button
                type="button"
                aria-pressed={showPhoto}
                onClick={() => setShowPhoto(!showPhoto)}
                className="rounded border border-line bg-panel/90 px-3 py-2 text-sm"
              >
                {showPhoto ? "Ocultar foto" : "Comparar con la foto"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setHeading((h) => wrap(h + 15))}
              className="rounded border border-line bg-panel/90 px-4 py-2 text-lg font-bold"
              aria-label="Girar 15° a la derecha"
            >
              ▶
            </button>
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-line p-3 text-xs lg:w-80 lg:border-t-0 lg:border-l">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Sol</h3>
            <label className="flex flex-col gap-1">
              <span className="flex justify-between">
                <span>Hora solar local</span>
                <span className="font-mono">{formatMarsTime(sun.ltst).slice(0, 5)}</span>
              </span>
              <input
                type="range"
                min={-720}
                max={720}
                step={5}
                value={offsetMin}
                onChange={(e) => setOffsetMin(Number(e.target.value))}
                aria-label="Mover la hora"
              />
              <span className="font-mono text-[10px] text-muted">
                {when.toISOString().slice(0, 16).replace("T", " ")} UTC
                {offsetMin !== 0 ? (
                  <button type="button" className="ml-2 text-rust hover:underline" onClick={() => setOffsetMin(0)}>
                    volver a la hora del plan
                  </button>
                ) : null}
              </span>
            </label>
            <div className="flex items-center justify-between">
              <span>Azimut</span>
              <Measure data={sunValue(sun.azimuthDeg)} format={deg} />
            </div>
            <div className="flex items-center justify-between">
              <span>Elevación</span>
              <Measure data={sunValue(sun.elevationDeg)} format={deg} />
            </div>
            {mesh && horizonToSun !== null ? (
              <div className="flex items-center justify-between">
                <span>Relieve hacia el Sol</span>
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
              {sun.elevationDeg <= 0 ? (
                <>
                  <strong className="text-warn">☾ De noche.</strong> El Sol está bajo el horizonte.
                </>
              ) : lit ? (
                <>
                  <strong className="text-ok">☀ Sol a la vista.</strong> Le da luz directa a este punto.
                </>
              ) : (
                <>
                  <strong className="text-warn">⚠ En sombra.</strong> El Sol está detrás del relieve: este
                  punto no tiene luz directa.
                </>
              )}
            </p>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Vista</h3>
            <label className="flex flex-col gap-1">
              <span className="flex justify-between">
                <span>Campo de visión</span>
                <span className="font-mono">{fov}°</span>
              </span>
              <input
                type="range"
                min={15}
                max={90}
                value={fov}
                onChange={(e) => setFov(Number(e.target.value))}
                aria-label="Campo de visión vertical"
              />
            </label>
            <p className="text-[10px] text-muted">
              Achicalo para acercar: sirve para igualar el zoom de la foto del rover.
            </p>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">De dónde sale</h3>
            <SourceRow label="Terreno cercano" layer={nearLayer} missing={nearMissing} />
            <SourceRow label="Horizonte lejano" layer={farLayer} missing={farMissing} />
            {nearMissing ? (
              <p className="rounded border border-warn/60 bg-warn/10 p-1.5">
                <strong className="text-warn">Sin DTM.</strong> Falta relief-dem: solo se ve el DEM de 200 m.
              </p>
            ) : null}
            {farMissing ? (
              <p className="rounded border border-warn/60 bg-warn/10 p-1.5">
                <strong className="text-warn">Sin horizonte lejano.</strong> Falta relief-far (DEM de 200 m):
                lo que queda fuera del DTM se ve como cielo.
              </p>
            ) : null}
            {mesh?.groundSource === "far" ? (
              <p className="rounded border border-warn/60 bg-warn/10 p-1.5">
                <strong className="text-warn">Fuera del DTM de 1 m.</strong> El suelo de este punto sale del DEM
                de 200 m: lo cercano no tiene detalle.
              </p>
            ) : null}
            <ul className="list-disc pl-4 text-[10px] text-muted">
              <li>La forma del terreno y la posición del Sol son datos; los colores, el cielo y la bruma son ilustrativos.</li>
              <li>Sombras proyectadas solo hasta ~{SHADOW_RADIUS_M} m. Si el relieve tapa el Sol, se dibuja todo en sombra.</li>
              <li>Relieve remuestreado para dibujar: ninguna medida sale de esta vista salvo las que tienen badge.</li>
            </ul>
          </section>

          <p className="mt-auto rounded border border-line p-1.5 text-[10px] text-muted">
            Prototipo educativo, no software de vuelo.
          </p>
        </aside>
      </div>
    </div>,
    document.body,
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
  return (
    <div className="flex items-center justify-between gap-2">
      <span>
        {label}
        <span className="block text-[10px] text-muted">{missing ? "falta" : (layer?.resolution ?? "")}</span>
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
