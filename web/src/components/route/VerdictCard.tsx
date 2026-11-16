import type { DataQuality, LimitingFactor, Verdict } from "../../api/schemas";
import { Measure } from "../Measure";
import { formatMinutes } from "./format";
import { useT, useTr } from "../../i18n/lang";

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
  readonly dataQuality?: DataQuality;
}

export function VerdictCard({ verdict, dataQuality }: Props) {
  const t = useT();
  const tr = useTr();
  const look = LOOK[verdict.status];
  const rob = verdict.robustness;
  const skipped = rob ? rob.scenarios.length - rob.evaluated : 0;
  const dataNotes: string[] = [];
  if (dataQuality) {
    const lightStatus = dataQuality.light_status ?? (dataQuality.light_evaluated ? "complete" : "missing");
    if (lightStatus === "missing") {
      dataNotes.push(t("luz sin evaluar", "daylight not evaluated"));
    } else {
      if (dataQuality.light_source === "reused") {
        dataNotes.push(t("luz estimada con otro sol de la misma estación", "daylight estimated with another sol from the same season"));
      } else if (lightStatus === "partial") {
        dataNotes.push(t("luz parcialmente evaluada", "daylight partially evaluated"));
      }
    }
    if (!dataQuality.contact_evaluated) dataNotes.push(t("contacto sin evaluar", "contact not evaluated"));
    const terrainStatus = dataQuality.terrain_status ?? (dataQuality.terrain_evaluated ? "complete" : "missing");
    if (terrainStatus !== "complete") dataNotes.push(t("terreno sin evaluar", "terrain not evaluated"));
  }
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
      <p className="mt-1 text-sm font-medium text-fg">{tr(verdict.summary)}</p>
      {dataNotes.length ? (
        <p className="mt-1 text-[11px] font-medium text-warn">
          {t("Datos del cálculo", "Calculation data")}: {dataNotes.join(" · ")}.
        </p>
      ) : null}
      <dl className="mt-2 flex flex-col gap-1 text-xs">
        {verdict.limiting_factor ? (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">{t("Limita", "Limiting factor")}</dt>
            <dd className="font-semibold">{tr(FACTOR_LABEL[verdict.limiting_factor])}</dd>
          </div>
        ) : null}
        {verdict.score ? (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted">{t("Puntaje (margen más chico)", "Score (smallest margin)")}</dt>
            <dd>
              <Measure data={verdict.score} format={(v) => String(Math.round(v))} align="left" />
            </dd>
          </div>
        ) : null}
        {rob ? (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">{t("Robustez", "Robustness")}</dt>
            <dd className="text-right font-semibold">
              {t(`${rob.passed} de ${rob.evaluated} escenarios`, `${rob.passed} of ${rob.evaluated} scenarios`)}
              {skipped > 0 ? (
                <span className="font-normal text-muted"> · {t(`${skipped} sin evaluar`, `${skipped} not evaluated`)}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">{t("Reserva al llegar", "Reserve on arrival")}</dt>
          <dd>
            <Measure data={{ ...verdict.margin, unit: null }} format={formatMinutes} align="left" />
          </dd>
        </div>
      </dl>
    </section>
  );
}
