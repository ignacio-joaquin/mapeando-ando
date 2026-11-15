import { useEffect, type ReactNode } from "react";
import type { RouteResponse, RouteStop } from "../../api/schemas";
import {
  CHECK_ICON,
  DIRECTION_ICON,
  FALLBACK_LABEL,
  LANDMARK_CATALOG_LABEL,
  LANDMARK_SOURCE,
  isFallback,
} from "../../domain/landmarks";
import { routeSteps, type RouteStep } from "../../domain/steps";
import { LEG_CLASS_COLOR, LEG_CLASS_LABEL, stopLabel } from "../../map/route";
import { usePlan } from "../../state/plan";
import { useUi } from "../../state/ui";
import { MARS24_LTST } from "../../domain/provenance";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { formatDistanceM, formatMinutes, ltstShort } from "./format";

/**
 * Navegación paso a paso, la pestaña para usar afuera con el casco puesto: un
 * paso por pantalla, en grande, con hacia dónde mirar (posición de reloj del
 * landmark respecto de la marcha), cuánto falta, cómo saber que vas bien y
 * cuándo parar. Cada paso se encuadra en el mapa. Se avanza con los botones o
 * con ← →.
 *
 * Todo sale de `legs[].directions` de /api/route: acá no se calcula nada nuevo.
 * Sin indicaciones lo dice; no se inventa un landmark.
 */
interface Props {
  readonly route: RouteResponse;
  readonly example: boolean;
}

export function NavigationView({ route, example }: Props) {
  const steps = routeSteps(route);
  const navStep = useUi((s) => s.navStep);
  const { setNavStep } = useUi.getState();
  const roundTrip = usePlan((s) => s.roundTrip);
  const i = Math.min(navStep, Math.max(steps.length - 1, 0));
  const step = steps[i];

  // El paso abierto se encuadra en el mapa, con su línea de vista.
  useEffect(() => {
    if (steps.length === 0) return;
    usePlan.getState().setActiveStep({ index: i, pinned: true });
  }, [i, steps.length]);

  // ← → para avanzar, salvo escribiendo en un campo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") setNavStep(Math.min(i + 1, steps.length - 1));
      if (e.key === "ArrowLeft") setNavStep(Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, steps.length, setNavStep]);

  if (!step) {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-lg border border-warn/60 bg-warn/10 p-3 text-xs text-fg">
          <strong className="text-warn">Falta el dato:</strong> el server no devolvió indicaciones para
          esta ruta. Seguí los tramos de la pestaña Recorrido por rumbo y distancia.
        </p>
      </div>
    );
  }

  const d = step.direction;
  const fallback = isFallback(d.kind);
  const stops = route.stops.length;
  const from = stopLabel(step.leg, stops, roundTrip);
  const to = stopLabel(step.leg + 1, stops, roundTrip);
  const leg = route.legs[step.leg];
  const lastOfLeg = steps[i + 1]?.leg !== step.leg;
  const arrival = lastOfLeg ? route.stops[step.leg + 1] : undefined;
  const done = i === steps.length - 1;

  return (
    <div className="flex flex-col gap-3">
      {example ? (
        <p className="rounded-md border border-warn/60 bg-warn/10 p-2 text-[11px] text-fg">
          <strong className="text-warn">Ejemplo:</strong> el planificador de ejemplo no evalúa qué se
          ve, solo da el respaldo por rumbo. No usar para decidir.
        </p>
      ) : null}

      <Progress steps={steps} current={i} onPick={setNavStep} />

      {/* Tramo en el que estás */}
      <div className="flex items-center gap-2 text-[11px]">
        <span className="rounded bg-line px-1.5 py-0.5 font-bold text-fg">
          {from.short} → {to.short}
        </span>
        <span className="truncate text-muted">
          {from.long} a {to.long.toLowerCase()}
        </span>
        {leg ? (
          <span
            className="ml-auto shrink-0 font-semibold"
            style={{ color: LEG_CLASS_COLOR[leg.class] }}
          >
            {LEG_CLASS_LABEL[leg.class]}
          </span>
        ) : null}
      </div>

      {/* El paso, en grande */}
      <section
        aria-live="polite"
        aria-label={`Paso ${i + 1} de ${steps.length}`}
        className={`relative overflow-hidden rounded-2xl border-2 p-4 shadow-xl ${
          fallback ? "border-dashed border-warn bg-warn/5" : "border-rust bg-gradient-to-b from-rust/20 to-panel"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">
              Paso {i + 1} de {steps.length}
            </p>
            {fallback ? (
              <p className="mt-0.5 text-[11px] font-bold tracking-wide text-warn uppercase">
                {DIRECTION_ICON[d.kind]} {FALLBACK_LABEL[d.kind] ?? "Respaldo"}
              </p>
            ) : null}
          </div>
          <Dial step={step} />
        </div>

        <p className="mt-2 text-lg leading-snug font-bold text-fg">
          {!fallback ? (
            <span aria-hidden className="mr-1.5 text-rust">
              {DIRECTION_ICON[d.kind]}
            </span>
          ) : null}
          {d.text}
        </p>

        {d.landmark ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span className="font-semibold text-fg">{d.landmark.name}</span>·{" "}
            {LANDMARK_CATALOG_LABEL[d.landmark.source]}
            <ProvenanceBadge source={LANDMARK_SOURCE[d.landmark.source]} align="left" />
          </p>
        ) : null}

        <dl className="mt-3 flex flex-col gap-1.5">
          <Stat label="Trecho">
            <Measure data={{ ...d.distance, unit: null }} format={formatDistanceM} size="lg" align="left" />
          </Stat>
          <Stat label="Tiempo">
            {d.duration ? (
              <Measure data={{ ...d.duration, unit: null }} format={formatMinutes} size="lg" align="left" />
            ) : (
              <span className="font-mono text-base text-warn">falta el dato</span>
            )}
          </Stat>
        </dl>
      </section>

      {/* Vas bien si… */}
      {d.checks && d.checks.length > 0 ? (
        <section className="rounded-lg border border-line p-3">
          <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-ok uppercase">✓ Vas bien si</h3>
          <ul className="flex flex-col gap-1.5">
            {d.checks.map((c, k) => (
              <li key={k} className="flex items-start gap-2 text-sm leading-snug">
                <span aria-hidden className="w-4 shrink-0 text-center text-muted">
                  {CHECK_ICON[c.kind]}
                </span>
                <span className="min-w-0 flex-1">{c.text}</span>
                <ProvenanceBadge source={c} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Pará cuando… */}
      {d.until ? (
        <section className="rounded-lg border-2 border-warn bg-warn/10 p-3">
          <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-warn uppercase">■ Pará cuando</h3>
          <p className="text-sm leading-snug font-semibold">{d.until.text}</p>
        </section>
      ) : null}

      {arrival ? <Arrival stop={arrival} label={to.long} short={to.short} /> : null}

      {/* Anterior / siguiente */}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={i === 0}
          onClick={() => setNavStep(i - 1)}
          className="min-h-12 flex-1 rounded-xl border border-line text-sm font-semibold hover:border-muted disabled:opacity-30"
        >
          ← Anterior
        </button>
        <button
          type="button"
          disabled={done}
          onClick={() => setNavStep(i + 1)}
          className="min-h-12 flex-[2] rounded-xl bg-rust text-base font-bold text-bg shadow-lg hover:brightness-110 disabled:opacity-40"
        >
          {done ? "✓ Fin de la travesía" : "Siguiente paso →"}
        </button>
      </div>
      <p className="text-center text-[10px] text-muted">También con las flechas ← → del teclado.</p>

      {/* Todos los pasos */}
      <details className="rounded-lg border border-line p-2.5">
        <summary className="cursor-pointer text-xs text-muted">Todos los pasos ({steps.length})</summary>
        <ol className="mt-2 flex flex-col gap-1">
          {steps.map((s) => (
            <li key={s.index}>
              <button
                type="button"
                aria-current={s.index === i ? "step" : undefined}
                onClick={() => setNavStep(s.index)}
                className={`flex w-full gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-line ${s.index === i ? "bg-rust/15 text-fg" : "text-fg/80"}`}
              >
                <span className="w-5 shrink-0 text-right font-mono text-muted">{s.index + 1}</span>
                <span aria-hidden className="w-4 shrink-0 text-center text-rust">
                  {DIRECTION_ICON[s.direction.kind]}
                </span>
                <span className="min-w-0 flex-1">{s.direction.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** Barra de progreso: un segmento por paso; los de respaldo, rayados. */
function Progress({
  steps,
  current,
  onPick,
}: {
  readonly steps: readonly RouteStep[];
  readonly current: number;
  readonly onPick: (i: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span className="font-semibold text-fg">🧭 Navegación</span>
        <span className="tabular-nums">
          {Math.round(((current + 1) / steps.length) * 100)} %
        </span>
      </div>
      <ol className="flex gap-1" aria-label="Progreso de la travesía">
        {steps.map((s) => {
          const fb = isFallback(s.direction.kind);
          const state = s.index < current ? "done" : s.index === current ? "now" : "todo";
          return (
            <li key={s.index} className="flex-1">
              <button
                type="button"
                onClick={() => onPick(s.index)}
                aria-label={`Ir al paso ${s.index + 1}`}
                aria-current={state === "now" ? "step" : undefined}
                className={`block h-2.5 w-full rounded-full transition-colors ${
                  state === "now" ? "bg-rust ring-2 ring-rust/40" : state === "done" ? "bg-rust/60" : "bg-line"
                }`}
                style={
                  fb
                    ? { backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, rgb(0 0 0 / 0.35) 3px 6px)" }
                    : undefined
                }
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Dial de reloj: la flecha es hacia dónde caminás (las 12); el punto, dónde
 * está el landmark. En los respaldos no hay landmark: muestra el ícono.
 */
function Dial({ step }: { readonly step: RouteStep }) {
  const d = step.direction;
  const rel = d.relative_bearing_deg;
  const size = 88;
  const r = 36;
  const c = size / 2;
  const mark =
    rel === null
      ? null
      : {
          x: c + r * Math.sin((rel * Math.PI) / 180),
          y: c - r * Math.cos((rel * Math.PI) / 180),
        };
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={
        d.clock ? `El landmark está a las ${d.clock}, mirando hacia donde caminás` : "Sin landmark: guiate por el respaldo"
      }
      className="shrink-0"
    >
      <circle cx={c} cy={c} r={r + 6} className="fill-bg/70 stroke-line" strokeWidth={1.5} />
      {[0, 90, 180, 270].map((a) => (
        <line
          key={a}
          x1={c + (r + 1) * Math.sin((a * Math.PI) / 180)}
          y1={c - (r + 1) * Math.cos((a * Math.PI) / 180)}
          x2={c + (r + 6) * Math.sin((a * Math.PI) / 180)}
          y2={c - (r + 6) * Math.cos((a * Math.PI) / 180)}
          className="stroke-muted"
          strokeWidth={1.5}
        />
      ))}
      {/* Hacia dónde caminás */}
      <path d={`M ${c} ${c - 22} L ${c - 9} ${c + 8} L ${c} ${c + 2} L ${c + 9} ${c + 8} Z`} className="fill-fg" />
      {mark ? (
        <>
          <line x1={c} y1={c} x2={mark.x} y2={mark.y} className="stroke-rust" strokeWidth={2} strokeDasharray="3 3" />
          <circle cx={mark.x} cy={mark.y} r={7} className="fill-rust stroke-bg" strokeWidth={2} />
        </>
      ) : null}
      {d.clock ? (
        <text x={c} y={size - 4} textAnchor="middle" className="fill-fg text-[10px] font-bold">
          a las {d.clock}
        </text>
      ) : null}
    </svg>
  );
}

function Stat({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-bg/50 px-2.5 py-1.5">
      <dt className="text-[10px] font-semibold tracking-wider text-muted uppercase">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Al terminar un tramo: a qué hora llegás y con cuánto. */
function Arrival({ stop, label, short }: { readonly stop: RouteStop; readonly label: string; readonly short: string }) {
  return (
    <section className="rounded-lg border border-ok/60 bg-ok/10 p-3">
      <h3 className="mb-1.5 flex items-center gap-2 text-sm font-bold">
        <span className="grid size-6 place-items-center rounded-full bg-ok text-xs text-bg">{short}</span>
        Llegás a {label.toLowerCase()}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
        {stop.arrive_utc ? (
          <>
            <dt className="text-muted">Hora</dt>
            <dd className="flex items-center justify-end gap-1.5">
              <span className="font-mono">{ltstShort(stop.arrive_utc, stop.lon)}</span>
              <span className="text-muted">LTST</span>
              <ProvenanceBadge source={MARS24_LTST} />
            </dd>
          </>
        ) : null}
        <dt className="text-muted">O2</dt>
        <dd className="text-right">
          <Measure data={stop.o2_remaining} format={(v) => v.toFixed(1)} />
        </dd>
        <dt className="text-muted">Batería</dt>
        <dd className="text-right">
          <Measure data={stop.battery_remaining} format={(v) => v.toFixed(0)} />
        </dd>
      </dl>
    </section>
  );
}
