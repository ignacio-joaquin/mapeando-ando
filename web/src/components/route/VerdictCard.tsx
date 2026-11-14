import type { LimitingFactor, Verdict } from "../../api/schemas";
import { Measure } from "../Measure";
import { formatMinutes } from "./format";

/**
 * Veredicto GO / NO-GO, grande. Se lee con el casco puesto: la palabra y el
 * símbolo dicen el resultado aunque no se distinga el color.
 */
const FACTOR_LABEL: Record<LimitingFactor, string> = {
  o2: "Oxígeno",
  battery: "Batería",
  dose: "Dosis de radiación",
  daylight: "Luz solar",
  terrain: "Terreno",
};

interface Props {
  readonly verdict: Verdict;
}

export function VerdictCard({ verdict }: Props) {
  const go = verdict.status === "GO";
  return (
    <section
      aria-live="polite"
      className={`rounded border-2 p-3 ${go ? "border-ok bg-ok/10" : "border-alert bg-alert/15"}`}
    >
      <div className="flex items-baseline gap-3">
        <span aria-hidden className={`text-3xl font-black ${go ? "text-ok" : "text-alert"}`}>
          {go ? "✓" : "✕"}
        </span>
        <span className={`text-4xl font-black tracking-tight ${go ? "text-ok" : "text-alert"}`}>
          {go ? "GO" : "NO-GO"}
        </span>
      </div>
      <p className="mt-1 text-sm font-medium text-fg">{verdict.summary}</p>
      <dl className="mt-2 flex flex-col gap-1 text-xs">
        {verdict.limiting_factor ? (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Factor limitante</dt>
            <dd className="font-semibold">{FACTOR_LABEL[verdict.limiting_factor]}</dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">Reserva al llegar</dt>
          <dd>
            <Measure data={{ ...verdict.margin, unit: null }} format={formatMinutes} align="left" />
          </dd>
        </div>
      </dl>
    </section>
  );
}
