import { localeNow, useT, useTr } from "../../i18n/lang";
import type { ReactNode } from "react";
import type { RouteCost, SafetyLimit, Verdict } from "../../api/schemas";
import { Measure } from "../Measure";
import { useContact } from "../../state/contact";
import { FACTOR_LABEL } from "./VerdictCard";

/**
 * Por qué el veredicto dice lo que dice: cada límite duro con su margen, los
 * escenarios de estrés y cuánto aporta cada factor al costo de la ruta.
 * Contrato en docs/context.md §4; modelo en docs/seguridad.md.
 *
 * Nada se comunica solo por color: cada estado va escrito.
 */
const LIMIT_STATUS: Record<SafetyLimit["status"], { word: string; en: string; tone: string }> = {
  ok: { word: "OK", en: "OK", tone: "text-ok" },
  broken: { word: "ROTO", en: "BROKEN", tone: "text-alert" },
  not_evaluated: { word: "SIN EVALUAR", en: "NOT EVALUATED", tone: "text-warn" },
  undefined: { word: "SIN DEFINIR", en: "UNDEFINED", tone: "text-muted" },
};

const DECIMALS: Partial<Record<SafetyLimit["id"], number>> = { o2: 3, dose: 3, calories: 0, battery: 0 };

const fmt = (id: SafetyLimit["id"]) => (v: number) =>
  v.toLocaleString(localeNow(), { maximumFractionDigits: DECIMALS[id] ?? 1 });

interface Props {
  readonly verdict: Verdict;
  readonly cost: RouteCost | undefined;
}

export function SafetyBreakdown({ verdict, cost }: Props) {
  const { limits, robustness } = verdict;
  const t = useT();
  const tr = useTr();
  if (!limits && !robustness && !cost) return null;
  return (
    <div data-edu="breakdown" className="flex flex-col gap-2 text-xs">
      {limits ? (
        <Section title={t("Límites duros", "Hard limits")} open={verdict.status !== "GO"}>
          <p className="mb-1.5 text-muted">
            {t(
              "Margen = 1 − usado / límite, en el peor punto. Cada límite dice de dónde sale en su badge.",
              "Margin = 1 − used / limit, at the worst point. Each limit says where it comes from in its badge.",
            )}
          </p>
          <ul className="flex flex-col gap-2">
            {limits.map((l) => (
              <LimitRow key={l.id} limit={l} limiting={l.id === verdict.limiting_factor} />
            ))}
          </ul>
        </Section>
      ) : null}

      {robustness ? (
        <Section
          title={t(
            `Escenarios de estrés · ${robustness.passed} de ${robustness.evaluated}`,
            `Stress scenarios · ${robustness.passed} of ${robustness.evaluated}`,
          )}
        >
          <p className="mb-1.5 text-muted">
            {t(
              "La misma ruta, recalculada en peores condiciones. Cuenta escenarios, no es una probabilidad.",
              "The same route, recalculated under worse conditions. It counts scenarios; it is not a probability.",
            )}
          </p>
          <ul className="flex flex-col gap-1">
            {robustness.scenarios.map((s) => (
              <li key={s.id} className="flex flex-col">
                <span className="flex justify-between gap-2">
                  <span>{tr(s.label)}</span>
                  <span
                    className={`font-semibold ${s.status === "pass" ? "text-ok" : s.status === "fail" ? "text-alert" : "text-warn"}`}
                  >
                    {s.status === "pass"
                      ? t("✓ aguanta", "✓ holds")
                      : s.status === "fail"
                        ? t("✕ falla", "✕ fails")
                        : t("sin evaluar", "not evaluated")}
                  </span>
                </span>
                {s.status === "fail" && s.limiting_factor ? (
                  <span className="text-muted">
                    {t("Se rompe", "Breaks")}: {tr(FACTOR_LABEL[s.limiting_factor]).toLowerCase()}
                  </span>
                ) : null}
                {s.note ? <span className="text-muted">{tr(s.note)}</span> : null}
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
  const t = useT();
  const tr = useTr();
  const pct = l.margin === null ? null : Math.round(l.margin * 100);
  return (
    <li className={`flex flex-col gap-0.5 ${limiting ? "rounded border border-line p-1.5" : ""}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          {tr(l.label)}
          {limiting ? <span className="ml-1 text-rust">{t("← limita", "← limiting")}</span> : null}
        </span>
        <span className={`font-mono font-semibold ${st.tone}`}>
          {t(st.word, st.en)}
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
          <span className="text-muted">{t("usado", "used")}</span>
          <Measure data={l.used} format={fmt(l.id)} align="left" />
        </span>
        <span className="flex items-center gap-1">
          <span className="text-muted">{t("límite", "limit")}</span>
          <Measure data={l.limit} format={fmt(l.id)} />
        </span>
      </span>
      {l.note ? <span className="text-muted">{tr(l.note)}</span> : null}
      {l.id === "contact" && l.status !== "not_evaluated" ? <ShowContactButton /> : null}
    </li>
  );
}

function CostSection({ cost }: { readonly cost: RouteCost }) {
  const max = Math.max(cost.base_minutes ?? 0, ...cost.factors.map((f) => f.minutes ?? 0), 1);
  const t = useT();
  const tr = useTr();
  return (
    <Section title={t("Costo de la ruta, por factor", "Route cost, by factor")}>
      <p className="mb-1.5 font-mono text-muted">{tr(cost.formula)}</p>
      <p className="mb-1.5 text-muted">
        {t(
          "Entre las rutas que respetan los límites, el planificador elige la de menor costo. Cada fila es cuántos minutos-equivalentes suma ese factor; los pesos (w) están a la vista.",
          "Among the routes that respect the limits, the planner picks the one with the lowest cost. Each row is how many equivalent minutes that factor adds; the weights (w) are shown.",
        )}
      </p>
      <ul className="flex flex-col gap-1.5">
        <CostRow label={t("Tiempo de caminata", "Walking time")} weight={null} minutes={cost.base_minutes} max={max} note={null} />
        {cost.factors.map((f) => (
          <CostRow
            key={f.id}
            label={tr(f.label)}
            weight={f.weight}
            minutes={f.active ? f.minutes : null}
            max={max}
            note={f.active ? null : `${t("Inactivo", "Inactive")}: ${f.note ? tr(f.note) : t("sin datos", "no data")}`}
          />
        ))}
      </ul>
      {cost.total_minutes !== null ? (
        <p className="mt-1.5 flex justify-between border-t border-line pt-1 font-semibold">
          <span>Total</span>
          <span className="font-mono">{cost.total_minutes.toLocaleString(localeNow())} min-eq</span>
        </p>
      ) : (
        <p className="mt-1.5 text-warn">
          {t("Sin costo: ningún tramo se resolvió sobre el terreno.", "No cost: no segment was resolved over the terrain.")}
        </p>
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
  useT();
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex justify-between gap-2">
        <span>
          {label}
          {weight !== null ? <span className="ml-1 font-mono text-muted">w={weight}</span> : null}
        </span>
        <span className="font-mono">{minutes === null ? "—" : `${minutes.toLocaleString(localeNow())} min-eq`}</span>
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

/** Prende la capa de contacto: es lo que muestra por qué la racha es la que es. */
function ShowContactButton() {
  const visible = useContact((s) => s.visible);
  const t = useT();
  if (visible) {
    return (
      <span className="text-muted">
        {t("En el mapa: rayado = sin contacto con el hábitat.", "On the map: hatched = no contact with the habitat.")}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => useContact.getState().setVisible(true)}
      className="self-start rounded border border-line px-2 py-1 text-fg hover:border-rust"
    >
      {t("Ver en el mapa dónde hay contacto", "See on the map where there is contact")}
    </button>
  );
}
