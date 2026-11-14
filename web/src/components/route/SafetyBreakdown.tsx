import type { ReactNode } from "react";
import type { RouteCost, SafetyLimit, Verdict } from "../../api/schemas";
import { Measure } from "../Measure";
import { FACTOR_LABEL } from "./VerdictCard";

/**
 * Por qué el veredicto dice lo que dice: cada límite duro con su margen, los
 * escenarios de estrés y cuánto aporta cada factor al costo de la ruta.
 * Contrato en docs/context.md §4; modelo en docs/seguridad.md.
 *
 * Nada se comunica solo por color: cada estado va escrito.
 */
const LIMIT_STATUS: Record<SafetyLimit["status"], { word: string; tone: string }> = {
  ok: { word: "OK", tone: "text-ok" },
  broken: { word: "ROTO", tone: "text-alert" },
  not_evaluated: { word: "SIN EVALUAR", tone: "text-warn" },
  undefined: { word: "SIN DEFINIR", tone: "text-muted" },
};

const DECIMALS: Partial<Record<SafetyLimit["id"], number>> = { o2: 3, dose: 3, calories: 0, battery: 0 };

const fmt = (id: SafetyLimit["id"]) => (v: number) =>
  v.toLocaleString("es-AR", { maximumFractionDigits: DECIMALS[id] ?? 1 });

interface Props {
  readonly verdict: Verdict;
  readonly cost: RouteCost | undefined;
}

export function SafetyBreakdown({ verdict, cost }: Props) {
  const { limits, robustness } = verdict;
  if (!limits && !robustness && !cost) return null;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {limits ? (
        <Section title="Límites duros" open={verdict.status !== "GO"}>
          <p className="mb-1.5 text-muted">
            Margen = 1 − usado / límite, en el peor punto. Cada límite dice de dónde sale en su badge.
          </p>
          <ul className="flex flex-col gap-2">
            {limits.map((l) => (
              <LimitRow key={l.id} limit={l} limiting={l.id === verdict.limiting_factor} />
            ))}
          </ul>
        </Section>
      ) : null}

      {robustness ? (
        <Section title={`Escenarios de estrés · ${robustness.passed} de ${robustness.evaluated}`}>
          <p className="mb-1.5 text-muted">La misma ruta, recalculada en peores condiciones. Cuenta escenarios, no es una probabilidad.</p>
          <ul className="flex flex-col gap-1">
            {robustness.scenarios.map((s) => (
              <li key={s.id} className="flex flex-col">
                <span className="flex justify-between gap-2">
                  <span>{s.label}</span>
                  <span
                    className={`font-semibold ${s.status === "pass" ? "text-ok" : s.status === "fail" ? "text-alert" : "text-warn"}`}
                  >
                    {s.status === "pass" ? "✓ aguanta" : s.status === "fail" ? "✕ falla" : "sin evaluar"}
                  </span>
                </span>
                {s.status === "fail" && s.limiting_factor ? (
                  <span className="text-muted">Se rompe: {FACTOR_LABEL[s.limiting_factor].toLowerCase()}</span>
                ) : null}
                {s.note ? <span className="text-muted">{s.note}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {cost ? <CostSection cost={cost} /> : null}
    </div>
  );
}

function LimitRow({ limit: l, limiting }: { readonly limit: SafetyLimit; readonly limiting: boolean }) {
  const st = LIMIT_STATUS[l.status];
  const pct = l.margin === null ? null : Math.round(l.margin * 100);
  return (
    <li className={`flex flex-col gap-0.5 ${limiting ? "rounded border border-line p-1.5" : ""}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          {l.label}
          {limiting ? <span className="ml-1 text-rust">← limita</span> : null}
        </span>
        <span className={`font-mono font-semibold ${st.tone}`}>
          {st.word}
          {pct !== null ? ` · ${pct} %` : ""}
        </span>
      </span>
      {pct !== null ? (
        <span aria-hidden className="h-1 w-full overflow-hidden rounded bg-line">
          <span
            className={`block h-full ${l.status === "broken" ? "bg-alert" : pct < 20 ? "bg-warn" : "bg-ok"}`}
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </span>
      ) : null}
      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <span className="flex items-center gap-1">
          <span className="text-muted">usado</span>
          <Measure data={l.used} format={fmt(l.id)} align="left" />
        </span>
        <span className="flex items-center gap-1">
          <span className="text-muted">límite</span>
          <Measure data={l.limit} format={fmt(l.id)} />
        </span>
      </span>
      {l.note ? <span className="text-muted">{l.note}</span> : null}
    </li>
  );
}

function CostSection({ cost }: { readonly cost: RouteCost }) {
  const max = Math.max(cost.base_minutes ?? 0, ...cost.factors.map((f) => f.minutes ?? 0), 1);
  return (
    <Section title="Costo de la ruta, por factor">
      <p className="mb-1.5 font-mono text-muted">{cost.formula}</p>
      <p className="mb-1.5 text-muted">
        Entre las rutas que respetan los límites, el planificador elige la de menor costo. Cada fila es cuántos
        minutos-equivalentes suma ese factor; los pesos (w) están a la vista.
      </p>
      <ul className="flex flex-col gap-1.5">
        <CostRow label="Tiempo de caminata" weight={null} minutes={cost.base_minutes} max={max} note={null} />
        {cost.factors.map((f) => (
          <CostRow
            key={f.id}
            label={f.label}
            weight={f.weight}
            minutes={f.active ? f.minutes : null}
            max={max}
            note={f.active ? null : `Inactivo: ${f.note ?? "sin datos"}`}
          />
        ))}
      </ul>
      {cost.total_minutes !== null ? (
        <p className="mt-1.5 flex justify-between border-t border-line pt-1 font-semibold">
          <span>Total</span>
          <span className="font-mono">{cost.total_minutes.toLocaleString("es-AR")} min-eq</span>
        </p>
      ) : (
        <p className="mt-1.5 text-warn">Sin costo: ningún tramo se resolvió sobre el terreno.</p>
      )}
    </Section>
  );
}

function CostRow(props: {
  readonly label: string;
  readonly weight: number | null;
  readonly minutes: number | null;
  readonly max: number;
  readonly note: string | null;
}) {
  const { label, weight, minutes, max, note } = props;
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex justify-between gap-2">
        <span>
          {label}
          {weight !== null ? <span className="ml-1 font-mono text-muted">w={weight}</span> : null}
        </span>
        <span className="font-mono">{minutes === null ? "—" : `${minutes.toLocaleString("es-AR")} min-eq`}</span>
      </span>
      {minutes !== null ? (
        <span aria-hidden className="h-1 w-full overflow-hidden rounded bg-line">
          <span className="block h-full bg-rust" style={{ width: `${(100 * minutes) / max}%` }} />
        </span>
      ) : null}
      {note ? <span className="text-muted">{note}</span> : null}
    </li>
  );
}

function Section(props: { readonly title: string; readonly open?: boolean; readonly children: ReactNode }) {
  return (
    <details open={props.open} className="rounded border border-line p-2">
      <summary className="cursor-pointer font-semibold text-fg">{props.title}</summary>
      <div className="mt-2">{props.children}</div>
    </details>
  );
}
