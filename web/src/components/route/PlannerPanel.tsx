import { useEffect, useState } from "react";
import { EDU_TARGET } from "../../edu/lessons";
import { useLessonShows } from "../../edu/useLessonShows";
import { useFreshRoute, usePlan } from "../../state/plan";
import { RoutePlanner } from "./RoutePlanner";

/** Piezas de una lección que viven dentro del planificador. */
const PLANNER_TARGETS = [
  EDU_TARGET.VERDICT,
  EDU_TARGET.BREAKDOWN,
  EDU_TARGET.DEPART,
  EDU_TARGET.POINTS,
  EDU_TARGET.SEARCH,
  EDU_TARGET.SHARE,
  EDU_TARGET.CARGO,
] as const;

/**
 * El planificador. En md+ es la columna de la izquierda; en pantalla chica una
 * hoja abajo del mapa que se pliega a una línea de resumen (el veredicto o el
 * próximo paso), para no tapar el mapa.
 */
export function PlannerPanel() {
  const [open, setOpen] = useState(false);
  // En pantalla chica, una lección que señala algo del planificador sube la
  // hoja; el alumno la puede volver a bajar para ver el mapa.
  const lessonShows = useLessonShows(PLANNER_TARGETS);
  useEffect(() => {
    if (lessonShows) setOpen(true);
  }, [lessonShows]);
  return (
    <aside
      aria-label="Planificador de travesía"
      className={`absolute inset-x-0 bottom-0 z-30 flex max-h-[75%] flex-col rounded-t-2xl border-t border-line bg-panel shadow-[0_-8px_24px_rgb(0_0_0/0.45)] md:static md:z-auto md:order-1 md:max-h-none md:w-[380px] md:shrink-0 md:rounded-none md:border-t-0 md:border-r md:shadow-none ${open ? "h-[75%] md:h-auto" : ""}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="relative flex min-h-12 w-full shrink-0 items-center gap-3 px-3 pt-1 text-left md:hidden"
      >
        <span aria-hidden className="absolute top-1.5 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-line" />
        <PlannerSummary />
        <span aria-hidden className={`ml-auto text-muted transition-transform ${open ? "rotate-180" : ""}`}>
          ▴
        </span>
      </button>
      <div className={`min-h-0 flex-1 overflow-y-auto px-3 pb-4 md:block md:pt-3 ${open ? "" : "hidden"}`}>
        <RoutePlanner />
      </div>
    </aside>
  );
}

const VERDICT_LOOK = {
  GO: { word: "✓ GO", text: "text-ok" },
  CAUTION: { word: "⚠ CAUTION", text: "text-warn" },
  NO_GO: { word: "✕ NO-GO", text: "text-alert" },
} as const;

/** Una línea para la hoja plegada: qué falta hacer, o cómo dio la travesía. */
function PlannerSummary() {
  const count = usePlan((s) => s.waypoints.length);
  const status = usePlan((s) => s.status);
  const plan = useFreshRoute();
  const verdict = plan?.route.verdict;
  if (count === 0) return <span className="text-sm">Tocá el mapa para marcar el hábitat</span>;
  if (count === 1) return <span className="text-sm">Elegí el destino</span>;
  if (status.kind === "error") return <span className="text-sm text-alert">✕ No se pudo calcular la ruta</span>;
  if (!verdict) return <span className="text-sm text-muted">Calculando la travesía…</span>;
  const look = VERDICT_LOOK[verdict.status];
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <strong className={`shrink-0 text-base font-black ${look.text}`}>{look.word}</strong>
      <span className="truncate text-xs text-muted">
        {plan?.example ? "ejemplo · " : ""}
        {count} puntos
      </span>
    </span>
  );
}

/** Qué hace un clic en el mapa. Va sobre el mapa porque es del mapa. */
export function ClickModeToggle() {
  const clickMode = usePlan((s) => s.clickMode);
  const { setClickMode } = usePlan.getState();
  const modes = [
    ["add", "＋ Puntos", "Un clic suma un punto a la travesía"],
    ["inspect", "⌖ Inspeccionar", "Un clic fija un punto y muestra qué hay ahí"],
  ] as const;
  return (
    <div
      role="group"
      aria-label="Qué hace un clic en el mapa"
      data-edu="tools"
      className="pointer-events-auto flex rounded-lg border border-line bg-panel/95 p-0.5 shadow-lg backdrop-blur"
    >
      {modes.map(([mode, label, title]) => (
        <button
          key={mode}
          type="button"
          aria-pressed={clickMode === mode}
          onClick={() => setClickMode(mode)}
          title={title}
          className="min-h-9 rounded-md px-2.5 text-sm text-muted hover:text-fg aria-pressed:bg-rust aria-pressed:font-semibold aria-pressed:text-bg"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
