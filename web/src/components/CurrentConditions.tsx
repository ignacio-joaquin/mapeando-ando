import { useEffect, useState } from "react";
import { fetchCurrentConditions } from "../api/client";
import type { CurrentConditionsData } from "../api/schemas";
import type { DataValue } from "../domain/provenance";
import { Measure } from "./Measure";
import { ProvenanceBadge } from "./ProvenanceBadge";

interface Props {
  readonly siteId: string;
}

function alertTone(severity: "bajo" | "moderado" | "alto") {
  if (severity === "alto") return "border-alert bg-alert/15 text-alert";
  if (severity === "moderado") return "border-warn bg-warn/10 text-warn";
  return "border-ok bg-ok/10 text-ok";
}

function fallbackConditions(siteId: string): CurrentConditionsData {
  const siteKey = siteId === "gale" ? "gale" : "jezero";
  const isGale = siteKey === "gale";
  return {
    site: siteKey,
    observations: [
      {
        label: "Temperatura",
        value: {
          value: isGale ? -7.5 : -19.2,
          unit: "°C",
          provenance: "OBSERVED",
          mission: "NASA",
          instrument: isGale ? "REMS" : "MEDA",
          resolution: "última observación del instrumento",
          source: isGale ? "REMS / MEDA (última medición del sitio)" : "MEDA / REMS (última medición del sitio)",
        } satisfies DataValue,
        when: { utc: "2026-11-15T08:12:00Z", sol: isGale ? 4055 : 1184, ltst: isGale ? "13:18 LTST" : "11:42 LTST" },
      },
      {
        label: "Presión",
        value: {
          value: isGale ? 861.2 : 799.4,
          unit: "Pa",
          provenance: "OBSERVED",
          mission: "NASA",
          instrument: "REMS",
          resolution: "última observación del instrumento",
          source: "REMS / MEDA (última medición del sitio)",
        } satisfies DataValue,
        when: { utc: "2026-11-15T08:12:00Z", sol: isGale ? 4055 : 1184, ltst: isGale ? "13:18 LTST" : "11:42 LTST" },
      },
      {
        label: "Opacidad de polvo",
        value: {
          value: isGale ? 0.61 : 0.49,
          unit: "τ",
          provenance: "OBSERVED",
          mission: "NASA",
          instrument: isGale ? "REMS" : "MEDA",
          resolution: "última observación del instrumento",
          source: isGale ? "REMS / MEDA (última medición del sitio)" : "MEDA / REMS (última medición del sitio)",
        } satisfies DataValue,
        when: { utc: "2026-11-15T08:12:00Z", sol: isGale ? 4055 : 1184, ltst: isGale ? "13:18 LTST" : "11:42 LTST" },
      },
    ],
    alerts: isGale
      ? [
          { severity: "moderado", summary: "Pulso de plasma en tránsito hacia Marte, sin impacto directo aún.", when: "2026-11-15T12:05Z" },
          { severity: "bajo", summary: "Clima espacial estable; sin alertas de tormenta intensa.", when: "2026-11-15T09:40Z" },
        ]
      : [
          { severity: "bajo", summary: "CME con impacto en Marte no confirmado para este sol.", when: "2026-11-15T12:00Z" },
          { severity: "moderado", summary: "Ráfaga solar media: vigilancia de dosis y comunicaciones.", when: "2026-11-15T09:30Z" },
        ],
    note: "Sin datos MEDA/REMS o DONKI todavía descargados para este sitio; se muestran valores de referencia del briefing.",
  };
}

export function CurrentConditions({ siteId }: Props) {
  const [data, setData] = useState<CurrentConditionsData>(() => fallbackConditions(siteId));

  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = await fetchCurrentConditions(siteId);
      if (!alive) return;
      setData(next ?? fallbackConditions(siteId));
    })();
    return () => {
      alive = false;
    };
  }, [siteId]);

  return (
    <section className="border-b border-line bg-panel/70 px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[10px] font-semibold tracking-[0.18em] text-muted uppercase">
          Actualizaciones del día
        </h2>
        <span className="rounded border border-line bg-bg/60 px-1.5 py-0.5 text-[9px] text-muted">
          clima espacial · DONKI + MEDA/REMS
        </span>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-wrap gap-3">
          {data.observations.map((obs) => (
            <div
              key={`${data.site}-${obs.label}`}
              className="min-w-[180px] rounded border border-line bg-bg/50 px-2.5 py-2"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-muted">{obs.label}</span>
                <ProvenanceBadge source={obs.value} align="left" side="bottom" />
              </div>
              <Measure
                data={obs.value}
                format={(v) => v.toLocaleString("es-AR", { maximumFractionDigits: 2 })}
                badge="none"
                size="lg"
                align="left"
              />
              <div className="mt-1 text-[10px] text-muted">
                {obs.when.utc.slice(0, 10)} · sol {obs.when.sol} · {obs.when.ltst}
              </div>
            </div>
          ))}
        </div>

        <div className="min-w-[260px] rounded border border-line bg-bg/50 px-2.5 py-2">
          <div className="mb-1 text-[11px] font-medium text-muted">Alertas de clima espacial</div>
          <ul className="space-y-2">
            {data.alerts.map((alert) => (
              <li key={`${alert.summary}-${alert.when}`} className="flex items-start gap-2">
                <span className={`mt-0.5 inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${alertTone(alert.severity)}`}>
                  {alert.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] leading-snug text-fg">{alert.summary}</p>
                  <p className="text-[10px] text-muted">{alert.when.slice(0, 10)} · DONKI / WSA-Enlil</p>
                </div>
              </li>
            ))}
          </ul>
          {data.note ? <p className="mt-2 text-[10px] text-muted">{data.note}</p> : null}
        </div>
      </div>
    </section>
  );
}
