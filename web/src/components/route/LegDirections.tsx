import type { Direction } from "../../api/schemas";
import {
  DIRECTION_ICON,
  FALLBACK_LABEL,
  LANDMARK_CATALOG_LABEL,
  LANDMARK_SOURCE,
  isFallback,
} from "../../domain/landmarks";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { formatDistanceM } from "./format";

/**
 * Indicaciones de un tramo, para seguir mirando el paisaje: "Caminá hacia X".
 *
 * Cada una dice de dónde sale el landmark (IAU, Robbins o extraído del relieve)
 * y qué parte del tramo se ve. Un respaldo (sin nada visible) se marca como tal,
 * con borde y etiqueta, no solo con color. Sin `directions` en la ruta, dice
 * que falta: no se arma una indicación en el cliente.
 */
interface Props {
  readonly directions: readonly Direction[] | undefined;
}

const pct = (v: number) => `${Math.round(v * 100)} % del tramo`;

export function LegDirections({ directions }: Props) {
  if (!directions || directions.length === 0) {
    return (
      <p className="text-[11px] text-muted">
        Indicaciones por landmarks: falta el dato (el server todavía no las calcula).
      </p>
    );
  }

  return (
    <ol className="mt-1 flex flex-col gap-1.5" aria-label="Indicaciones del tramo">
      {directions.map((d, i) => (
        <li key={`${d.kind}-${i}`}>
          {isFallback(d.kind) ? <Fallback direction={d} /> : <WithLandmark direction={d} />}
        </li>
      ))}
    </ol>
  );
}

function WithLandmark({ direction: d }: { readonly direction: Direction }) {
  const lm = d.landmark;
  return (
    <div className="rounded border border-line bg-bg/40 p-2">
      <p className="flex gap-2 text-sm leading-snug text-fg">
        <span aria-hidden className="font-bold text-rust">
          {DIRECTION_ICON[d.kind]}
        </span>
        <span>{d.text}</span>
      </p>
      <div className="mt-1.5 flex flex-col gap-1 text-[11px] text-muted">
        {lm ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-fg/90">{lm.name}</span>
            <span>· {LANDMARK_CATALOG_LABEL[lm.source]}</span>
            <ProvenanceBadge source={LANDMARK_SOURCE[lm.source]} align="left" />
          </span>
        ) : null}
        <span className="flex flex-wrap items-center gap-1.5">
          Visibilidad
          <Measure data={{ ...d.visible_fraction, unit: null }} format={pct} align="left" />
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          Durante
          <Measure data={{ ...d.distance, unit: null }} format={formatDistanceM} align="left" />
        </span>
      </div>
    </div>
  );
}

function Fallback({ direction: d }: { readonly direction: Direction }) {
  return (
    <div className="rounded border border-dashed border-warn/70 bg-warn/10 p-2">
      <p className="mb-1 text-[10px] font-semibold tracking-wide text-warn uppercase">
        <span aria-hidden>{DIRECTION_ICON[d.kind]} </span>
        {FALLBACK_LABEL[d.kind] ?? "Respaldo"} · sin referencia visible
      </p>
      <p className="text-sm leading-snug text-fg">{d.text}</p>
      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        Durante
        <Measure data={{ ...d.distance, unit: null }} format={formatDistanceM} align="left" />
      </span>
    </div>
  );
}
