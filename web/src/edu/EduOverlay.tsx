import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FACTOR_LABEL } from "../components/route/VerdictCard";
import { useEdu, type Prediction } from "../state/edu";
import { lessonById, LESSONS, PREDICTABLE, setupAt, type Lesson, type LessonStep } from "./lessons";
import {
  useLessonContext,
  useMissingLayers,
  useRecordAttempts,
  useStage,
  useStepCamera,
  useStepLayers,
  usePlanSandbox,
} from "./stage";

/**
 * Modo entrenamiento, al estilo onboarding: un selector de misiones a pantalla
 * completa y, durante la lección, una tarjeta flotante que apunta a la pieza de
 * la interfaz de la que habla. El planificador sigue siendo el de siempre: la
 * tarjeta solo mira lo que contesta /api/route.
 *
 * Cada paso tiene una frase corta para cualquier edad (`say`) y, abajo, el
 * detalle con los números para quien quiera ir a fondo.
 *
 * Con el planificador de ejemplo (sin backend) no corrige nada: corregir con
 * números de ejemplo sería enseñar algo que el dato real no dice.
 */
export function EduOverlay() {
  const open = useEdu((s) => s.open);
  const lessonId = useEdu((s) => s.lessonId);
  const lesson = lessonById(lessonId);
  if (!open) return null;
  return lesson ? <LessonCoach key={lesson.id} lesson={lesson} /> : <LessonPicker />;
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
          ? "rounded-full border border-rust bg-rust/20 px-3 py-1 text-xs font-semibold text-fg"
          : "rounded-full border border-rust/70 px-3 py-1 text-xs font-semibold text-fg hover:bg-rust/15"
      }
    >
      <span aria-hidden>🎓 </span>
      {open ? "Salir del entrenamiento" : "Entrenamiento"}
    </button>
  );
}

// ------------------------------------------------------------------ selector

function LessonPicker() {
  const done = useEdu((s) => s.done);
  const { start, setOpen } = useEdu.getState();
  const count = LESSONS.filter((l) => done[l.id]).length;
  const next = LESSONS.find((l) => !done[l.id]);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  return (
    <div className="edu-fade fixed inset-0 z-[70] grid place-items-center bg-black/65 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="edu-picker-title"
        className="edu-card-in flex max-h-[92vh] w-full max-w-4xl flex-col gap-4 overflow-y-auto rounded-2xl border-2 border-rust bg-panel p-5 shadow-2xl sm:p-7"
      >
        <header className="flex items-start gap-4">
          <span aria-hidden className="text-5xl leading-none">🧑‍🚀</span>
          <div className="flex-1">
            <h2 id="edu-picker-title" className="text-2xl font-black tracking-tight">
              Entrenamiento de EVA
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-fg">
              Aprendé a planear una salida a la superficie de Marte. En cada misión usás el planificador
              real, con datos de la NASA: nada de lo que vas a ver está inventado.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Cerrar el entrenamiento"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-line text-lg text-muted hover:text-fg"
          >
            ✕
          </button>
        </header>

        <div className="flex items-center gap-3 text-sm">
          <div
            className="h-2.5 flex-1 overflow-hidden rounded-full bg-bg"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={LESSONS.length}
            aria-valuenow={count}
            aria-label="Misiones completadas"
          >
            <div className="h-full rounded-full bg-ok transition-all" style={{ width: `${(count / LESSONS.length) * 100}%` }} />
          </div>
          <span className="font-semibold">
            {count} de {LESSONS.length}
          </span>
        </div>

        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LESSONS.map((l, i) => {
            const isNext = l.id === next?.id;
            return (
              <li key={l.id}>
                <button
                  ref={i === 0 ? firstRef : undefined}
                  type="button"
                  onClick={() => start(l.id)}
                  className={`group flex h-full w-full flex-col gap-1.5 rounded-xl border-2 p-4 text-left transition hover:-translate-y-0.5 hover:border-rust focus-visible:border-rust ${
                    isNext ? "border-rust/70 bg-rust/10" : "border-line bg-bg/50"
                  }`}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span aria-hidden className="text-4xl leading-none transition group-hover:scale-110">
                      {l.icon}
                    </span>
                    {done[l.id] ? (
                      <span className="rounded-full bg-ok/20 px-2 py-0.5 text-xs font-bold text-ok">✓ hecha</span>
                    ) : isNext ? (
                      <span className="rounded-full bg-rust/25 px-2 py-0.5 text-xs font-bold text-fg">
                        {count === 0 ? "empezá acá" : "la que sigue"}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                    {i === LESSONS.length - 1 ? "Misión final" : `Misión ${i + 1}`} · {l.steps.length} pasos
                  </span>
                  <span className="text-base leading-snug font-bold text-fg">{l.title}</span>
                  <span className="text-sm leading-snug text-muted">{l.tagline}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <p className="text-[11px] text-muted">Prototipo educativo, no software de vuelo.</p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ lección

function LessonCoach({ lesson }: { readonly lesson: Lesson }) {
  const stepIndex = useEdu((s) => s.step);
  const prediction = useEdu((s) => s.prediction);
  const index = Math.min(stepIndex, lesson.steps.length - 1);
  const step = lesson.steps[index]!;
  const setup = setupAt(lesson, index);
  const { ctx, example, loading } = useLessonContext();
  const [minimized, setMinimized] = useState(false);

  usePlanSandbox();
  useRecordAttempts();
  useStage(step, setup, step.kind === "predict" && prediction !== null);
  useStepLayers(setup);
  useStepCamera(lesson, index, setup, ctx.route !== null);
  const missing = useMissingLayers(setup);

  // Paso nuevo: la tarjeta vuelve a abrirse.
  useEffect(() => setMinimized(false), [index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMinimized((m) => !m);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const anchor = step.anchor ?? step.focus?.[0] ?? "map";
  const rect = useAnchorRect(anchor);
  // En los pasos de mirar se oscurece todo menos la pieza de la que se habla.
  // En los de hacer, no: el alumno tiene que poder usar el mapa tranquilo.
  const dim = step.kind !== "task" && !minimized;

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="edu-card-in fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full border-2 border-rust bg-panel px-5 py-3 text-sm font-semibold text-fg shadow-2xl"
      >
        <span aria-hidden className="text-2xl leading-none">{lesson.icon}</span>
        <span>
          Paso {index + 1} de {lesson.steps.length}: {step.title}
        </span>
        <span className="text-rust">abrir ▴</span>
      </button>
    );
  }

  return (
    <>
      {dim ? <Spotlight rect={rect} /> : null}
      <CoachCard
        key={index}
        rect={rect}
        anchorIsMap={anchor === "map"}
        lesson={lesson}
        index={index}
        step={step}
        ctx={ctx}
        example={example}
        loading={loading}
        missing={missing}
        lockZoom={setup.lockZoom}
        onMinimize={() => setMinimized(true)}
      />
    </>
  );
}

interface CardProps {
  readonly rect: DOMRect | null;
  readonly anchorIsMap: boolean;
  readonly lesson: Lesson;
  readonly index: number;
  readonly step: LessonStep;
  readonly ctx: ReturnType<typeof useLessonContext>["ctx"];
  readonly example: boolean;
  readonly loading: boolean;
  readonly missing: readonly string[];
  readonly lockZoom: boolean;
  readonly onMinimize: () => void;
}

function CoachCard({ rect, anchorIsMap, lesson, index, step, ctx, example, loading, missing, lockZoom, onMinimize }: CardProps) {
  const prediction = useEdu((s) => s.prediction);
  const done = useEdu((s) => s.done);
  const skipped = useEdu((s) => s.skipped);
  const { goTo, skip, predict, complete, exit } = useEdu.getState();
  const last = index >= lesson.steps.length - 1;

  const cardRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [height, setHeight] = useState(320);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    setHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  // El lector de pantalla y el teclado arrancan en el paso nuevo.
  useEffect(() => headingRef.current?.focus(), []);

  const pos = placeCard(rect, height, anchorIsMap);
  const check = step.kind === "task" ? step.check(ctx) : null;
  const canAdvance =
    step.kind === "info" ||
    (step.kind === "task" && check?.done === true && !example) ||
    (step.kind === "predict" && prediction !== null && ctx.route !== null);

  return (
    <section
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="edu-say"
      className="edu-card-in fixed z-[60] flex max-h-[calc(100vh-32px)] w-[min(400px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border-2 border-rust bg-panel text-fg shadow-[0_18px_50px_rgb(0_0_0/0.6)]"
      style={{ left: pos.left, top: pos.top }}
    >
      <header className="flex items-center gap-3 border-b border-line bg-bg/60 px-4 py-2.5">
        <span aria-hidden className="text-3xl leading-none">{lesson.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-muted">{lesson.title}</p>
          <Dots total={lesson.steps.length} current={index} />
        </div>
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Achicar la tarjeta (Esc)"
          title="Achicar (Esc)"
          className="grid size-9 place-items-center rounded-full text-lg text-muted hover:bg-line hover:text-fg"
        >
          ▾
        </button>
        <button
          type="button"
          onClick={exit}
          aria-label="Volver a las misiones"
          title="Volver a las misiones"
          className="grid size-9 place-items-center rounded-full text-lg text-muted hover:bg-line hover:text-fg"
        >
          ✕
        </button>
      </header>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
        <p className="text-xs font-bold tracking-wide text-rust uppercase">{step.title}</p>
        <h2 id="edu-say" ref={headingRef} tabIndex={-1} className="text-lg leading-snug font-bold outline-none">
          {step.say}
        </h2>

        {step.kind === "task" ? (
          <div className="rounded-xl border-2 border-rust/60 bg-rust/10 p-3">
            <p className="text-[11px] font-bold tracking-wide text-rust uppercase">
              <span aria-hidden>🎯 </span>Tu misión
            </p>
            <p className="mt-0.5 text-sm font-semibold">{step.goal}</p>
          </div>
        ) : null}

        {example ? (
          <Banner tone="warn">
            Esta ruta la calculó el planificador de ejemplo, no el real. Con esos números la lección no te
            puede corregir.
          </Banner>
        ) : step.kind === "task" && check ? (
          loading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted">
              <span aria-hidden className="edu-spin inline-block">◌</span> Calculando tu ruta…
            </p>
          ) : check.blocked ? (
            <Banner tone="warn">
              <strong>Con los datos de hoy no se puede. </strong>
              {check.hint} Podés saltear el paso, pero la misión no va a quedar como hecha.
            </Banner>
          ) : check.done ? (
            <div role="status" className="edu-pop rounded-xl border-2 border-ok bg-ok/15 p-3 text-sm">
              <p className="text-base font-black text-ok">
                <span aria-hidden>🎉 </span>¡Lo lograste!
              </p>
              {check.hint ? <p className="mt-1">{check.hint}</p> : null}
            </div>
          ) : check.hint ? (
            <p role="status" className="flex gap-2 rounded-xl bg-bg/70 p-3 text-sm">
              <span aria-hidden>💡</span>
              <span>{check.hint}</span>
            </p>
          ) : null
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

        <details open={step.kind !== "task"} className="group rounded-xl border border-line bg-bg/40">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-muted select-none hover:text-fg">
            <span className="inline-block transition group-open:rotate-90" aria-hidden>
              ▸
            </span>{" "}
            Más a fondo
          </summary>
          <div className="flex flex-col gap-2 px-3 pb-3 text-[13px] leading-relaxed">{step.body(ctx)}</div>
        </details>

        {missing.length > 0 ? (
          <p className="text-xs text-warn">
            ⚠ Este paso usa {missing.length === 1 ? "la capa" : "las capas"} {missing.join(", ")}, que el server
            todavía no tiene.
          </p>
        ) : null}
        {lockZoom ? (
          <p className="text-xs text-muted">
            <span aria-hidden>🔒 </span>Zoom trabado para que mires esto: podés mover el mapa.
          </p>
        ) : null}
        {skipped && last ? (
          <p className="text-xs text-muted">Salteaste un paso por falta de datos: esta misión no va a quedar como hecha.</p>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-bg/60 px-4 py-3">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => goTo(index - 1)}
          className="min-h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-30"
        >
          Atrás
        </button>
        {check?.blocked && !canAdvance && !last ? (
          <button
            type="button"
            onClick={() => skip(index + 1)}
            className="min-h-11 rounded-full border border-warn px-4 text-sm text-fg"
          >
            Saltear
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
              goTo(index + 1);
            }
          }}
          className="ml-auto min-h-11 rounded-full bg-rust px-6 text-sm font-bold text-bg shadow transition hover:brightness-110 disabled:bg-line disabled:text-muted disabled:shadow-none"
        >
          {last ? (done[lesson.id] ? "Terminar" : "¡Terminar misión!") : index === 0 ? "¡Vamos!" : "Siguiente"}
        </button>
        <p className="w-full text-[10px] text-muted">Prototipo educativo, no software de vuelo.</p>
      </footer>
    </section>
  );
}

function Dots({ total, current }: { readonly total: number; readonly current: number }) {
  return (
    <p className="mt-1 flex items-center gap-1" aria-label={`Paso ${current + 1} de ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={`h-1.5 rounded-full transition-all ${
            i < current ? "w-3 bg-ok" : i === current ? "w-6 bg-rust" : "w-3 bg-line"
          }`}
        />
      ))}
    </p>
  );
}

function Banner({ tone, children }: { readonly tone: "warn"; readonly children: ReactNode }) {
  return (
    <p role="status" className={`rounded-xl border-2 p-3 text-sm ${tone === "warn" ? "border-warn bg-warn/10" : ""}`}>
      <span aria-hidden>⚠️ </span>
      {children}
    </p>
  );
}

interface PredictProps {
  readonly question: string;
  readonly prediction: Prediction | null;
  readonly onPredict: (p: Prediction) => void;
  readonly hasRoute: boolean;
  readonly reveal: ReactNode;
}

const FACTOR_ICON: Partial<Record<Prediction, string>> = {
  terrain: "⛰️",
  o2: "🫧",
  battery: "🔋",
  daylight: "🌅",
  contact: "📡",
  dose: "☢️",
};

function PredictBlock({ question, prediction, onPredict, hasRoute, reveal }: PredictProps) {
  if (prediction !== null) return <div className="edu-pop flex flex-col gap-2 text-sm">{reveal}</div>;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">{question}</legend>
      {!hasRoute ? <p className="text-xs text-muted">Primero armá una ruta (la respuesta sigue tapada).</p> : null}
      <div className="grid grid-cols-2 gap-2">
        {PREDICTABLE.map((f) => (
          <button
            key={f}
            type="button"
            disabled={!hasRoute}
            onClick={() => onPredict(f)}
            className="flex min-h-11 items-center gap-2 rounded-xl border-2 border-line px-3 py-2 text-left text-sm font-semibold transition hover:border-rust hover:bg-rust/10 disabled:opacity-40"
          >
            <span aria-hidden className="text-xl leading-none">{FACTOR_ICON[f]}</span>
            {FACTOR_LABEL[f]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ posición

/** Atenúa todo menos la pieza señalada. No bloquea clics. */
function Spotlight({ rect }: { readonly rect: DOMRect | null }) {
  if (!rect) return <div aria-hidden className="edu-fade pointer-events-none fixed inset-0 z-[55] bg-black/45" />;
  const pad = 6;
  return (
    <div
      aria-hidden
      className="edu-fade pointer-events-none fixed z-[55] rounded-xl transition-all duration-300"
      style={{
        left: rect.left - pad,
        top: rect.top - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.5)",
      }}
    />
  );
}

/** Rectángulo en pantalla de la pieza `[data-edu=anchor]`. null si no se ve. */
function useAnchorRect(anchor: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = "";
    // Por cuadro: los paneles cambian de tamaño, el mapa vuela, la página scrollea.
    const tick = () => {
      const r = document.querySelector(`[data-edu="${anchor}"]`)?.getBoundingClientRect();
      const visible = r && r.width > 0 && r.height > 0;
      const key = visible ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}` : "";
      if (key !== last) {
        last = key;
        setRect(visible ? r : null);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [anchor]);
  return rect;
}

const MARGIN = 16;
const GAP = 16;
const CARD_W = 400;

/**
 * Dónde va la tarjeta: al costado de la pieza (derecha, izquierda, abajo,
 * arriba, en ese orden), o adentro del mapa arriba a la izquierda si la
 * pieza es el mapa. Siempre dentro de la ventana.
 */
function placeCard(r: DOMRect | null, h: number, inside: boolean): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(CARD_W, vw - MARGIN * 2);
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, vw - w - MARGIN));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, vh - h - MARGIN));
  if (!r) return { left: clampX((vw - w) / 2), top: clampY((vh - h) / 2) };
  if (inside) return { left: clampX(r.left + 24), top: clampY(r.top + 24) };
  if (r.right + GAP + w <= vw - MARGIN) return { left: r.right + GAP, top: clampY(r.top) };
  if (r.left - GAP - w >= MARGIN) return { left: r.left - GAP - w, top: clampY(r.top) };
  if (r.bottom + GAP + h <= vh - MARGIN) return { left: clampX(r.left), top: r.bottom + GAP };
  if (r.top - GAP - h >= MARGIN) return { left: clampX(r.left), top: r.top - GAP - h };
  return { left: clampX((vw - w) / 2), top: clampY((vh - h) / 2) };
}
