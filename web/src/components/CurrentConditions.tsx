import { useEffect, useState } from "react";
import { fetchCurrentConditions } from "../api/client";
import type { CurrentConditionsData } from "../api/schemas";
import { Measure } from "./Measure";
import { useT, useTr } from "../i18n/lang";

interface Props {
  readonly siteId: string;
}

type Severity = CurrentConditionsData["alerts"][number]["severity"];

const SEVERITY_EN: Record<string, string> = { alto: "high", moderado: "moderate", bajo: "low" };

function alertTone(severity: Severity) {
  if (severity === "alto") return "border-alert bg-alert/15 text-alert";
  if (severity === "moderado") return "border-warn bg-warn/10 text-warn";
  return "border-ok bg-ok/10 text-ok";
}

/**
 * Franja de condiciones actuales arriba del mapa: última observación del rover
 * (temperatura, presión, opacidad de polvo) con su sol, y alertas de DONKI.
 * Si el dato falta, lo dice: nunca muestra valores de ejemplo.
 */
export function CurrentConditions({ siteId }: Props) {
  // Resultado por sitio: al cambiar de sitio, el anterior deja de valer solo.
  const [result, setResult] = useState<{
    siteId: string;
    data: CurrentConditionsData | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchCurrentConditions(siteId).then((data) => {
      if (alive) setResult({ siteId, data });
    });
    return () => {
      alive = false;
    };
  }, [siteId]);

  const t = useT();
  const tr = useTr();
  const loaded = result?.siteId === siteId ? result : null;
  const data = loaded?.data ?? null;

  return (
    <section
      aria-label={t("Condiciones actuales", "Current conditions")}
      className="border-b border-line bg-panel/70 px-3 py-1.5"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-[10px] font-semibold tracking-[0.18em] text-muted uppercase">
          {t("Condiciones actuales", "Current conditions")}
        </h2>

        {loaded === null ? (
          <span className="text-[11px] text-muted">{t("Cargando…", "Loading…")}</span>
        ) : data === null ? (
          <span className="text-[11px] text-warn">
            {t("No se pudieron leer las condiciones actuales.", "Could not read the current conditions.")}
          </span>
        ) : (
          <>
            {data.observations.map((obs) => (
              <div key={obs.id} className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted">{tr(obs.label)}</span>
                <Measure data={obs.value} align="left" />
                <span className="text-[10px] text-muted">
                  {obs.when
                    ? `${obs.when.utc.slice(0, 10)} · sol ${obs.when.sol} · ${obs.when.ltst}`
                    : t("sin medición", "no measurement")}
                </span>
              </div>
            ))}

            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">{t("Clima espacial (DONKI)", "Space weather (DONKI)")}</span>
              {data.alerts_status !== "ok" ? (
                <span className="text-[11px] text-warn">
                  {data.alerts_status === "missing"
                    ? t("falta el dato: todavía no se bajan las alertas", "missing data: alerts are not downloaded yet")
                    : t("no se pudieron leer las alertas", "could not read the alerts")}
                </span>
              ) : data.alerts.length === 0 ? (
                <span className="text-[11px] text-fg">{t("sin alertas vigentes", "no active alerts")}</span>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.alerts.map((alert) => (
                    <li key={`${alert.when}-${alert.summary}`} className="flex items-start gap-1.5">
                      <span
                        className={`inline-flex rounded border px-1.5 py-px text-[9px] font-semibold uppercase ${alertTone(alert.severity)}`}
                      >
                        {t(alert.severity, SEVERITY_EN[alert.severity] ?? alert.severity)}
                      </span>
                      <span className="text-[11px] leading-snug text-fg">
                        {tr(alert.summary)}
                        <span className="ml-1 text-[10px] text-muted">
                          {alert.when.slice(0, 10)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      {data?.note ? <p className="mt-0.5 text-[10px] text-muted">{tr(data.note)}</p> : null}
    </section>
  );
}
