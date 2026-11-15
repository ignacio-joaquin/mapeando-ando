import type { RouteResponse } from "../../api/schemas";
import {
  CHECK_ICON,
  DIRECTION_ICON,
  FALLBACK_LABEL,
  LANDMARK_CATALOG_LABEL,
  LANDMARK_SOURCE,
  isFallback,
} from "../../domain/landmarks";
import { routeSteps, type RouteStep } from "../../domain/steps";
import { stopLabel } from "../../map/route";
import { usePlan } from "../../state/plan";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { formatDistanceM, formatMinutes } from "./format";

/**
 * Indicaciones paso a paso, como en Google Maps pero sin GPS: cada paso nombra
 * algo que se ve desde el trecho, en posición de reloj ("…hacia el cráter X, a
 * las 2"), con confirmaciones ("Vas bien si…": el Sol y la sombra, el mástil
 * del hábitat, cómo se ve el landmark) y una señal de parada ("Pará cuando…").
 *
 * Pasar el mouse (o el foco) por un paso lo resalta en el mapa con su línea de
 * vista; un clic lo fija y lo encuadra. Un respaldo (nada visible) se marca
 * con borde punteado y etiqueta, no solo con color.
 */
interface Props {
  readonly route: RouteResponse;
  /** La ruta la calculó el planificador de ejemplo: no se evaluó qué se ve. */
  readonly example?: boolean;
}

const pct = (v: number) => `${Math.round(v * 100)} % del trecho`;

export function DirectionsList({ route, example = false }: Props) {
  const roundTrip = usePlan((s) => s.roundTrip);
  const steps = routeSteps(route);
  const stops = route.stops.length;

  return (
    <section aria-labelledby="indicaciones-titulo" className="flex flex-col gap-2">
      <div>
        <h3 id="indicaciones-titulo" className="text-xs font-semibold tracking-wide text-muted uppercase">
          Indicaciones{steps.length ? ` · ${steps.length} ${steps.length === 1 ? "paso" : "pasos"}` : ""}
        </h3>
        <p className="text-[11px] text-muted">
          Sin GPS ni brújula: cada paso nombra algo que vas a ver desde ahí.
        </p>
      </div>

      {steps.length === 0 ? (
        <p className="rounded border border-line p-2 text-[11px] text-warn">
          Falta el dato: el server todavía no calcula indicaciones para esta ruta.
        </p>
      ) : (
        <>
          {example ? (
            <p className="rounded border border-warn/60 bg-warn/10 p-2 text-[11px] text-fg">
              El planificador de ejemplo no evalúa qué se ve: solo da el respaldo por rumbo. Las
              indicaciones con landmarks las calcula el server.
            </p>
          ) : steps.every((s) => isFallback(s.direction.kind)) ? (
            <p className="rounded border border-warn/60 bg-warn/10 p-2 text-[11px] text-fg">
              Ningún paso tiene un landmark: todos son de respaldo, por rumbo. Cada uno dice por qué.
            </p>
          ) : null}
          <ol className="flex flex-col gap-2">
            {route.legs.map((_, li) => {
              const legSteps = steps.filter((s) => s.leg === li);
              if (legSteps.length === 0) return null;
              const from = stopLabel(li, stops, roundTrip);
              const to = stopLabel(li + 1, stops, roundTrip);
              return (
                <li key={li}>
                  <p className="mb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
                    {from.short} → {to.short} · {from.long} a {to.long.toLowerCase()}
                  </p>
                  <ol className="flex flex-col gap-1.5">
                    {legSteps.map((st) => (
                      <StepItem key={st.index} step={st} />
                    ))}
                  </ol>
                </li>
              );
            })}
          </ol>
          <p className="text-[10px] text-muted">
            Pasá el mouse por un paso para verlo en el mapa; tocalo para encuadrarlo.
          </p>
        </>
      )}
    </section>
  );
}

function StepItem({ step }: { readonly step: RouteStep }) {
  const active = usePlan((s) => s.activeStep);
  const { setActiveStep } = usePlan.getState();
  const d = step.direction;
  const fallback = isFallback(d.kind);
  const isActive = active?.index === step.index;
  const pinned = isActive && active.pinned;

  const hover = (on: boolean) => {
    const cur = usePlan.getState().activeStep;
    if (cur?.pinned) return; // uno fijado con clic manda
    setActiveStep(on ? { index: step.index, pinned: false } : null);
  };

  const tone = fallback
    ? "border-dashed border-warn/70 bg-warn/10"
    : isActive
      ? "border-rust bg-rust/10"
      : "border-line bg-bg/40";

  return (
    <li
      className={`rounded border p-2 ${tone} ${isActive && fallback ? "ring-1 ring-rust" : ""}`}
      onMouseEnter={() => hover(true)}
      onMouseLeave={() => hover(false)}
    >
      <button
        type="button"
        aria-pressed={pinned}
        onClick={() => setActiveStep(pinned ? null : { index: step.index, pinned: true })}
        onFocus={() => hover(true)}
        onBlur={() => hover(false)}
        className="flex w-full gap-2 text-left"
      >
        <span
          className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-bold ${
            isActive ? "border-rust text-rust" : "border-line text-muted"
          }`}
        >
          {step.index + 1}
        </span>
        <span className="min-w-0 flex-1">
          {fallback ? (
            <span className="mb-0.5 block text-[10px] font-semibold tracking-wide text-warn uppercase">
              <span aria-hidden>{DIRECTION_ICON[d.kind]} </span>
              {FALLBACK_LABEL[d.kind] ?? "Respaldo"}
            </span>
          ) : null}
          <span className="flex gap-1.5 text-sm leading-snug text-fg">
            {!fallback ? (
              <span aria-hidden className="font-bold text-rust">
                {DIRECTION_ICON[d.kind]}
              </span>
            ) : null}
            <span>{d.text}</span>
          </span>
        </span>
      </button>

      {d.checks && d.checks.length > 0 ? (
        <div className="mt-2 ml-7">
          <p className="text-[10px] font-semibold tracking-wide text-muted uppercase">Vas bien si</p>
          <ul className="mt-0.5 flex flex-col gap-1">
            {d.checks.map((c, k) => (
              <li key={k} className="flex items-start gap-1.5 text-xs leading-snug text-fg/90">
                <span aria-hidden className="w-3 shrink-0 text-center text-muted">
                  {CHECK_ICON[c.kind]}
                </span>
                <span className="min-w-0 flex-1">{c.text}</span>
                <ProvenanceBadge source={c} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {d.until ? (
        <p className="mt-2 ml-7 flex items-start gap-1.5 rounded border border-line bg-bg/60 px-2 py-1 text-xs leading-snug text-fg">
          <span aria-hidden className="text-rust">■</span>
          <span>{d.until.text}</span>
        </p>
      ) : null}

      <div className="mt-1.5 ml-7 flex flex-col gap-1 text-[11px] text-muted">
        {d.landmark ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-fg/90">{d.landmark.name}</span>
            <span>· {LANDMARK_CATALOG_LABEL[d.landmark.source]}</span>
            <ProvenanceBadge source={LANDMARK_SOURCE[d.landmark.source]} align="left" />
          </span>
        ) : null}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {!fallback ? (
            <span className="inline-flex items-center gap-1.5">
              visible
              <Measure data={{ ...d.visible_fraction, unit: null }} format={pct} align="left" />
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            trecho
            <Measure data={{ ...d.distance, unit: null }} format={formatDistanceM} align="left" />
          </span>
          {d.duration ? (
            <span className="inline-flex items-center gap-1.5">
              ≈
              <Measure data={{ ...d.duration, unit: null }} format={formatMinutes} align="left" />
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
}
