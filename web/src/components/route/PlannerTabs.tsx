import type { RouteResponse } from "../../api/schemas";
import type { PlannerTab } from "../../state/ui";
import { FACTOR_LABEL } from "./VerdictCard";
import { useRouteParams } from "../../state/plan";
import { countOverrides, useSettings } from "../../state/settings";
import { useT, useTr } from "../../i18n/lang";

const TABS: readonly { readonly id: PlannerTab; readonly label: string; readonly icon: string; readonly needsRoute: boolean }[] = [
  { id: "navigate", label: "Navegar", icon: "🧭", needsRoute: true },
  { id: "route", label: "Recorrido", icon: "⌖", needsRoute: false },
  { id: "safety", label: "Seguridad", icon: "⛨", needsRoute: true },
  { id: "settings", label: "Ajustes", icon: "⚙", needsRoute: false },
];

/**
 * Pestañas del planificador. Navegar y Seguridad necesitan una ruta: sin ella
 * se ven apagadas y dicen por qué. Navegar es la que importa afuera, así que
 * va primera y resaltada.
 */
export function PlannerTabs({
  current,
  hasRoute,
  onPick,
}: {
  readonly current: PlannerTab;
  readonly hasRoute: boolean;
  readonly onPick: (t: PlannerTab) => void;
}) {
  const changed = useSettings((s) => countOverrides(s.overrides));
  const tr = useTr();
  const tt = useT();
  return (
    <div
      role="tablist"
      aria-label={tt("Secciones del planificador", "Planner sections")}
      className="sticky top-0 z-10 -mx-3 grid grid-cols-4 gap-1 border-b border-line bg-panel px-3 pt-1 pb-2"
    >
      {TABS.map((t) => {
        const disabled = t.needsRoute && !hasRoute;
        const active = current === t.id;
        const nav = t.id === "navigate";
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onPick(t.id)}
            title={disabled ? tt("Primero armá una ruta con hábitat y destino", "First build a route with a habitat and a destination") : undefined}
            className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              active
                ? nav
                  ? "bg-rust text-bg shadow-lg"
                  : "bg-line text-fg"
                : nav && hasRoute
                  ? "border border-rust/70 text-fg hover:bg-rust/15"
                  : "text-muted hover:bg-line/60 hover:text-fg"
            }`}
          >
            <span aria-hidden className="text-base leading-none">
              {t.icon}
            </span>
            {tr(t.label)}
            {t.id === "settings" && changed > 0 ? (
              <span className="absolute top-0.5 right-1 rounded-full bg-rust px-1 text-[9px] leading-tight font-bold text-bg">
                {changed}
              </span>
            ) : null}
            {nav && hasRoute && !active ? (
              <span aria-hidden className="absolute top-1 right-1.5 size-2 animate-pulse rounded-full bg-rust" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

const LOOK = {
  GO: { word: "GO", icon: "✓", box: "border-ok bg-ok/10", text: "text-ok" },
  CAUTION: { word: "CAUTION", icon: "⚠", box: "border-warn bg-warn/10", text: "text-warn" },
  NO_GO: { word: "NO-GO", icon: "✕", box: "border-alert bg-alert/15", text: "text-alert" },
} as const;

/**
 * El veredicto en una franja, siempre arriba de las pestañas: la decisión no
 * se esconde. El detalle, con su procedencia, está en Seguridad.
 */
export function VerdictStrip({
  route,
  example,
  onOpen,
}: {
  readonly route: RouteResponse;
  readonly example: boolean;
  readonly onOpen: () => void;
}) {
  const v = route.verdict;
  const look = LOOK[v.status];
  const custom = useRouteParams() !== undefined;
  const t = useT();
  const tr = useTr();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-live="polite"
      className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2 text-left hover:brightness-110 ${look.box}`}
    >
      <span className={`text-2xl leading-none font-black ${look.text}`}>
        <span aria-hidden>{look.icon} </span>
        {look.word}
      </span>
      <span className="min-w-0 flex-1 text-[11px] leading-tight">
        {v.limiting_factor ? (
          <span className="block truncate text-fg">
            {t("Limita", "Limited by")}: {tr(FACTOR_LABEL[v.limiting_factor])}
          </span>
        ) : null}
        <span className="block truncate text-muted">
          {example ? t("ejemplo · no usar para decidir · ", "sample · do not use to decide · ") : ""}
          {custom ? t("⚙ con tus ajustes · ", "⚙ with your settings · ") : ""}
          {t("ver por qué ›", "see why ›")}
        </span>
      </span>
    </button>
  );
}
