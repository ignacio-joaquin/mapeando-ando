import { useEffect, useState, type ReactNode } from "react";
import { planRoute } from "../../api/client";
import { EXAMPLE_PARAMS } from "../../api/routeFixture";
import type { MeasuredValue, RouteLeg, RouteStop } from "../../api/schemas";
import { cargoKg } from "../../domain/equipment";
import { MARS24_LTST } from "../../domain/provenance";
import { LEG_CLASS_COLOR, LEG_CLASS_LABEL, stopLabel, waypointLabel } from "../../map/route";
import { formatLatLon } from "../../mars/geo";
import { insideCoverage, UNVERIFIED_MESSAGE } from "../../map/coverage";
import { planKey, routeWaypoints, useFreshRoute, usePlan, useRouteParams, type Waypoint } from "../../state/plan";
import { encodePlan, encodeSite, writePlanToUrl } from "../../state/share";
import { useStore } from "../../state/store";
import { DestinationSearch } from "./DestinationSearch";
import { PlaceCard } from "./PlaceCard";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { HabitatContact } from "./HabitatContact";
import { SafetyBreakdown } from "./SafetyBreakdown";
import { VerdictCard } from "./VerdictCard";
import { DirectionsList } from "./DirectionsList";
import { StationPhoto } from "./StationPhoto";
import { CargoPicker } from "./CargoPicker";
import { NavigationView } from "./NavigationView";
import { PlannerTabs, VerdictStrip } from "./PlannerTabs";
import { RouteSettings } from "./RouteSettings";
import { useEdu } from "../../state/edu";
import { useUi, type PlannerTab } from "../../state/ui";
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
  const kit = usePlan((s) => s.kit);
  const extraKg = usePlan((s) => s.extraKg);
  const cargo = cargoKg(kit, extraKg);
  const result = useFreshRoute();
  const status = usePlan((s) => s.status);
  const notice = usePlan((s) => s.notice);
  const coverage = useStore((s) => s.coverage);
  const params = useRouteParams();
  const { setDepartAt, setRoundTrip, setResult, setStatus, setNotice, clear, reverse } =
    usePlan.getState();

  // Cambiar de sitio arranca una travesía nueva (salvo la que trajo un enlace).
  useEffect(() => {
    usePlan.getState().switchSite(siteId);
  }, [siteId]);

  // La travesía vive también en la URL: copiar el enlace es compartirla.
  useEffect(() => {
    writePlanToUrl(
      waypoints.length === 0
        ? encodeSite(siteId, { kit, extraKg })
        : encodePlan(siteId, departAt, waypoints, roundTrip, { kit, extraKg }),
    );
  }, [siteId, departAt, waypoints, roundTrip, kit, extraKg]);

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
    const key = planKey(siteId, departAt, waypoints, roundTrip, cargo, params);
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
          cargo_kg: cargo,
          ...(params ? { params } : {}),
        },
        ctl.signal,
      )
        .then((r) => {
          if (ctl.signal.aborted) return;
          // La primera ruta de una travesía abre la navegación: es lo que se usa afuera.
          const first = usePlan.getState().result === null;
          setResult(r, key);
          useUi.getState().setNavStep(0);
          if (first && useUi.getState().tab === "route") useUi.getState().setTab("navigate");
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
  }, [waypoints, departAt, roundTrip, cargo, siteId, params, setResult, setStatus]);

  const route = result?.route ?? null;
  const origin = waypoints[0];
  const firstStop = route?.stops[0];
  // Con ida y vuelta, la respuesta trae un tramo y una parada más que la lista.
  const returnLeg = roundTrip ? route?.legs[waypoints.length - 1] : undefined;
  const returnStop = roundTrip ? route?.stops[waypoints.length] : undefined;

  const eduOpen = useEdu((s) => s.open);
  const tab = useUi((s) => s.tab);
  const { setTab } = useUi.getState();
  // Navegar y Seguridad necesitan una ruta calculada.
  const current: PlannerTab = !route && (tab === "navigate" || tab === "safety") ? "route" : tab;

  const noticeEl = notice ? (
    <p
      role="alert"
      className="flex items-start justify-between gap-2 rounded-lg border border-alert bg-alert/15 p-2.5 text-xs text-fg"
    >
      <span>
        <strong className="text-alert">✕ </strong>
        {notice}
      </span>
      <button
        type="button"
        onClick={() => setNotice(null)}
        aria-label="Cerrar aviso"
        className="-m-1 grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-line hover:text-fg"
      >
        ✕
      </button>
    </p>
  ) : null;

  const headerEl = (
    <header className="flex items-center justify-between gap-2">
      <h2 className="text-base font-bold">Travesía</h2>
      {waypoints.length > 0 ? (
        <span className="flex gap-1 text-xs">
          {waypoints.length >= 2 ? <TextButton onClick={reverse}>⇅ Invertir</TextButton> : null}
          <TextButton onClick={clear} danger>
            Borrar todo
          </TextButton>
        </span>
      ) : null}
    </header>
  );

  const statusEl =
    status.kind === "error" ? (
      <p className="rounded-lg border border-alert bg-alert/15 p-2.5 text-xs text-fg">
        <strong className="text-alert">✕ No se pudo calcular la ruta.</strong> {status.message}
      </p>
    ) : !route && waypoints.length >= 2 ? (
      // Sin veredicto mientras se recalcula: el anterior era de otra ruta.
      <p role="status" className="flex items-center gap-2 rounded-lg border border-line p-3 text-xs text-muted">
        <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-muted border-t-transparent" />
        Calculando la travesía…
      </p>
    ) : null;

  const shareEl = (
    <div data-edu="share" className="flex gap-2">
      <button
        type="button"
        onClick={() => window.print()}
        className="min-h-9 flex-1 rounded-md border border-line text-xs text-fg hover:border-muted"
      >
        ⎙ Imprimir tira
      </button>
      <ShareButton />
    </div>
  );

  const verdictEl = route ? (
    <>
      <VerdictCard
        verdict={route.verdict}
        {...(route.data_quality ? { dataQuality: route.data_quality } : {})}
      />
      {result?.example ? <ExampleNotice /> : null}
    </>
  ) : null;

  const planEl = (
    <>
      {waypoints.length < 2 ? <Steps count={waypoints.length} /> : null}

      {/* El buscador queda montado (la lección lo señala), pero recién se ve
          cuando hay hábitat: antes no hay a dónde ir. */}
      <div data-edu="search" className={waypoints.length > 0 ? "" : "hidden"}>
        <DestinationSearch />
      </div>
      {coverage !== null ? (
        waypoints.length > 0 ? (
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <span aria-hidden className="inline-block h-0 w-5 shrink-0 border-t-2 border-[#f2e8d5]" />
            Línea clara en el mapa: borde del terreno de 1 m (DTM HiRISE). Los puntos van adentro.
          </p>
        ) : null
      ) : waypoints.length > 0 ? (
        <p className="text-[11px] text-warn">⚠ {UNVERIFIED_MESSAGE}</p>
      ) : null}

      {/* Salida */}
      <section data-edu="depart" className={`flex flex-col gap-2 ${waypoints.length > 0 ? "" : "hidden"}`}>
        <SectionTitle>Salida</SectionTitle>
        <div className="flex gap-1.5">
          <input
            type="datetime-local"
            value={toLocalInput(departAt)}
            onChange={(e) => {
              const d = new Date(e.target.value);
              if (!Number.isNaN(d.getTime())) setDepartAt(d);
            }}
            aria-label="Hora de salida (hora de tu computadora)"
            title="Hora de tu computadora"
            className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 font-mono text-xs text-fg"
          />
          <button
            type="button"
            onClick={() => setDepartAt(new Date())}
            className="min-h-9 rounded-md border border-line px-3 text-xs text-muted hover:text-fg"
          >
            Ahora
          </button>
        </div>
        {origin ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">En Marte:</span>
            <span className="font-mono text-sm text-rust">{ltstShort(departAt, origin.lon)}</span>
            <span className="text-muted">LTST</span>
            <ProvenanceBadge source={MARS24_LTST} align="left" />
          </p>
        ) : null}
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={roundTrip}
            onChange={(e) => setRoundTrip(e.target.checked)}
            className="size-4 accent-rust"
          />
          <span>Incluir la vuelta al hábitat</span>
        </label>
        <p className={`text-[11px] ${roundTrip ? "text-muted" : "text-warn"}`}>
          {roundTrip
            ? "El veredicto cuenta O2, batería, dosis y luz hasta volver a A."
            : "Solo ida: el veredicto termina en el destino, sin la vuelta."}
        </p>
      </section>

      {waypoints.length > 0 ? <CargoPicker /> : null}

      {/* Puntos, en orden, con lo calculado */}
      {waypoints.length > 0 ? (
        <section data-edu="points" className="flex flex-col gap-2">
          <SectionTitle>
            Recorrido · {waypoints.length} {waypoints.length === 1 ? "punto" : "puntos"}
            {roundTrip && waypoints.length >= 2 ? " · ida y vuelta" : ""}
          </SectionTitle>

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
              Un clic en el mapa suma una parada antes del destino. Reordená arrastrando ⠿ o con ↑ ↓;
              los marcadores se mueven en el mapa.
            </Hint>
          ) : null}

          {firstStop ? <SourcesRow stop={firstStop} leg={route?.legs[0]} /> : null}
        </section>
      ) : null}
    </>
  );

  // Modo entrenamiento: las lecciones señalan piezas sueltas de la interfaz,
  // así que va todo apilado, sin pestañas que las escondan.
  if (eduOpen) {
    return (
      <div className="flex flex-col gap-4 text-sm">
        {noticeEl}
        {headerEl}
        {statusEl}
        {route ? (
          <div className="flex flex-col gap-3">
            {verdictEl}
            <DirectionsList route={route} example={result?.example ?? false} />
            <SafetyBreakdown verdict={route.verdict} cost={route.cost} />
            {shareEl}
          </div>
        ) : null}
        {waypoints.length > 0 ? <HabitatContact /> : null}
        {planEl}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      {noticeEl}
      {headerEl}
      {route ? (
        <VerdictStrip route={route} example={result?.example ?? false} onOpen={() => setTab("safety")} />
      ) : (
        statusEl
      )}

      <PlannerTabs current={current} hasRoute={route !== null} onPick={setTab} />

      <div role="tabpanel" className="flex flex-col gap-4 pt-1">
        {current === "navigate" && route ? (
          <>
            <NavigationView route={route} example={result?.example ?? false} />
            {shareEl}
          </>
        ) : current === "safety" && route ? (
          <>
            {statusEl}
            {verdictEl}
            <SafetyBreakdown verdict={route.verdict} cost={route.cost} />
            <HabitatContact />
          </>
        ) : current === "settings" ? (
          <RouteSettings />
        ) : (
          <>
            {route ? (
              <button
                type="button"
                onClick={() => setTab("navigate")}
                className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-rust text-base font-bold text-bg shadow-lg hover:brightness-110"
              >
                🧭 Navegar esta ruta
              </button>
            ) : null}
            {planEl}
          </>
        )}
      </div>
    </div>
  );
}

/* ——— partes ——— */

/** Tipo propio del arrastre: solo las tarjetas de la lista se pueden soltar ahí. */
const DRAG_TYPE = "application/x-mapeando-waypoint";

/**
 * Los tres pasos para armar una travesía, con el actual resaltado. Desaparece
 * cuando ya hay hábitat y destino: desde ahí manda el veredicto.
 */
function Steps({ count }: { readonly count: number }) {
  const steps = [
    ["Marcá el hábitat (A)", "Clic en el mapa, con el modo «＋ Puntos». Es de donde salís."],
    ["Elegí el destino (B)", "Buscalo por nombre, tocá un sugerido o hacé otro clic en el mapa."],
    ["Revisá el veredicto", "Sumá paradas, ajustá la hora de salida y mirá si da GO."],
  ] as const;
  return (
    <ol className="flex flex-col gap-2">
      {steps.map(([title, body], i) => {
        const state = i < count ? "done" : i === count ? "current" : "todo";
        return (
          <li
            key={title}
            aria-current={state === "current" ? "step" : undefined}
            className={`flex gap-3 rounded-lg border p-2.5 ${state === "current" ? "border-rust bg-rust/10" : "border-line"} ${state === "todo" ? "opacity-60" : ""}`}
          >
            <span
              aria-hidden
              className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${state === "done" ? "bg-ok text-bg" : state === "current" ? "bg-rust text-bg" : "border border-line text-muted"}`}
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">{title}</span>
              {state === "current" ? <span className="block text-xs text-muted">{body}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SectionTitle({ children }: { readonly children: ReactNode }) {
  return <h3 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{children}</h3>;
}

function TextButton({
  onClick,
  danger,
  children,
}: {
  readonly onClick: () => void;
  readonly danger?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-8 rounded-md px-2 hover:bg-line ${danger ? "text-rust" : "text-muted hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

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
      className="min-h-9 flex-1 rounded-md border border-line text-xs text-fg hover:border-muted"
    >
      {state === "copied"
        ? "✓ Enlace copiado"
        : state === "failed"
          ? "Copialo de la barra de direcciones"
          : "🔗 Copiar enlace"}
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

function Hint({ children }: { readonly children: ReactNode }) {
  return <p className="text-[11px] leading-snug text-muted">{children}</p>;
}

function ExampleNotice() {
  const p = EXAMPLE_PARAMS;
  return (
    <details className="rounded-lg border border-warn/60 bg-warn/10 p-2.5 text-[11px] leading-snug text-fg">
      <summary className="cursor-pointer">
        <strong className="text-warn">▲ Veredicto de ejemplo: no usar para decidir.</strong>
      </summary>
      <p className="mt-1.5">
        El server todavía no tiene <code>/api/route</code>: esto lo calcula el frontend en línea
        recta, sin terreno, con parámetros supuestos ({p.walkSpeedKmh} km/h, {p.o2Hours} h de O2 y
        de batería, reserva de {p.reserveMin} min, luz de {p.daylightLtst.from} a{" "}
        {p.daylightLtst.to} h LTST). No usa la carga del equipo: eso lo calcula el server con Pandolf.
      </p>
    </details>
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
    <details className="rounded-lg border border-line p-2.5 text-[11px]">
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

const DOT: Record<ReturnType<typeof waypointLabel>["kind"], string> = {
  origin: "bg-ok text-bg",
  return: "bg-ok text-bg",
  destination: "bg-alert text-bg",
  station: "bg-panel text-fg",
};

/**
 * Un punto del recorrido. Plegado muestra lo que se mira de un vistazo
 * (nombre, horas y consumibles); abierto, la tarea, los minutos, la ficha del
 * lugar y la foto del rover.
 */
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
  const departAt = usePlan((s) => s.departAt);

  return (
    <div
      className={`rounded-lg border p-2.5 ${open ? "border-rust bg-rust/5" : outside ? "border-alert" : "border-line"}`}
      onFocus={() => setOpenStop(index)}
    >
      <div className="flex items-center gap-2">
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, waypoint.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          title="Arrastrar para reordenar"
          aria-hidden
          className="-ml-1 cursor-grab px-0.5 text-muted select-none active:cursor-grabbing"
        >
          ⠿
        </span>
        <span
          aria-hidden
          className={`grid size-7 shrink-0 place-items-center rounded-full border-2 border-fg text-xs font-bold ${DOT[label.kind]}`}
        >
          {label.short}
        </span>
        <button
          type="button"
          onClick={() => setOpenStop(open ? null : index)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate font-semibold">
            {place ? place.name : label.long}
          </span>
          <span className="block truncate text-[11px] text-muted">
            {place ? `${label.long} · ` : ""}
            <span className="font-mono">{formatLatLon(waypoint)}</span>
          </span>
        </button>
        <IconButton label="Quitar" onClick={() => removePoint(waypoint.id)}>
          ✕
        </IconButton>
      </div>

      {outside ? (
        <p role="alert" className="mt-2 rounded-md bg-alert/15 p-1.5 text-[11px] text-fg">
          <strong className="text-alert">✕ Sin terreno de 1 m real.</strong> Este punto queda fuera
          del DTM HiRISE: movelo o quitalo antes de confiar en la ruta.
        </p>
      ) : null}

      {!open && waypoint.task ? <p className="mt-1.5 truncate text-xs">“{waypoint.task}”</p> : null}

      {stop ? <StopValues stop={stop} reference={reference} /> : null}

      {open ? (
        <div className="mt-2.5 flex flex-col gap-2.5 border-t border-line pt-2.5">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={waypoint.task}
              onChange={(e) => updatePoint(waypoint.id, { task: e.target.value })}
              placeholder={isStation ? "Tarea (ej. tomar muestra)" : "Tarea (opcional)"}
              aria-label={`Tarea en ${label.long}`}
              className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-xs text-fg placeholder:text-muted/70"
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
                  className="min-h-9 w-16 rounded-md border border-line bg-bg px-1.5 text-right font-mono text-xs text-fg"
                />
                min
              </label>
            ) : null}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <span>Orden:</span>
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
          </div>
          {waypoint.placeId && !place ? (
            <p className="text-[11px] text-muted">Lugar {waypoint.placeId} (el índice de lugares no cargó)</p>
          ) : null}
          {place ? <PlaceCard place={place} /> : null}
          <StationPhoto
            siteId={siteId}
            lat={waypoint.lat}
            lon={waypoint.lon}
            title={label.long}
            at={stop?.arrive_utc ? new Date(stop.arrive_utc) : departAt}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpenStop(index)}
          className="mt-1.5 text-[11px] text-rust hover:underline"
        >
          {hasDwell ? "Tarea, minutos y fotos ›" : "Tarea y fotos ›"}
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
    <div className="rounded-lg border border-dashed border-line p-2.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full border-2 border-fg bg-ok text-xs font-bold text-bg"
        >
          {label.short}
        </span>
        <div className="min-w-0 flex-1">
          <span className="block font-semibold">{label.long}</span>
          <span className="block font-mono text-[11px] text-muted">{formatLatLon(stop)}</span>
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
  const times = [
    ["Llega", stop.arrive_utc],
    ["Sale", stop.depart_utc],
  ] as const;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <p className="flex flex-wrap gap-x-3 text-xs">
        {times.map(([what, utc]) =>
          utc ? (
            <span key={what} title={`Tu hora: ${earthShort(utc)}`}>
              <span className="text-muted">{what} </span>
              <span className="font-mono">{ltstShort(utc, stop.lon)}</span>
              <span className="text-[10px] text-muted"> LTST</span>
            </span>
          ) : null,
        )}
      </p>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
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
        <dt className="text-muted">Dosis acum.</dt>
        <dd className="text-right">
          <Measure
            data={stop.dose_accumulated}
            format={(v) => v.toFixed(3)}
            badge={badgeFor(stop.dose_accumulated, reference?.dose_accumulated)}
          />
        </dd>
      </dl>
    </div>
  );
}

/** Tramo entre dos puntos: clase de terreno (palabra + color), distancia, tiempo y rumbo. */
function LegRow({ leg, reference }: { readonly leg: RouteLeg; readonly reference: RouteLeg | undefined }) {
  const color = LEG_CLASS_COLOR[leg.class];
  const same = (v: MeasuredValue, r: MeasuredValue | undefined) => repeatedBadge(v, r);
  return (
    <div
      className={`ml-[1.35rem] flex flex-col gap-0.5 border-l-4 py-2 pl-4 text-[11px] ${leg.class === "unknown" ? "border-dashed" : ""}`}
      style={{ borderColor: color }}
    >
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
      <span className="flex items-center gap-1 text-muted">
        Pendiente máx.
        <Measure data={leg.max_slope} format={(v) => v.toFixed(0)} />
      </span>
    </div>
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
      className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-line hover:text-fg disabled:opacity-30"
    >
      {children}
    </button>
  );
}
