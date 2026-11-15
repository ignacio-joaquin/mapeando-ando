import type { LimitingFactor, Verdict } from "../../api/schemas";
import { Measure } from "../Measure";
import { formatMinutes } from "./format";

/**
 * Veredicto GO / CAUTION / NO-GO, grande. Se lee con el casco puesto: la palabra
 * y el símbolo dicen el resultado aunque no se distinga el color.
 *
 * Debajo: puntaje (eslabón más débil), qué limita y en cuántos escenarios de
 * estrés aguanta. El detalle por límite está en <SafetyBreakdown>.
 */
export const FACTOR_LABEL: Record<LimitingFactor, string> = {
  o2: "Oxígeno",
  battery: "Batería",
  dose: "Dosis de radiación",
  daylight: "Regreso antes del atardecer",
  terrain: "Pendiente",
  contact: "Tiempo sin contacto",
  calories: "Calorías",
};

const LOOK = {
  GO: { word: "GO", icon: "✓", box: "border-ok bg-ok/10", text: "text-ok" },
  CAUTION: { word: "CAUTION", icon: "⚠", box: "border-warn bg-warn/10", text: "text-warn" },
  NO_GO: { word: "NO-GO", icon: "✕", box: "border-alert bg-alert/15", text: "text-alert" },
} as const;

interface Props {
  readonly verdict: Verdict;
}

export function VerdictCard({ verdict }: Props) {
  const look = LOOK[verdict.status];
  const rob = verdict.robustness;
  const skipped = rob ? rob.scenarios.length - rob.evaluated : 0;
  return (
    <section data-edu="verdict" aria-live="polite" className={`rounded border-2 p-3 ${look.box}`}>
      <div className="flex items-baseline gap-3">
        <span aria-hidden className={`text-3xl font-black ${look.text}`}>
          {look.icon}
        </span>
        <span className={`text-4xl font-black tracking-tight ${look.text}`}>{look.word}</span>
        {verdict.score && verdict.score.value !== null ? (
          <span className="ml-auto text-right font-mono text-2xl font-bold text-fg">
            {Math.round(verdict.score.value)}
            <span className="text-xs font-normal text-muted">/100</span>
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm font-medium text-fg">{verdict.summary}</p>
      <dl className="mt-2 flex flex-col gap-1 text-xs">
        {verdict.limiting_factor ? (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Limita</dt>
            <dd className="font-semibold">{FACTOR_LABEL[verdict.limiting_factor]}</dd>
          </div>
        ) : null}
        {verdict.score ? (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted">Puntaje (margen más chico)</dt>
            <dd>
              <Measure data={verdict.score} format={(v) => String(Math.round(v))} align="left" />
            </dd>
          </div>
        ) : null}
        {rob ? (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Robustez</dt>
            <dd className="text-right font-semibold">
              {rob.passed} de {rob.evaluated} escenarios
              {skipped > 0 ? <span className="font-normal text-muted"> · {skipped} sin evaluar</span> : null}
            </dd>
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
