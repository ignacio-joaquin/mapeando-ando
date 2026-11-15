import { useEffect, useState, type ReactNode } from "react";
import { planRoute } from "../../api/client";
import { EXAMPLE_PARAMS } from "../../api/routeFixture";
import type { MeasuredValue, RouteLeg, RouteStop } from "../../api/schemas";
import { MARS24_LTST } from "../../domain/provenance";
import { LEG_CLASS_COLOR, LEG_CLASS_LABEL, stopLabel, waypointLabel } from "../../map/route";
import { formatLatLon } from "../../mars/geo";
import { insideCoverage, UNVERIFIED_MESSAGE } from "../../map/coverage";
import { planKey, routeWaypoints, useFreshRoute, usePlan, type Waypoint } from "../../state/plan";
import { encodePlan, writePlanToUrl } from "../../state/share";
import { useStore } from "../../state/store";
import { DestinationSearch } from "./DestinationSearch";
import { PlaceCard } from "./PlaceCard";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { SafetyBreakdown } from "./SafetyBreakdown";
import { VerdictCard } from "./VerdictCard";
import { LegDirections } from "./LegDirections";
import { StationPhoto } from "./StationPhoto";
import {
  earthShort,
  formatBearing,
  formatDistanceM,
  formatMinutes,
  ltstShort,
  sameSource,
  toLocalInput,
} from "./format";

/**
 * Planificador de travesía: la pantalla central de la demo.
 *
 * Funciona como Google Maps: el primer clic marca el hábitat (A, de donde se
 * sale); el destino (B) se elige buscando, con un lugar sugerido o con otro
 * clic; después se suman paradas en el medio. Cada cambio (puntos, permanencia,
 * hora de salida) recalcula contra /api/route; mientras el server no lo tenga,
 * usa el planificador de ejemplo y lo dice. Por defecto el cálculo incluye la
 * vuelta al hábitat (se puede apagar). La travesía queda en la URL para
 * compartirla.
 */
export function RoutePlanner() {
  const siteId = useStore((s) => s.activeSiteId);
  const waypoints = usePlan((s) => s.waypoints);
  const departAt = usePlan((s) => s.departAt);
  const roundTrip = usePlan((s) => s.roundTrip);
  const clickMode = usePlan((s) => s.clickMode);
  const result = useFreshRoute();
  const status = usePlan((s) => s.status);
  const notice = usePlan((s) => s.notice);
  const coverage = useStore((s) => s.coverage);
  const { setDepartAt, setRoundTrip, setClickMode, setResult, setStatus, setNotice, clear, reverse } =
    usePlan.getState();

  // Cambiar de sitio arranca una travesía nueva (salvo la que trajo un enlace).
  useEffect(() => {
    usePlan.getState().switchSite(siteId);
  }, [siteId]);

  // La travesía vive también en la URL: copiar el enlace es compartirla.
  useEffect(() => {
    writePlanToUrl(
      waypoints.length === 0
        ? `?site=${encodeURIComponent(siteId)}`
        : encodePlan(siteId, departAt, waypoints, roundTrip),
    );
  }, [siteId, departAt, waypoints, roundTrip]);

  // Recalcular ante cualquier cambio, con un respiro para no pedir por tecla.
  useEffect(() => {
    if (waypoints.length < 2) {
      setResult(null);
      setStatus({ kind: "idle" });
      return;
    }
    const ctl = new AbortController();
    // La respuesta queda marcada con la huella de este pedido: si los puntos
    // cambian mientras tanto, la UI la trata como vieja y no la muestra.
    const key = planKey(siteId, departAt, waypoints, roundTrip);
    // Ya, no después del respiro: un error del pedido anterior no aplica a este.
    setStatus({ kind: "loading" });
    const t = setTimeout(() => {
      planRoute(
        {
          site: siteId,
          depart_utc: departAt.toISOString(),
          waypoints: routeWaypoints(waypoints, roundTrip).map((w) => ({
            lat: w.lat,
            lon: w.lon,
            task: w.task.trim() || null,
            dwell_min: w.dwellMin,
          })),
        },
        ctl.signal,
      )
        .then((r) => {
          if (ctl.signal.aborted) return;
          setResult(r, key);
          setStatus({ kind: "idle" });
        })
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          setResult(null);
          setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        });
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [waypoints, departAt, roundTrip, siteId, setResult, setStatus]);

  const route = result?.route ?? null;
  const origin = waypoints[0];
  const firstStop = route?.stops[0];
  // Con ida y vuelta, la respuesta trae un tramo y una parada más que la lista.
  const returnLeg = roundTrip ? route?.legs[waypoints.length - 1] : undefined;
  const returnStop = roundTrip ? route?.stops[waypoints.length] : undefined;

  return (
    <div className="flex flex-col gap-3 text-sm">
      {notice ? (
        <p
          role="alert"
          className="flex items-start justify-between gap-2 rounded border-2 border-alert bg-alert/15 p-2 text-xs text-fg"
        >
          <span>
            <strong className="text-alert">✕ </strong>
            {notice}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Cerrar aviso"
            className="shrink-0 text-muted hover:text-fg"
          >
            ✕
          </button>
        </p>
      ) : null}

      <header className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
          Planificar travesía
        </h2>
        <div className="flex gap-1" role="group" aria-label="Qué hace un clic en el mapa">
          <ModeButton active={clickMode === "add"} onClick={() => setClickMode("add")}>
            + puntos
          </ModeButton>
          <ModeButton active={clickMode === "inspect"} onClick={() => setClickMode("inspect")}>
            inspeccionar
          </ModeButton>
        </div>
      </header>

      <DestinationSearch />
      {coverage !== null ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <span aria-hidden className="inline-block h-0 w-5 border-t-2 border-[#f2e8d5]" />
          Línea continua clara: borde del terreno de 1 m (DTM HiRISE). Los puntos van adentro.
        </p>
      ) : waypoints.length > 0 ? (
        <p className="text-[11px] text-warn">⚠ {UNVERIFIED_MESSAGE}</p>
      ) : null}

      {/* Hora de salida */}
      <section className="rounded border border-line p-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted">Hora de salida (hora de tu computadora)</span>
          <span className="flex gap-1">
            <input
              type="datetime-local"
              value={toLocalInput(departAt)}
              onChange={(e) => {
                const d = new Date(e.target.value);
                if (!Number.isNaN(d.getTime())) setDepartAt(d);
              }}
              className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 font-mono text-xs text-fg"
            />
            <button
              type="button"
              onClick={() => setDepartAt(new Date())}
              className="rounded border border-line px-2 text-xs text-muted hover:text-fg"
            >
              ahora
            </button>
          </span>
        </label>
        {origin ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">En la salida:</span>
            <span className="font-mono text-base text-rust">{ltstShort(departAt, origin.lon)}</span>
            <span className="text-muted">LTST</span>
            <ProvenanceBadge source={MARS24_LTST} align="left" />
          </p>
        ) : null}
        <label className="mt-2 flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={roundTrip}
            onChange={(e) => setRoundTrip(e.target.checked)}
            className="mt-0.5 size-4 accent-rust"
          />
          <span>
            <span className="text-fg">Incluir la vuelta al hábitat</span>
            <span className="block text-[11px] text-muted">
              {roundTrip
                ? "El veredicto cuenta O2, batería, dosis y luz hasta volver a A."
                : "Solo ida: el veredicto termina en el destino, sin la vuelta."}
            </span>
          </span>
        </label>
      </section>

      {/* Veredicto */}
      {status.kind === "error" ? (
        <p className="rounded border border-alert bg-alert/15 p-2 text-xs text-fg">
          No se pudo calcular la ruta. {status.message}
        </p>
      ) : route ? (
        <>
          <VerdictCard
            verdict={route.verdict}
            {...(route.data_quality ? { dataQuality: route.data_quality } : {})}
          />
          {result?.example ? <ExampleNotice /> : null}
          <SafetyBreakdown verdict={route.verdict} cost={route.cost} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="flex-1 rounded border border-line px-2 py-1.5 text-xs text-fg hover:border-rust"
            >
              Imprimir tira
            </button>
            <ShareButton />
          </div>
        </>
      ) : waypoints.length === 1 ? (
        <Hint>Ahora elegí el destino (B): buscalo, tocá un lugar sugerido o hacé clic en el mapa.</Hint>
      ) : waypoints.length === 0 ? (
        <Hint>Hacé clic en el mapa para marcar el hábitat (A): es de donde salís.</Hint>
      ) : (
        // Sin veredicto mientras se recalcula: el anterior era de otra ruta.
        <p
          role="status"
          className="rounded border border-line p-2 text-xs text-muted"
        >
          Recalculando la travesía… El veredicto anterior ya no vale.
        </p>
      )}

      {/* Puntos, en orden, con lo calculado */}
      {waypoints.length > 0 ? (
        <section className="flex flex-col">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
              Recorrido · {waypoints.length} {waypoints.length === 1 ? "punto" : "puntos"}
              {roundTrip && waypoints.length >= 2 ? " · ida y vuelta" : ""}
            </h3>
            <span className="flex gap-2 text-[11px]">
              <button type="button" onClick={reverse} className="text-muted hover:text-fg">
                invertir
              </button>
              <button type="button" onClick={clear} className="text-rust hover:underline">
                borrar todo
              </button>
            </span>
          </div>

          {firstStop ? <SourcesRow stop={firstStop} leg={route?.legs[0]} /> : null}

          <ol className="flex flex-col">
            {waypoints.map((w, i) => (
              <li
                key={w.id}
                // Soltar una tarjeta encima de otra la deja en ese lugar.
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(DRAG_TYPE);
                  if (!id) return;
                  e.preventDefault();
                  usePlan.getState().movePointTo(id, i);
                }}
              >
                <StopCard
                  waypoint={w}
                  index={i}
                  total={waypoints.length}
                  stop={route?.stops[i]}
                  reference={firstStop}
                />
                {route?.legs[i] && i < waypoints.length - 1 ? (
                  <LegRow leg={route.legs[i]} reference={route.legs[0]} />
                ) : null}
              </li>
            ))}
            {returnLeg && returnStop ? (
              <li>
                <LegRow leg={returnLeg} reference={route?.legs[0]} />
                <ReturnCard stop={returnStop} total={route?.stops.length ?? 0} reference={firstStop} />
              </li>
            ) : null}
          </ol>

          {waypoints.length >= 2 ? (
            <Hint>
              Clic en el mapa agrega una parada antes del destino. Las paradas se reordenan
              arrastrando ⠿ (o con ↑ ↓) y los marcadores se pueden mover en el mapa.
            </Hint>
          ) : null}
        </section>
      ) : null}

      <LegLegend />
    </div>
  );
}

/* ——— partes ——— */

/** Tipo propio del arrastre: solo las tarjetas de la lista se pueden soltar ahí. */
const DRAG_TYPE = "application/x-mapeando-waypoint";

/** Copia el enlace de la travesía (la URL ya tiene sitio, hora y puntos). */
function ShareButton() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(window.location.href)
          .then(() => setState("copied"))
          .catch(() => setState("failed"));
        setTimeout(() => setState("idle"), 2500);
      }}
      className="flex-1 rounded border border-line px-2 py-1.5 text-xs text-fg hover:border-rust"
    >
      {state === "copied"
        ? "✓ Enlace copiado"
        : state === "failed"
          ? "Copialo de la barra de direcciones"
          : "Copiar enlace"}
    </button>
  );
}

/**
 * Badge en línea de un valor de la lista. La fila de referencia (la primera)
 * lo muestra siempre; las siguientes, solo si su fuente difiere de esa. Así
 * cada fuente se ve al menos una vez sin abrir nada, y no se repite por fila.
 */
function repeatedBadge(v: MeasuredValue, ref: MeasuredValue | undefined): "inline" | "none" {
  return ref && v !== ref && sameSource(v, ref) ? "none" : "inline";
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "rounded border border-rust bg-rust/15 px-2 py-0.5 text-[11px] text-fg"
          : "rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
      }
    >
      {children}
    </button>
  );
}

function Hint({ children }: { readonly children: ReactNode }) {
  return <p className="text-xs text-muted">{children}</p>;
}

function ExampleNotice() {
  const p = EXAMPLE_PARAMS;
  return (
    <p className="rounded border border-warn/60 bg-warn/10 p-2 text-[11px] leading-snug text-fg">
      <strong className="text-warn">Veredicto de ejemplo.</strong> El server todavía no tiene{" "}
      <code>/api/route</code>: esto lo calcula el frontend en línea recta, sin terreno, con
      parámetros supuestos ({p.walkSpeedKmh} km/h, {p.o2Hours} h de O2 y de batería, reserva de{" "}
      {p.reserveMin} min, luz de {p.daylightLtst.from} a {p.daylightLtst.to} h LTST). No usar para
      decidir.
    </p>
  );
}

/**
 * Badge por columna. Si todas las filas vienen de la misma fuente, el badge va
 * una vez acá; si una fila difiere, esa fila muestra el suyo (ver StopCard).
 */
function SourcesRow({ stop, leg }: { readonly stop: RouteStop; readonly leg: RouteLeg | undefined }) {
  const items: [string, MeasuredValue][] = [
    ["O2", stop.o2_remaining],
    ["Batería", stop.battery_remaining],
    ["Dosis", stop.dose_accumulated],
  ];
  if (leg) {
    items.push(["Distancia y rumbo", leg.distance], ["Duración", leg.duration]);
  }
  return (
    <details className="mb-2 rounded border border-line p-2 text-[11px]">
      <summary className="cursor-pointer text-muted">De dónde sale cada número</summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        <li className="flex items-center justify-between gap-2">
          <span className="text-muted">Horas (LTST)</span>
          <ProvenanceBadge source={MARS24_LTST} />
        </li>
        {items.map(([label, v]) => (
          <li key={label} className="flex items-center justify-between gap-2">
            <span className="text-muted">{label}</span>
            <ProvenanceBadge source={v} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function StopCard({
  waypoint,
  index,
  total,
  stop,
  reference,
}: {
  readonly waypoint: Waypoint;
  readonly index: number;
  readonly total: number;
  readonly stop: RouteStop | undefined;
  readonly reference: RouteStop | undefined;
}) {
  const { updatePoint, removePoint, shiftPoint, setOpenStop } = usePlan.getState();
  const open = usePlan((s) => s.openStop === index);
  const siteId = useStore((s) => s.activeSiteId);
  const place = useStore((s) => s.places?.places.find((p) => p.id === waypoint.placeId) ?? null);
  const coverage = useStore((s) => s.coverage);
  const outside = coverage !== null && !insideCoverage(coverage, waypoint);
  const label = waypointLabel(index, total);
  const isStation = label.kind === "station";
  // Con vuelta, en el destino también se queda un rato: esos minutos cuentan.
  const roundTrip = usePlan((s) => s.roundTrip);
  const hasDwell = isStation || (roundTrip && label.kind === "destination");

  const dot =
    label.kind === "origin"
      ? "bg-ok text-bg"
      : label.kind === "destination"
        ? "bg-alert text-bg"
        : "bg-panel text-fg";

  return (
    <div
      className={`rounded border p-2 ${open ? "border-rust bg-rust/5" : "border-line"}`}
      onFocus={() => setOpenStop(index)}
    >
      <div className="flex items-start gap-2">
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, waypoint.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          title="Arrastrar para reordenar"
          aria-hidden
          className="cursor-grab self-center px-0.5 text-muted select-none active:cursor-grabbing"
        >
          ⠿
        </span>
        <button
          type="button"
          onClick={() => setOpenStop(open ? null : index)}
          className={`grid size-6 shrink-0 place-items-center rounded-full border-2 border-fg text-[11px] font-bold ${dot}`}
          aria-label={`${label.long}: ${open ? "cerrar" : "abrir"}`}
        >
          {label.short}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">
              {label.long}
              {place ? <span className="font-normal text-muted"> · {place.name}</span> : null}
            </span>
            <span className="flex gap-1 text-[11px] text-muted">
              <IconButton label="Subir" disabled={index === 0} onClick={() => shiftPoint(waypoint.id, -1)}>
                ↑
              </IconButton>
              <IconButton
                label="Bajar"
                disabled={index === total - 1}
                onClick={() => shiftPoint(waypoint.id, 1)}
              >
                ↓
              </IconButton>
              <IconButton label="Quitar" onClick={() => removePoint(waypoint.id)}>
                ✕
              </IconButton>
            </span>
          </div>
          <p className="font-mono text-[11px] text-muted">{formatLatLon(waypoint)}</p>
          {waypoint.placeId && !place ? (
            <p className="text-[11px] text-muted">Lugar {waypoint.placeId} (el índice de lugares no cargó)</p>
          ) : null}
        </div>
      </div>

      {outside ? (
        <p role="alert" className="mt-2 rounded border border-alert bg-alert/15 p-1.5 text-[11px] text-fg">
          <strong className="text-alert">✕ Sin terreno de 1 m real.</strong> Este punto queda fuera
          del DTM HiRISE: movelo o quitalo antes de confiar en la ruta.
        </p>
      ) : null}

      {place && open ? <PlaceCard place={place} /> : null}

      <div className="mt-2 flex gap-1.5">
        <input
          type="text"
          value={waypoint.task}
          onChange={(e) => updatePoint(waypoint.id, { task: e.target.value })}
          placeholder={isStation ? "Tarea (ej. tomar muestra)" : "Tarea (opcional)"}
          aria-label={`Tarea en ${label.long}`}
          className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs text-fg placeholder:text-muted/70"
        />
        {hasDwell ? (
          <label className="flex items-center gap-1 text-[11px] text-muted">
            <input
              type="number"
              min={0}
              step={5}
              value={waypoint.dwellMin}
              onChange={(e) =>
                updatePoint(waypoint.id, { dwellMin: Math.max(0, Number(e.target.value) || 0) })
              }
              aria-label={`Minutos en ${label.long}`}
              className="w-14 rounded border border-line bg-bg px-1.5 py-1 text-right font-mono text-xs text-fg"
            />
            min
          </label>
        ) : null}
      </div>

      {stop ? <StopValues stop={stop} reference={reference} /> : null}

      {open ? (
        <StationPhoto siteId={siteId} lat={waypoint.lat} lon={waypoint.lon} />
      ) : (
        <button
          type="button"
          onClick={() => setOpenStop(index)}
          className="mt-2 text-[11px] text-rust hover:underline"
        >
          Ver qué hay en este punto
        </button>
      )}
    </div>
  );
}

/** La vuelta al hábitat: solo lectura, porque es el mismo punto que A. */
function ReturnCard({
  stop,
  total,
  reference,
}: {
  readonly stop: RouteStop;
  readonly total: number;
  readonly reference: RouteStop | undefined;
}) {
  const label = stopLabel(total - 1, total, true);
  return (
    <div className="rounded border border-dashed border-line p-2">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-fg bg-ok text-[11px] font-bold text-bg"
        >
          {label.short}
        </span>
        <div className="min-w-0 flex-1">
          <span className="font-semibold">{label.long}</span>
          <p className="font-mono text-[11px] text-muted">{formatLatLon(stop)}</p>
        </div>
      </div>
      <StopValues stop={stop} reference={reference} />
    </div>
  );
}

/** Horas y consumibles de una parada calculada. */
function StopValues({
  stop,
  reference,
}: {
  readonly stop: RouteStop;
  readonly reference: RouteStop | undefined;
}) {
  const badgeFor = (v: MeasuredValue, ref: MeasuredValue | undefined) => repeatedBadge(v, ref);
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
      {stop.arrive_utc ? (
        <>
          <dt className="text-muted">Llega</dt>
          <dd className="font-mono" title={`Tu hora: ${earthShort(stop.arrive_utc)}`}>
            {ltstShort(stop.arrive_utc, stop.lon)} <span className="text-muted">LTST</span>
          </dd>
        </>
      ) : null}
      {stop.depart_utc ? (
        <>
          <dt className="text-muted">Sale</dt>
          <dd className="font-mono" title={`Tu hora: ${earthShort(stop.depart_utc)}`}>
            {ltstShort(stop.depart_utc, stop.lon)} <span className="text-muted">LTST</span>
          </dd>
        </>
      ) : null}
      <dt className="text-muted">O2</dt>
      <dd className="text-right">
        <Measure
          data={stop.o2_remaining}
          format={(v) => v.toFixed(1)}
          badge={badgeFor(stop.o2_remaining, reference?.o2_remaining)}
        />
      </dd>
      <dt className="text-muted">Batería</dt>
      <dd className="text-right">
        <Measure
          data={stop.battery_remaining}
          format={(v) => v.toFixed(0)}
          badge={badgeFor(stop.battery_remaining, reference?.battery_remaining)}
        />
      </dd>
      <dt className="text-muted">Dosis acumulada</dt>
      <dd className="text-right">
        <Measure
          data={stop.dose_accumulated}
          format={(v) => v.toFixed(3)}
          badge={badgeFor(stop.dose_accumulated, reference?.dose_accumulated)}
        />
      </dd>
    </dl>
  );
}

function LegRow({ leg, reference }: { readonly leg: RouteLeg; readonly reference: RouteLeg | undefined }) {
  const color = LEG_CLASS_COLOR[leg.class];
  const same = (v: MeasuredValue, r: MeasuredValue | undefined) => repeatedBadge(v, r);
  return (
    <div className="ml-3 flex gap-3 border-l-4 py-1.5 pl-3 text-[11px]" style={{ borderColor: color }}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold" style={{ color }}>
          {LEG_CLASS_LABEL[leg.class]}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted">
          <Measure data={{ ...leg.distance, unit: null }} format={formatDistanceM} badge={same(leg.distance, reference?.distance)} />
          ·
          <Measure data={{ ...leg.duration, unit: null }} format={formatMinutes} badge={same(leg.duration, reference?.duration)} />
          ·
          <span>rumbo</span>
          <Measure data={{ ...leg.bearing, unit: null }} format={formatBearing} badge={same(leg.bearing, reference?.bearing)} />
        </span>
        {/* Measure también cuando falta: el badge dice de dónde tendría que salir. */}
        <span className="flex items-center gap-1">
          Pendiente máx.
          <Measure data={leg.max_slope} format={(v) => v.toFixed(0)} />
        </span>
        <LegDirections directions={leg.directions} />
      </div>
    </div>
  );
}

function LegLegend() {
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer text-muted">Colores de los tramos</summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {(Object.keys(LEG_CLASS_COLOR) as (keyof typeof LEG_CLASS_COLOR)[]).map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-block h-1 w-6 rounded ${k === "unknown" ? "opacity-70" : ""}`}
              style={{ background: LEG_CLASS_COLOR[k] }}
            />
            {LEG_CLASS_LABEL[k]}
            {k === "unknown" ? <span className="text-muted">(línea punteada)</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-5 place-items-center rounded hover:bg-line hover:text-fg disabled:opacity-30"
    >
      {children}
    </button>
  );
}
