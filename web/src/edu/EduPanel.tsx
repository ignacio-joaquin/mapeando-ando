import { useEffect, useRef, type ReactNode } from "react";
import { LAYERS } from "../map/layers";
import { FACTOR_LABEL } from "../components/route/VerdictCard";
import { useEdu, type Attempt, type Prediction } from "../state/edu";
import { useFreshRoute, usePlan } from "../state/plan";
import { useStore } from "../state/store";
import {
  lessonById,
  LESSONS,
  PREDICTABLE,
  setupAt,
  type Lesson,
  type LessonContext,
  type LessonStep,
  type StepSetup,
} from "./lessons";

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
      {lesson ? <LessonView key={lesson.id} lesson={lesson} /> : <LessonList />}
      {/* El resto de la interfaz se esconde durante la lección: el aviso va acá. */}
      <p className="border-t border-line pt-2 text-[10px] text-muted">Prototipo educativo, no software de vuelo.</p>
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

/**
 * Muestra, resalta y tapa piezas de la interfaz con atributos en <body> (ver
 * index.css). Con data-edu-ui, lo que no está en data-edu-show se esconde.
 */
function useStage(step: LessonStep, setup: StepSetup, revealed: boolean) {
  const show = [...setup.ui].join(" ");
  const focus = step.focus?.join(" ") ?? "";
  const hide = revealed ? "" : (step.hide?.join(" ") ?? "");
  useEffect(() => {
    const b = document.body;
    b.dataset.eduUi = "";
    b.dataset.eduShow = show;
    b.dataset.eduFocus = focus;
    b.dataset.eduHide = hide;
    return () => {
      delete b.dataset.eduUi;
      delete b.dataset.eduShow;
      delete b.dataset.eduFocus;
      delete b.dataset.eduHide;
    };
  }, [show, focus, hide]);
}

/** La base de imagen no la maneja la lección: es el piso de todo lo demás. */
const UNMANAGED = new Set(["base-ortho"]);

/**
 * Mientras dura la lección, las capas y los pines los decide el paso. Al
 * entrar se guarda cómo los tenía el usuario y al salir se le devuelven.
 */
function useStepLayers(setup: StepSetup) {
  const saved = useRef<{ visible: Record<string, boolean>; kinds: ReturnType<typeof useStore.getState>["placeKinds"] } | null>(null);
  useEffect(() => {
    const st = useStore.getState();
    saved.current = {
      visible: Object.fromEntries(Object.entries(st.layers).map(([id, l]) => [id, l.visible])),
      kinds: st.placeKinds,
    };
    return () => {
      const s = saved.current;
      if (!s) return;
      const now = useStore.getState();
      for (const [id, l] of Object.entries(now.layers)) {
        if (s.visible[id] !== undefined && l.visible !== s.visible[id]) now.toggleLayer(id);
      }
      now.setPlaceKinds(s.kinds);
    };
  }, []);

  const wanted = setup.layers.join(",");
  // Una capa que llega tarde (disponibilidad) también se prende.
  const available = useStore((s) => LAYERS.map((l) => (s.layers[l.id]?.available ? "1" : "0")).join(""));
  useEffect(() => {
    const want = new Set(wanted.split(","));
    const { layers, toggleLayer } = useStore.getState();
    for (const spec of LAYERS) {
      if (UNMANAGED.has(spec.id)) continue;
      const l = layers[spec.id];
      if (!l) continue;
      const on = want.has(spec.id) && l.available;
      if (l.visible !== on) toggleLayer(spec.id);
    }
  }, [wanted, available]);

  useEffect(() => {
    const kinds = saved.current?.kinds ?? useStore.getState().placeKinds;
    useStore
      .getState()
      .setPlaceKinds(
        Object.fromEntries(Object.keys(kinds).map((k) => [k, setup.pins && kinds[k as keyof typeof kinds]])) as typeof kinds,
      );
  }, [setup.pins]);
}

/** Cámara y zoom: vuela al entrar al paso; si encuadra la ruta y todavía no hay, vuela cuando llega. */
function useStepCamera(lesson: Lesson, stepIndex: number, setup: StepSetup, hasRoute: boolean) {
  const step = lesson.steps[stepIndex];
  const spec = step?.camera;
  const { requestCamera, setZoomLock } = useEdu.getState();
  useEffect(() => {
    setZoomLock(setup.lockZoom);
  }, [setup.lockZoom, setZoomLock]);
  useEffect(() => () => setZoomLock(false), [setZoomLock]);
  useEffect(() => {
    if (spec) requestCamera(spec);
    // Solo al entrar al paso (y cuando aparece la ruta que se quiere encuadrar).
  }, [lesson.id, stepIndex, spec?.kind === "route" && hasRoute]);
}

/** Capas que el paso quiere y el server todavía no tiene. */
function useMissingLayers(setup: StepSetup): readonly string[] {
  const layers = useStore((s) => s.layers);
  return setup.layers
    .filter((id) => !UNMANAGED.has(id) && layers[id] && !layers[id].available)
    .map((id) => LAYERS.find((l) => l.id === id)?.label ?? id);
}

function LessonView({ lesson }: { readonly lesson: Lesson }) {
  const stepIndex = useEdu((s) => s.step);
  const prediction = useEdu((s) => s.prediction);
  const done = useEdu((s) => s.done);
  const skipped = useEdu((s) => s.skipped);
  const { goTo, skip, predict, complete, exit } = useEdu.getState();
  const { ctx, example, loading } = useLessonContext();
  const index = Math.min(stepIndex, lesson.steps.length - 1);
  const step = lesson.steps[index]!;
  const last = index >= lesson.steps.length - 1;
  const setup = setupAt(lesson, index);

  useRecordAttempts();
  useStage(step, setup, step.kind === "predict" && prediction !== null);
  useStepLayers(setup);
  useStepCamera(lesson, index, setup, ctx.route !== null);
  const missing = useMissingLayers(setup);

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

      {missing.length > 0 ? (
        <p className="text-warn">
          ⚠ Este paso usa {missing.length === 1 ? "la capa" : "las capas"} {missing.join(", ")}, que el server
          todavía no tiene.
        </p>
      ) : null}
      {setup.lockZoom ? (
        <p className="text-muted">
          <span aria-hidden>🔒 </span>Zoom trabado por la lección: podés mover el mapa, no acercarte.
        </p>
      ) : null}

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
