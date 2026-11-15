import { useEffect, type ReactNode } from "react";
import { FACTOR_LABEL } from "../components/route/VerdictCard";
import { useEdu, type Attempt, type Prediction } from "../state/edu";
import { useFreshRoute, usePlan } from "../state/plan";
import { useStore } from "../state/store";
import { lessonById, LESSONS, PREDICTABLE, type Lesson, type LessonContext, type LessonStep } from "./lessons";

/**
 * Modo entrenamiento: va arriba del planificador, que el alumno sigue usando
 * igual que siempre. El panel solo mira lo que contesta /api/route.
 *
 * Con el planificador de ejemplo (sin backend) no corrige nada: corregir con
 * números de ejemplo sería enseñar algo que el dato real no dice.
 */
export function EduPanel() {
  const open = useEdu((s) => s.open);
  const lessonId = useEdu((s) => s.lessonId);
  const lesson = lessonById(lessonId);
  if (!open) return null;
  return (
    <section
      aria-label="Entrenamiento de EVA"
      className="mb-3 flex flex-col gap-2 rounded border-2 border-rust bg-bg p-3 text-xs"
    >
      {lesson ? <LessonView lesson={lesson} /> : <LessonList />}
    </section>
  );
}

/** Botón del encabezado que abre y cierra el modo. */
export function EduToggle() {
  const open = useEdu((s) => s.open);
  const { setOpen, exit } = useEdu.getState();
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={() => {
        if (open) exit();
        setOpen(!open);
      }}
      className={
        open
          ? "rounded border border-rust bg-rust/15 px-2 py-0.5 text-xs text-fg"
          : "rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-fg"
      }
    >
      🎓 Entrenamiento
    </button>
  );
}

function LessonList() {
  const done = useEdu((s) => s.done);
  const { start, setOpen } = useEdu.getState();
  const count = LESSONS.filter((l) => done[l.id]).length;
  return (
    <>
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Entrenamiento de EVA</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-muted hover:text-fg">
          cerrar
        </button>
      </header>
      <p className="leading-relaxed text-muted">
        Cada lección es una dificultad real de planificar una salida en Marte. Usás el planificador de
        siempre y te corrige el planificador real, con datos de la NASA. {count} de {LESSONS.length} hechas.
      </p>
      <ol className="flex flex-col gap-1">
        {LESSONS.map((l, i) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => start(l.id)}
              className="flex w-full items-start gap-2 rounded border border-line p-2 text-left hover:border-rust"
            >
              <span className="w-4 shrink-0 font-mono text-muted">{i}</span>
              <span className="flex-1">
                <span className="block font-semibold text-fg">{l.title}</span>
                <span className="block text-muted">{l.tagline}</span>
              </span>
              {done[l.id] ? (
                <span className="shrink-0 font-semibold text-ok">
                  ✓<span className="sr-only"> hecha</span>
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

function useLessonContext(): { ctx: LessonContext; example: boolean; loading: boolean } {
  const fresh = useFreshRoute();
  const waypoints = usePlan((s) => s.waypoints);
  const loading = usePlan((s) => s.status.kind === "loading");
  const attempts = useEdu((s) => s.attempts);
  const places = useStore((s) => s.places);
  const example = fresh?.example ?? false;
  return {
    ctx: { route: fresh && !fresh.example ? fresh.route : null, waypoints, attempts, places },
    example,
    loading,
  };
}

/** Anota cada ruta real que llega mientras la lección está abierta. */
function useRecordAttempts() {
  const fresh = useFreshRoute();
  const siteId = useStore((s) => s.activeSiteId);
  useEffect(() => {
    if (!fresh || fresh.example) return;
    const { waypoints, departAt } = usePlan.getState();
    const v = fresh.route.verdict;
    const attempt: Attempt = {
      geometryKey: JSON.stringify([siteId, waypoints.map((w) => [w.lat, w.lon, w.dwellMin])]),
      departMs: departAt.getTime(),
      status: v.status,
      limiting: v.limiting_factor,
      passed: v.robustness?.passed ?? null,
      evaluated: v.robustness?.evaluated ?? null,
    };
    useEdu.getState().record(attempt);
  }, [fresh, siteId]);
}

/** Resalta y tapa piezas de la interfaz con atributos en <body> (ver index.css). */
function useSpotlight(step: LessonStep, revealed: boolean) {
  const focus = step.focus?.join(" ") ?? "";
  const hide = revealed ? "" : (step.hide?.join(" ") ?? "");
  useEffect(() => {
    const b = document.body;
    b.dataset.eduFocus = focus;
    b.dataset.eduHide = hide;
    return () => {
      delete b.dataset.eduFocus;
      delete b.dataset.eduHide;
    };
  }, [focus, hide]);
}

/** Prende las capas que pide el paso, si el server las tiene. */
function useStepLayers(step: LessonStep) {
  const layersKey = step.layers?.join(",") ?? "";
  const available = useStore((s) => layersKey.split(",").map((id) => s.layers[id]?.available ?? false).join(","));
  useEffect(() => {
    if (!layersKey) return;
    const { layers, toggleLayer } = useStore.getState();
    for (const id of layersKey.split(",")) {
      const l = layers[id];
      if (l?.available && !l.visible) toggleLayer(id);
    }
  }, [layersKey, available]);
}

function LessonView({ lesson }: { readonly lesson: Lesson }) {
  const stepIndex = useEdu((s) => s.step);
  const prediction = useEdu((s) => s.prediction);
  const done = useEdu((s) => s.done);
  const skipped = useEdu((s) => s.skipped);
  const { goTo, skip, predict, complete, exit } = useEdu.getState();
  const { ctx, example, loading } = useLessonContext();
  const step = lesson.steps[Math.min(stepIndex, lesson.steps.length - 1)]!;
  const last = stepIndex >= lesson.steps.length - 1;

  useRecordAttempts();
  useSpotlight(step, step.kind === "predict" && prediction !== null);
  useStepLayers(step);

  const check = step.kind === "task" ? step.check(ctx) : null;
  const canAdvance =
    step.kind === "info" ||
    (step.kind === "task" && check?.done === true) ||
    (step.kind === "predict" && prediction !== null && ctx.route !== null);

  return (
    <>
      <header className="flex items-baseline justify-between gap-2">
        <button type="button" onClick={exit} className="text-muted hover:text-fg">
          ← lecciones
        </button>
        <span className="text-muted">
          Paso {stepIndex + 1} de {lesson.steps.length}
          {done[lesson.id] ? <span className="text-ok"> · ✓ hecha</span> : null}
        </span>
      </header>
      <h2 className="text-sm font-semibold">{lesson.title}</h2>
      <h3 className="font-semibold text-rust">{step.title}</h3>

      {step.kind === "task" ? (
        <p className="rounded border border-rust/60 bg-rust/10 p-2 font-semibold text-fg">
          <span aria-hidden>▸ </span>
          {step.goal}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 text-fg">{step.body(ctx)}</div>

      {example ? (
        <p role="status" className="rounded border-2 border-warn bg-warn/10 p-2 text-fg">
          <strong className="text-warn">⚠ </strong>
          Esta ruta la calculó el planificador de ejemplo, no el real. La lección no te puede corregir con
          esos números.
        </p>
      ) : null}

      {step.kind === "task" && check && !example ? (
        loading ? (
          <p role="status" className="text-muted">Calculando la ruta…</p>
        ) : check.blocked ? (
          <p role="status" className="rounded border-2 border-warn bg-warn/10 p-2 text-fg">
            <strong className="text-warn">⚠ Con los datos de hoy no se puede: </strong>
            {check.hint} Podés saltear el paso, pero la lección no va a quedar como hecha.
          </p>
        ) : (
          <p role="status" className={check.done ? "font-semibold text-ok" : "text-muted"}>
            {check.done ? "✓ Listo." : null}
            {check.hint ? <> {check.hint}</> : null}
          </p>
        )
      ) : null}

      {skipped && last ? (
        <p className="text-muted">Salteaste un paso por falta de datos: esta lección no va a quedar como hecha.</p>
      ) : null}

      {step.kind === "predict" ? (
        <PredictBlock
          question={step.question}
          prediction={prediction}
          onPredict={predict}
          hasRoute={ctx.route !== null}
          reveal={prediction !== null ? step.reveal(ctx, prediction) : null}
        />
      ) : null}

      <nav className="mt-1 flex flex-wrap justify-between gap-2">
        <button
          type="button"
          disabled={stepIndex === 0}
          onClick={() => goTo(stepIndex - 1)}
          className="rounded border border-line px-3 py-1.5 text-muted hover:text-fg disabled:opacity-40"
        >
          Atrás
        </button>
        {check?.blocked && !canAdvance && !last ? (
          <button
            type="button"
            onClick={() => skip(stepIndex + 1)}
            className="ml-auto rounded border border-warn px-3 py-1.5 text-fg"
          >
            Saltear paso
          </button>
        ) : null}
        <button
          type="button"
          disabled={!canAdvance}
          onClick={() => {
            if (last) {
              complete(lesson.id);
              exit();
            } else {
              goTo(stepIndex + 1);
            }
          }}
          className="rounded border-2 border-rust bg-rust/15 px-3 py-1.5 font-semibold text-fg disabled:border-line disabled:bg-transparent disabled:text-muted"
        >
          {last ? "Terminar lección" : "Siguiente"}
        </button>
      </nav>
    </>
  );
}

interface PredictProps {
  readonly question: string;
  readonly prediction: Prediction | null;
  readonly onPredict: (p: Prediction) => void;
  readonly hasRoute: boolean;
  readonly reveal: ReactNode;
}

function PredictBlock({ question, prediction, onPredict, hasRoute, reveal }: PredictProps) {
  if (prediction !== null) return <div className="flex flex-col gap-2">{reveal}</div>;
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 font-semibold">{question}</legend>
      {!hasRoute ? <p className="text-muted">Primero armá una ruta (el veredicto sigue tapado).</p> : null}
      <div className="grid grid-cols-2 gap-1">
        {PREDICTABLE.map((f) => (
          <button
            key={f}
            type="button"
            disabled={!hasRoute}
            onClick={() => onPredict(f)}
            className="rounded border border-line px-2 py-1.5 text-left hover:border-rust disabled:opacity-40"
          >
            {FACTOR_LABEL[f]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
