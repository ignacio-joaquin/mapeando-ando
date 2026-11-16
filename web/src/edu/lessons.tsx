/**
 * Lecciones del modo entrenamiento: una por cada dificultad de planificar una
 * EVA en Marte. Diseño en docs/educacion.md.
 *
 * Regla: una lección no trae números propios. Los que muestra salen de la
 * respuesta real de /api/route (vía ./read.ts), y las consignas se corrigen con
 * predicados sobre esa respuesta, nunca contra un valor esperado escrito acá.
 * Si el equipo cambia un límite, las lecciones siguen andando y el texto cambia solo.
 */
import type { ReactNode } from "react";
import type { LimitingFactor, PlacesIndex, RouteResponse } from "../api/schemas";
import { FACTOR_LABEL } from "../components/route/VerdictCard";
import { formatDistanceM, formatMinutes, ltstShort } from "../components/route/format";
import { PROVENANCE_LABEL, type Provenance } from "../domain/provenance";
import type { Waypoint } from "../state/plan";
import type { Attempt, CameraSpec, Prediction } from "../state/edu";
import {
  assumedLimits,
  costMinutes,
  limitOf,
  marginPct,
  maxSlope,
  measure,
  num,
  totalMinutes,
  val,
  walkedVsStraight,
} from "./read";
import { Caveat, Facts, List, NeedRoute, P } from "./ui";
import { tNow, trNow, useLang, type Lang, type T } from "../i18n/lang";

/** Piezas de la interfaz que una lección puede señalar u ocultar (atributo data-edu). */
export const EDU_TARGET = {
  VERDICT: "verdict",
  BREAKDOWN: "breakdown",
  DEPART: "depart",
  SUN: "sun-timeline",
  LAYERS: "layers",
  POINTS: "points",
  SEARCH: "search",
  PROFILE: "profile",
  CLOCK: "clock",
  INSPECTOR: "inspector",
  SHARE: "share",
  TOOLS: "tools",
  /** Selector de carga del equipo. Ninguna lección lo muestra todavía: corren con cargo_kg 0. */
  CARGO: "cargo",
} as const;
export type EduTarget = (typeof EDU_TARGET)[keyof typeof EDU_TARGET];

export interface LessonContext {
  /** Ruta del planificador real para los puntos y la hora de ahora. null = no hay. */
  readonly route: RouteResponse | null;
  readonly waypoints: readonly Waypoint[];
  /** Intentos reales de esta lección (nunca del planificador de ejemplo). */
  readonly attempts: readonly Attempt[];
  readonly places: PlacesIndex | null;
}

export interface CheckResult {
  readonly done: boolean;
  /** Qué falta o qué probar. null cuando está hecho y no hay nada que agregar. */
  readonly hint: string | null;
  /**
   * La consigna no se puede cumplir con los datos que tiene hoy el server (falta
   * una capa, un índice). Se puede saltear el paso, pero la lección no queda hecha.
   */
  readonly blocked?: boolean;
}

interface StepBase {
  readonly title: string;
  /**
   * Lo central del paso en una frase corta y clara, para cualquier edad. Va
   * grande en la tarjeta; `body` queda abajo, para quien quiera el detalle.
   */
  readonly say: string;
  /** A qué pieza apunta la tarjeta. Sin definir: la primera resaltada, o el mapa. */
  readonly anchor?: EduTarget | "map";
  readonly body: (ctx: LessonContext) => ReactNode;
  /** Se resaltan en la interfaz mientras dura el paso. */
  readonly focus?: readonly EduTarget[];
  /** Se tapan mientras dura el paso (para predecir sin ver la respuesta). */
  readonly hide?: readonly EduTarget[];
  /**
   * Piezas de la interfaz que aparecen desde este paso. Se acumulan: lo que
   * mostró un paso anterior sigue visible. Lo resaltado o tapado también se ve.
   */
  readonly ui?: readonly EduTarget[];
  /** Capas del mapa prendidas, exactas (las demás se apagan). Sin definir = las del paso anterior. */
  readonly layers?: readonly string[];
  /** Pines de lugares en el mapa. Sin definir = como en el paso anterior (al empezar, apagados). */
  readonly pins?: boolean;
  /** A dónde vuela la cámara al entrar al paso. */
  readonly camera?: CameraSpec;
  /** Zoom trabado. Sin definir = como en el paso anterior (al empezar, libre). */
  readonly lockZoom?: boolean;
}

export interface InfoStep extends StepBase {
  readonly kind: "info";
}

/**
 * Escenario armado con dos lugares reales de places.json (por id, nunca con
 * coordenadas escritas a mano): hábitat → destino, con ida y vuelta. Se eligió
 * consultando /api/route; `expect` es lo que mostraba ese día. La tarjeta lo
 * vuelve a verificar en vivo y, si los datos cambiaron, lo dice.
 */
export interface Preset {
  readonly site: string;
  readonly label: string;
  readonly expect: LimitingFactor;
  readonly habitat: string;
  readonly destination: string;
  readonly dwellMin: number;
}

export interface TaskStep extends StepBase {
  readonly kind: "task";
  /** Escenario para quien no encuentra uno solo: apoyo paso a paso. */
  readonly preset?: Preset;
  /** Deslizador de hora de salida en la tarjeta. */
  readonly timeSlider?: boolean;
  /** La consigna, en una línea. */
  readonly goal: string;
  readonly check: (ctx: LessonContext) => CheckResult;
}

export interface PredictStep extends StepBase {
  readonly kind: "predict";
  readonly question: string;
  /** `route` es la ruta contra la que predijo, congelada: si después la cambia, la corrección no cambia. */
  readonly reveal: (route: RouteResponse, prediction: Prediction) => ReactNode;
}

export type LessonStep = InfoStep | TaskStep | PredictStep;

/** Datos del server sin los que la misión no se puede completar. */
export type LessonNeed = "shadows" | "places";

export interface Lesson {
  readonly id: string;
  readonly requires?: readonly LessonNeed[];
  /** Al salir, se queda la ruta que armó el alumno en vez de volver la de antes. */
  readonly keepsRoute?: boolean;
  /** Emoji decorativo de la tarjeta (va con aria-hidden). */
  readonly icon: string;
  readonly title: string;
  /** La dificultad, en una frase. */
  readonly tagline: string;
  readonly steps: readonly LessonStep[];
}

/** Capas al empezar una lección: solo el relieve sombreado sobre la imagen (base-ortho no se toca). */
const START_LAYERS: readonly string[] = ["relief-hillshade"];

export interface StepSetup {
  readonly ui: ReadonlySet<EduTarget>;
  readonly layers: readonly string[];
  readonly pins: boolean;
  readonly lockZoom: boolean;
}

/** Lo que vale en el paso `index`, acumulando lo que dijeron los pasos anteriores. */
export function setupAt(lesson: Lesson, index: number): StepSetup {
  const ui = new Set<EduTarget>();
  let layers = START_LAYERS;
  let pins = false;
  let lockZoom = false;
  for (const s of lesson.steps.slice(0, index + 1)) {
    for (const t of [...(s.ui ?? []), ...(s.focus ?? []), ...(s.hide ?? [])]) ui.add(t);
    if (s.layers) layers = s.layers;
    if (s.pins !== undefined) pins = s.pins;
    if (s.lockZoom !== undefined) lockZoom = s.lockZoom;
  }
  return { ui, layers, pins, lockZoom };
}

/** Factores que el alumno puede elegir al predecir. Calorías no: no tiene tope todavía. */
export const PREDICTABLE: readonly LimitingFactor[] = ["terrain", "o2", "battery", "daylight", "contact", "dose"];

// ------------------------------------------------------------------ chequeos comunes

/** Intentos con los mismos puntos que el último. */
function sameGeometry(attempts: readonly Attempt[]): readonly Attempt[] {
  const last = attempts.at(-1);
  return last ? attempts.filter((a) => a.geometryKey === last.geometryKey) : [];
}

const STATUS_WORD: Record<Attempt["status"], string> = { GO: "GO", CAUTION: "CAUTION", NO_GO: "NO-GO" };

/** Recorre la respuesta y cuenta cuántos valores hay de cada procedencia. */
function countProvenance(node: unknown, acc: Record<Provenance, number>): Record<Provenance, number> {
  if (Array.isArray(node)) {
    for (const n of node) countProvenance(n, acc);
  } else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const p = o["provenance"];
    if (typeof p === "string" && p in acc && "value" in o) acc[p as Provenance] += 1;
    for (const v of Object.values(o)) countProvenance(v, acc);
  }
  return acc;
}

function revealFactor(route: RouteResponse, prediction: Prediction): ReactNode {
  const real = route.verdict.limiting_factor;
  if (!real) {
    return (
      <P>
        {tNow(
          "El planificador no pudo nombrar un factor limitante: ningún límite se pudo evaluar del todo.",
          "The planner could not name a limiting factor: no limit could be fully evaluated.",
        )}
      </P>
    );
  }
  const hit = real === prediction;
  const l = limitOf(route, real);
  const said = prediction === "none" ? tNow("nada", "nothing") : trNow(FACTOR_LABEL[prediction]);
  return (
    <div className="flex flex-col gap-2">
      <P>
        {hit ? (
          <strong className="text-ok">{tNow("✓ Acertaste. ", "✓ You got it. ")}</strong>
        ) : (
          <strong className="text-warn">✕ No. </strong>
        )}
        {tNow(
          <>
            Dijiste <strong>{said}</strong>; el margen más chico es el de <strong>{FACTOR_LABEL[real]}</strong>
            {l ? <> ({marginPct(l)} de margen)</> : null}.
          </>,
          <>
            You said <strong>{said}</strong>; the smallest margin is <strong>{trNow(FACTOR_LABEL[real])}</strong>
            {l ? <> ({marginPct(l)} margin)</> : null}.
          </>,
        )}
      </P>
      <P>
        {tNow(
          "El puntaje de la ruta es ese margen: la cadena se corta por el eslabón más débil, no por el promedio.",
          "The route score is that margin: a chain breaks at its weakest link, not at the average.",
        )}
      </P>
    </div>
  );
}

// ------------------------------------------------------------------ lecciones

/**
 * Las lecciones se arman por idioma: `t("español", "English")` elige el texto.
 * Se construyen una vez por idioma y quedan en caché (getLessons).
 */
function build(t: T): readonly Lesson[] {
  const NO_ROUTE: CheckResult = {
    done: false,
    hint: t(
      "Armá una ruta: marcá el hábitat con un clic y elegí un destino.",
      "Build a route: mark the habitat with a click and choose a destination.",
    ),
  };
  const hasRoute = (ctx: LessonContext): CheckResult => (ctx.route ? { done: true, hint: null } : NO_ROUTE);


  const datos: Lesson = {
    id: "datos",
    icon: "🔎",
    title: t("Desconfiá de un número sin fuente", "Distrust a number without a source"),
    tagline: t(
      "En Marte no hay segunda opinión: tenés que saber de dónde sale cada dato.",
      "On Mars there is no second opinion: you have to know where every piece of data comes from.",
    ),
    steps: [
      {
        kind: "info",
        title: t("Cuatro tipos de dato", "Four kinds of data"),
        say: t(
          "Cada número del mapa dice de dónde salió. Antes de confiar en uno, mirá su etiqueta.",
          "Every number on the map says where it came from. Before trusting one, look at its label.",
        ),
        camera: { kind: "site" }, lockZoom: true,
        body: () =>
          t(
            <>
              <P>
                Cada número del planificador trae un badge que dice de dónde sale. No es decoración: un
                dato medido y uno supuesto pesan distinto cuando tenés que decidir si salís.
              </P>
              <List
                items={[
                  <><strong>Observado</strong>: lo midió un instrumento (por ejemplo el relieve de HiRISE).</>,
                  <><strong>Derivado</strong>: calculado sin supuestos a partir de algo observado (la pendiente).</>,
                  <><strong>Modelado</strong>: sale de un modelo con supuestos, que van listados (el consumo de O₂).</>,
                  <><strong>Supuesto</strong>: un valor que eligió el equipo sin fuente citable todavía.</>,
                ]}
              />
              <P>Y un valor que falta se muestra como faltante: nunca se rellena.</P>
            </>,
            <>
              <P>
                Every number in the planner carries a badge that says where it comes from. It is not decoration: a
                measured value and an assumed one weigh differently when you have to decide whether to go out.
              </P>
              <List
                items={[
                  <><strong>Observed</strong>: an instrument measured it (for example the HiRISE terrain).</>,
                  <><strong>Derived</strong>: calculated without assumptions from something observed (slope).</>,
                  <><strong>Modeled</strong>: it comes from a model with assumptions, which are listed (O₂ use).</>,
                  <><strong>Assumed</strong>: a value the team chose without a citable source yet.</>,
                ]}
              />
              <P>And a missing value is shown as missing: it is never filled in.</P>
            </>,
          ),
      },
      {
        kind: "task",
        title: t("Armá una ruta cualquiera", "Build any route"),
        say: t(
          "Hacé clic en el mapa para marcar tu base (el hábitat) y después elegí a dónde ir.",
          "Click on the map to mark your base (the habitat) and then choose where to go.",
        ),
        lockZoom: false,
        goal: t("Marcá el hábitat y elegí un destino.", "Mark the habitat and choose a destination."),
        focus: [EDU_TARGET.POINTS, EDU_TARGET.SEARCH],
        body: () => (
          <P>
            {t(
              "Cualquier destino sirve. Vamos a mirar de qué está hecha la respuesta.",
              "Any destination works. We are going to look at what the answer is made of.",
            )}
          </P>
        ),
        check: hasRoute,
      },
      {
        kind: "info",
        title: t("De qué está hecha tu ruta", "What your route is made of"),
        say: t(
          "Esto es lo que el planificador midió, lo que calculó y lo que supuso para tu ruta.",
          "This is what the planner measured, what it calculated and what it assumed for your route.",
        ),
        camera: { kind: "route" }, lockZoom: true, ui: [EDU_TARGET.VERDICT],
        focus: [EDU_TARGET.BREAKDOWN],
        body: ({ route }) => {
          if (!route) return <NeedRoute />;
          const c = countProvenance(route, { OBSERVED: 0, DERIVED: 0, MODELED: 0, ASSUMED: 0 });
          const unknown = route.legs.filter((l) => l.class === "unknown").length;
          const assumed = assumedLimits(route);
          return (
            <>
              <P>{t("Contando todos los valores de la respuesta del planificador:", "Counting all the values in the planner's answer:")}</P>
              <Facts
                rows={(Object.keys(c) as Provenance[]).map((p) => [trNow(PROVENANCE_LABEL[p]), String(c[p])] as const)}
              />
              {unknown > 0 ? (
                <Caveat>
                  {t(
                    `${unknown} ${unknown === 1 ? "tramo va" : "tramos van"} punteado: ahí no hay terreno de 1 m y el planificador no lo pudo evaluar. Punteado no quiere decir seguro.`,
                    `${unknown} ${unknown === 1 ? "segment is" : "segments are"} dashed: there is no 1 m terrain there and the planner could not evaluate it. Dashed does not mean safe.`,
                  )}
                </Caveat>
              ) : null}
              {assumed.length > 0 ? (
                <Caveat>
                  {t("Límites que eligió el equipo sin fuente citable:", "Limits the team chose without a citable source:")}{" "}
                  {assumed.map((l) => `${trNow(l.label)} (${measure(l.limit)})`).join(", ")}.{" "}
                  {t("Abrí “Límites duros” y tocá el badge de cada uno.", "Open “Hard limits” and tap each one's badge.")}
                </Caveat>
              ) : null}
            </>
          );
        },
      },
    ],
  };

  const pendiente: Lesson = {
    id: "pendiente",
    icon: "⛰️",
    title: t("No se puede caminar por cualquier lado", "You cannot walk just anywhere"),
    tagline: t(
      "La línea recta casi nunca es el camino: la pendiente decide por dónde vas.",
      "The straight line is almost never the path: slope decides where you go.",
    ),
    steps: [
      {
        kind: "info",
        title: t("Por qué la pendiente manda", "Why slope rules"),
        say: t(
          "Si es muy empinado, no se pasa. Lo que la leyenda marca “no transitable”, el planificador no lo pisa.",
          "If it is too steep, you cannot get through. What the legend marks “impassable”, the planner never steps on.",
        ),
        camera: { kind: "site" }, lockZoom: true,
        layers: ["relief-hillshade", "relief-slope"],
        focus: [EDU_TARGET.LAYERS],
        body: () =>
          t(
            <>
              <P>
                Con un traje de más de 100 kg, en regolito suelto y con la vista recortada por el casco,
                una ladera empinada es una caída posible y un consumo de O₂ que se dispara.
              </P>
              <P>
                Prendí la capa de pendiente: lo que la leyenda marca “no transitable” es lo que el planificador no pisa. Ese corte es el
                mismo en el mapa y en el cálculo de la ruta.
              </P>
            </>,
            <>
              <P>
                In a suit of more than 100 kg, on loose regolith and with your view cut off by the helmet, a
                steep slope is a possible fall and an O₂ consumption that shoots up.
              </P>
              <P>
                Turn on the slope layer: what the legend marks “impassable” is what the planner never steps on. That cutoff is
                the same on the map and in the route calculation.
              </P>
            </>,
          ),
      },
      {
        kind: "task",
        title: t("Forzá un desvío", "Force a detour"),
        preset: {
          site: "jezero",
          label: t("Un atajo empinado: de vindholet a bubenka 1695", "A steep shortcut: from vindholet to bubenka 1695"),
          expect: "terrain",
          habitat: "target-vindholet",
          destination: "target-bubenka-1695",
          dwellMin: 15,
        },
        say: t(
          "Elegí un destino detrás de una loma o del borde de un cráter, y mirá cómo la ruta lo esquiva.",
          "Choose a destination behind a hill or a crater rim, and watch how the route avoids it.",
        ),
        lockZoom: false,
        goal: t("Elegí un destino al que no se pueda ir en línea recta.", "Choose a destination you cannot reach in a straight line."),
        focus: [EDU_TARGET.SEARCH, EDU_TARGET.POINTS],
        body: () => (
          <P>
            {t(
              "Buscá un destino del otro lado de una zona naranja o roja de la capa de pendiente (el borde de un cráter, una loma) y mirá cómo dobla la ruta.",
              "Look for a destination on the other side of an orange or red area of the slope layer (a crater rim, a hill) and watch the route bend.",
            )}
          </P>
        ),
        check: ({ route }) => {
          if (!route) return NO_ROUTE;
          const d = walkedVsStraight(route);
          // Solo cuenta lo que de verdad aprieta: "con cuidado" (10–20°) lo tienen casi todas las rutas.
          const steep = route.legs.some((l) => l.class === "limit" || l.class === "blocked");
          if (!d) {
            return {
              done: steep,
              hint: steep ? null : t("Esta ruta tiene tramos sin distancia: probá otro destino.", "This route has segments without distance: try another destination."),
            };
          }
          const extra = d.walked / d.straight - 1;
          if (extra >= 0.15 || steep) return { done: true, hint: null };
          return {
            done: false,
            hint: t(
              `Tu ruta camina un ${num(extra * 100, 0)} % más que la línea recta: casi no se desvía. Buscá un destino detrás de algo empinado.`,
              `Your route walks ${num(extra * 100, 0)} % more than the straight line: it barely detours. Look for a destination behind something steep.`,
            ),
          };
        },
      },
      {
        kind: "info",
        title: t("Lo que te costó", "What it cost you"),
        say: t("Esto te costó el desvío. Lo más corto no siempre es lo más seguro.", "This is what the detour cost you. The shortest is not always the safest."),
        camera: { kind: "route" }, lockZoom: true, ui: [EDU_TARGET.VERDICT, EDU_TARGET.PROFILE],
        focus: [EDU_TARGET.BREAKDOWN],
        body: ({ route }) => {
          if (!route) return <NeedRoute />;
          const d = walkedVsStraight(route);
          const terrain = limitOf(route, "terrain");
          const slopeMin = costMinutes(route, "slope");
          return (
            <>
              <Facts
                rows={[
                  [t("Línea recta", "Straight line"), d ? formatDistanceM(d.straight) : t("sin dato", "no data")],
                  [t("Caminado", "Walked"), d ? formatDistanceM(d.walked) : t("sin dato", "no data")],
                  [t("Desvío", "Detour"), d ? `+${num((d.walked / d.straight - 1) * 100, 0)} %` : t("sin dato", "no data")],
                  [t("Pendiente más fuerte que pisás", "Steepest slope you step on"), `${num(maxSlope(route), 1)}°`],
                  [t("Límite de pendiente", "Slope limit"), measure(terrain?.limit)],
                  [t("Costo extra por pendiente", "Extra cost from slope"), slopeMin === null ? t("sin dato", "no data") : formatMinutes(slopeMin)],
                ]}
              />
              <P>
                {t(
                  "El planificador no busca la ruta más corta: busca la de menor costo, y una celda empinada cuesta más que su tiempo de caminata. Por eso a veces conviene dar la vuelta aunque se pueda pasar.",
                  "The planner does not look for the shortest route: it looks for the lowest-cost one, and a steep cell costs more than its walking time. That is why it sometimes pays to go around even when you could get through.",
                )}
              </P>
              <Caveat>
                {t(
                  "El límite de pendiente es un supuesto del equipo. Y el modelo de consumo (Pandolf) se validó en pendientes mucho más suaves que ese límite (docs/seguridad.md): en lo empinado, el consumo es una extrapolación.",
                  "The slope limit is a team assumption. And the consumption model (Pandolf) was validated on slopes much gentler than that limit (docs/seguridad.md): on steep ground, consumption is an extrapolation.",
                )}
              </Caveat>
            </>
          );
        },
      },
    ],
  };

  const reloj: Lesson = {
    id: "reloj",
    requires: ["shadows"],
    icon: "🌗",
    title: t("El mapa cambia con la hora", "The map changes with the time"),
    tagline: t(
      "La misma ruta puede ser segura a la mañana y peligrosa a la tarde.",
      "The same route can be safe in the morning and dangerous in the afternoon.",
    ),
    steps: [
      {
        kind: "info",
        title: t("Planificar en 4D", "Planning in 4D"),
        say: t(
          "En Marte el sol también se mueve: las sombras cambian y de noche no se sale.",
          "On Mars the Sun also moves: shadows change and you do not go out at night.",
        ),
        camera: { kind: "site" }, lockZoom: true, ui: [EDU_TARGET.CLOCK], layers: ["relief-hillshade", "survival-shadows"],
        focus: [EDU_TARGET.SUN],
        body: () =>
          t(
            <>
              <P>
                Un sol dura 24 h 39 min. Las sombras de los cráteres se mueven con el sol, y en la sombra hace
                más frío. Además, tenés que estar de vuelta antes de que oscurezca.
              </P>
              <P>
                Por eso el planificador mira a qué hora pasás por cada celda y, si puede, evita la sombra: no es
                un mapa fijo, es un mapa que cambia mientras caminás.
              </P>
            </>,
            <>
              <P>
                A sol lasts 24 h 39 min. Crater shadows move with the Sun, and it is colder in the shadow. Also,
                you have to be back before dark.
              </P>
              <P>
                That is why the planner looks at what time you pass each cell and, if it can, avoids the shadow: it
                is not a fixed map, it is a map that changes while you walk.
              </P>
            </>,
          ),
      },
      {
        kind: "task",
        title: t("Hacé que la hora cambie el veredicto", "Make the time change the verdict"),
        timeSlider: true,
        say: t(
          "Dejá los mismos puntos y cambiá solo la hora de salida, hasta que cambie el veredicto.",
          "Keep the same points and change only the departure time, until the verdict changes.",
        ),
        lockZoom: false, ui: [EDU_TARGET.SEARCH, EDU_TARGET.POINTS, EDU_TARGET.VERDICT],
        goal: t(
          "Con los mismos puntos, encontrá dos horas de salida con veredictos distintos.",
          "With the same points, find two departure times with different verdicts.",
        ),
        focus: [EDU_TARGET.DEPART, EDU_TARGET.SUN],
        body: () => (
          <P>
            {t(
              "Armá una ruta y movete solo con la hora de salida. Probá salir cerca del atardecer, o una ruta larga con una parada de una hora.",
              "Build a route and only move the departure time. Try leaving close to sunset, or a long route with a one-hour stop.",
            )}
          </P>
        ),
        check: (ctx) => {
          if (!ctx.route) return NO_ROUTE;
          const daylight = limitOf(ctx.route, "daylight");
          // Solo intentos con la luz evaluada: si no, el cambio puede venir de que una
          // hora tiene sombras calculadas y la otra no, que no es el efecto de la hora.
          const same = sameGeometry(ctx.attempts).filter((a) => a.daylightEvaluated);
          const statuses = new Set(same.map((a) => a.status));
          if (statuses.size >= 2) return { done: true, hint: null };
          if (daylight?.status === "not_evaluated" || daylight?.complete === false) {
            return {
              done: false,
              blocked: true,
              hint: t(
                "Para esta fecha el server no tiene sombras calculadas: el planificador no sabe cuándo atardece, " +
                  "y sin eso la hora no cambia el veredicto. Si la línea de sol de abajo del mapa muestra algún sol, " +
                  "probá una fecha de ese sol.",
                "For this date the server has no computed shadows: the planner does not know when sunset is, " +
                  "and without that the time does not change the verdict. If the sun timeline below the map shows a sol, " +
                  "try a date on that sol.",
              ),
            };
          }
          const only = same[0];
          return {
            done: false,
            hint:
              same.length <= 1
                ? t("Ahora cambiá la hora de salida sin tocar los puntos.", "Now change the departure time without touching the points.")
                : t(
                    `Probaste ${same.length} horas con estos puntos y todas dieron ${only ? STATUS_WORD[only.status] : "lo mismo"}. Acercate al atardecer, o alargá la ruta.`,
                    `You tried ${same.length} times with these points and they all gave ${only ? STATUS_WORD[only.status] : "the same"}. Get closer to sunset, or make the route longer.`,
                  ),
          };
        },
      },
      {
        kind: "info",
        title: t("Lo que cambió", "What changed"),
        say: t("La misma ruta, a distintas horas, da resultados distintos.", "The same route, at different times, gives different results."),
        camera: { kind: "route" }, lockZoom: true,
        focus: [EDU_TARGET.BREAKDOWN],
        body: (ctx) => {
          if (!ctx.route) return <NeedRoute />;
          const origin = ctx.waypoints[0];
          const same = [...sameGeometry(ctx.attempts)].sort((a, b) => a.departMs - b.departMs);
          const anyUnlit = same.some((a) => !a.daylightEvaluated);
          const daylight = limitOf(ctx.route, "daylight");
          const shadowMin = costMinutes(ctx.route, "shadow");
          return (
            <>
              <P>{t("Tus salidas con los mismos puntos:", "Your departures with the same points:")}</P>
              <Facts
                rows={same.map(
                  (a) =>
                    [
                      origin ? `${ltstShort(new Date(a.departMs), origin.lon)} LTST` : new Date(a.departMs).toISOString(),
                      `${STATUS_WORD[a.status]}${a.limiting ? ` · ${trNow(FACTOR_LABEL[a.limiting])}` : ""}`,
                    ] as const,
                )}
              />
              {anyUnlit ? (
                <Caveat>
                  {t(
                    "Algunas de estas horas no tenían sombras calculadas: ahí el veredicto no sabe cuándo atardece, y no cuentan para la consigna.",
                    "Some of these times had no computed shadows: there the verdict does not know when sunset is, and they do not count for the task.",
                  )}
                </Caveat>
              ) : null}
              <P>{t("Y en la ruta que tenés ahora:", "And on the route you have now:")}</P>
              <Facts
                rows={[
                  [t("Margen de luz", "Daylight margin"), marginPct(daylight)],
                  [t("Costo extra por sombra", "Extra cost from shadow"), shadowMin === null ? t("sin dato", "no data") : formatMinutes(shadowMin)],
                ]}
              />
              {daylight?.limit.assumptions?.length ? (
                <Caveat>{daylight.limit.assumptions.map((a) => trNow(a)).join(" ")}</Caveat>
              ) : null}
            </>
          );
        },
      },
    ],
  };

  const consumibles: Lesson = {
    id: "consumibles",
    icon: "🎒",
    title: t("El aire y la batería se acaban", "Air and battery run out"),
    tagline: t(
      "Todo lo que hacés afuera se paga en O₂ y en batería, aunque estés quieto.",
      "Everything you do outside is paid for in O₂ and battery, even when you stand still.",
    ),
    steps: [
      {
        kind: "info",
        title: t("La mochila es tu vida", "The backpack is your life"),
        say: t(
          "El traje lleva tu aire y tu batería. Cuando se acaban, se terminó la salida.",
          "The suit carries your air and your battery. When they run out, the EVA is over.",
        ),
        camera: { kind: "site" }, lockZoom: true,
        body: () =>
          t(
            <>
              <P>
                El traje lleva O₂ y batería limitados. Caminar en subida gasta más (con 0,38 g pesás menos,
                pero el traje igual pesa). Y quedarte quieto en una estación también gasta: la ventilación,
                la bomba y la radio no se apagan.
              </P>
              <P>
                La regla del planificador: tenés que volver con reserva. Si la reserva no alcanza, es NO-GO,
                no importa lo lindo que sea el destino.
              </P>
            </>,
            <>
              <P>
                The suit carries limited O₂ and battery. Walking uphill uses more (at 0.38 g you weigh less, but
                the suit still weighs). And standing still at a stop also uses them: the ventilation, the pump
                and the radio do not switch off.
              </P>
              <P>
                The planner's rule: you have to come back with a reserve. If the reserve is not enough, it is
                NO-GO, no matter how nice the destination is.
              </P>
            </>,
          ),
      },
      {
        kind: "task",
        title: t("Gastá la mitad", "Use up half"),
        preset: {
          site: "jezero",
          label: t(
            "Visita al aeródromo: de pile bay a Airfield S (después subí la permanencia)",
            "Airfield visit: from pile bay to Airfield S (then raise the time spent there)",
          ),
          expect: "terrain",
          habitat: "target-pile-bay",
          destination: "heli-airfield-s",
          dwellMin: 15,
        },
        say: t("Quedate un buen rato en una parada y mirá cómo baja tu reserva.", "Stay a good while at a stop and watch your reserve go down."),
        lockZoom: false, ui: [EDU_TARGET.SEARCH, EDU_TARGET.VERDICT],
        goal: t(
          "Armá una ruta donde al O₂ o a la batería les quede menos de la mitad del margen.",
          "Build a route where O₂ or battery is left with less than half of its margin.",
        ),
        focus: [EDU_TARGET.POINTS, EDU_TARGET.BREAKDOWN],
        body: () => (
          <P>
            {t(
              "Sumá una parada y subile la permanencia (por ejemplo 120 min), o andá más lejos. Mirá cuál se acaba primero.",
              "Add a stop and raise the time spent there (for example 120 min), or go farther. See which one runs out first.",
            )}
          </P>
        ),
        check: ({ route }) => {
          if (!route) return NO_ROUTE;
          const o2 = limitOf(route, "o2");
          const bat = limitOf(route, "battery");
          if (o2?.margin == null && bat?.margin == null) {
            return {
              done: false,
              blocked: true,
              hint: t("El planificador no pudo evaluar O₂ ni batería en esta ruta.", "The planner could not evaluate O₂ or battery on this route."),
            };
          }
          const lowest = Math.min(o2?.margin ?? 1, bat?.margin ?? 1);
          if (lowest < 0.5) return { done: true, hint: null };
          return {
            done: false,
            hint: t(
              `Te queda ${marginPct(o2)} de margen de O₂ y ${marginPct(bat)} de batería. Quedate más tiempo en una parada.`,
              `You have ${marginPct(o2)} O₂ margin and ${marginPct(bat)} battery left. Stay longer at a stop.`,
            ),
          };
        },
      },
      {
        kind: "info",
        title: t("Qué se acabó primero", "What ran out first"),
        say: t("Esto es lo que gastaste y lo que te queda.", "This is what you used and what you have left."),
        camera: { kind: "route" }, lockZoom: true,
        focus: [EDU_TARGET.BREAKDOWN],
        body: ({ route }) => {
          if (!route) return <NeedRoute />;
          const o2 = limitOf(route, "o2");
          const bat = limitOf(route, "battery");
          const first =
            o2?.margin != null && bat?.margin != null
              ? o2.margin <= bat.margin
                ? t("el O₂", "the O₂")
                : t("la batería", "the battery")
              : null;
          const total = totalMinutes(route);
          return (
            <>
              <Facts
                rows={[
                  [t("Duración de la EVA", "EVA duration"), total === null ? t("sin dato", "no data") : formatMinutes(total)],
                  [t("O₂ usado / disponible", "O₂ used / available"), `${measure(o2?.used, 3)} / ${measure(o2?.limit, 3)}`],
                  [t("Margen de O₂", "O₂ margin"), marginPct(o2)],
                  [t("Batería usada / disponible", "Battery used / available"), `${measure(bat?.used, 0)} / ${measure(bat?.limit, 0)}`],
                  [t("Margen de batería", "Battery margin"), marginPct(bat)],
                ]}
              />
              {first ? <P>{t(`En esta ruta se acaba primero ${first}.`, `On this route ${first} runs out first.`)}</P> : null}
              {o2?.limit.assumptions?.length ? <Caveat>{o2.limit.assumptions.map((a) => trNow(a)).join(" ")}</Caveat> : null}
              <Caveat>
                {t(
                  "Es un modelo (Pandolf ajustado a la gravedad de Marte, con los valores del traje EMU de la ISS), no una medición: el consumo real cambia con cada persona.",
                  "It is a model (Pandolf adjusted to Mars gravity, with the ISS EMU suit values), not a measurement: real consumption changes with each person.",
                )}
              </Caveat>
            </>
          );
        },
      },
    ],
  };

  const contacto: Lesson = {
    id: "contacto",
    icon: "📡",
    title: t("Perder de vista el hábitat", "Losing sight of the habitat"),
    tagline: t(
      "Sin GPS ni repetidoras, la radio va en línea recta: una loma te deja incomunicado.",
      "With no GPS or repeaters, radio travels in a straight line: a hill cuts you off.",
    ),
    steps: [
      {
        kind: "info",
        title: t("Por qué importa la línea de vista", "Why line of sight matters"),
        say: t(
          "La radio tiene que “ver” el hábitat. Si una loma se mete en el medio, te quedás sin señal.",
          "The radio has to “see” the habitat. If a hill gets in between, you lose the signal.",
        ),
        camera: { kind: "site" }, lockZoom: true, layers: ["relief-hillshade", "relief-contours"],
        body: () => (
          <P>
            {t(
              "En Marte no hay GPS ni antenas en el terreno. Si una loma queda entre vos y el hábitat, perdés la radio. El planificador cuenta los minutos seguidos sin línea de vista y evita, si puede, las celdas tapadas.",
              "On Mars there is no GPS and no antennas on the ground. If a hill stands between you and the habitat, you lose the radio. The planner counts the consecutive minutes without line of sight and avoids blocked cells when it can.",
            )}
          </P>
        ),
      },
      {
        kind: "task",
        title: t("Escondete", "Hide"),
        preset: {
          site: "jezero",
          label: t("Detrás de una loma: de Hozho a pal", "Behind a hill: from Hozho to pal"),
          expect: "contact",
          habitat: "target-hozho",
          destination: "target-pal",
          dwellMin: 15,
        },
        say: t("Llevá el destino detrás de una loma o adentro de un cráter.", "Put the destination behind a hill or inside a crater."),
        lockZoom: false, ui: [EDU_TARGET.POINTS, EDU_TARGET.VERDICT],
        goal: t(
          "Armá una ruta donde pases al menos un rato sin contacto con el hábitat.",
          "Build a route where you spend at least a while without contact with the habitat.",
        ),
        layers: ["relief-hillshade", "relief-contours"],
        focus: [EDU_TARGET.SEARCH, EDU_TARGET.BREAKDOWN],
        body: () => (
          <P>{t("Llevá el destino detrás de una loma o al fondo de un cráter.", "Put the destination behind a hill or at the bottom of a crater.")}</P>
        ),
        check: ({ route }) => {
          if (!route) return NO_ROUTE;
          const c = limitOf(route, "contact");
          if (!c || c.status === "not_evaluated") {
            return {
              done: false,
              blocked: true,
              hint: t(
                "Sin el DTM no se puede calcular la línea de vista en esta ruta: probá adentro del terreno de 1 m.",
                "Without the DTM the line of sight cannot be calculated on this route: try inside the 1 m terrain.",
              ),
            };
          }
          const used = val(c.used);
          if (used !== null && used > 0) return { done: true, hint: null };
          return {
            done: false,
            hint: t(
              "Toda la ruta tiene vista al hábitat. Andá más lejos o detrás de un relieve.",
              "The whole route can see the habitat. Go farther or behind some relief.",
            ),
          };
        },
      },
      {
        kind: "info",
        title: t("Cuánto estuviste solo", "How long you were alone"),
        say: t("Este es el rato más largo que estuviste sin poder hablar con nadie.", "This is the longest stretch you spent unable to talk to anyone."),
        camera: { kind: "route" }, lockZoom: true, ui: [EDU_TARGET.PROFILE],
        focus: [EDU_TARGET.BREAKDOWN],
        body: ({ route }) => {
          if (!route) return <NeedRoute />;
          const c = limitOf(route, "contact");
          const min = costMinutes(route, "contact");
          return (
            <>
              <Facts
                rows={[
                  [t("Racha más larga sin contacto", "Longest stretch without contact"), measure(c?.used)],
                  [t("Límite", "Limit"), measure(c?.limit)],
                  [t("Margen", "Margin"), marginPct(c)],
                  [t("Costo extra por ir tapado", "Extra cost from going out of sight"), min === null ? t("sin dato", "no data") : formatMinutes(min)],
                ]}
              />
              {c?.note ? <Caveat>{trNow(c.note)}</Caveat> : null}
              {c?.used.assumptions?.length ? (
                <Caveat>
                  {t("Supuestos", "Assumptions")}: {c.used.assumptions.map((a) => trNow(a)).join(" · ")}
                </Caveat>
              ) : null}
            </>
          );
        },
      },
    ],
  };

  const dosis: Lesson = {
    id: "dosis",
    icon: "☢️",
    title: t("La radiación se acumula", "Radiation adds up"),
    tagline: t("No la sentís y no te frena hoy: se suma EVA tras EVA.", "You do not feel it and it does not stop you today: it adds up EVA after EVA."),
    steps: [
      {
        kind: "info",
        title: t("Un presupuesto, no una zona", "A budget, not a zone"),
        say: t(
          "Afuera hay radiación. No la sentís, pero se suma cada vez que salís.",
          "There is radiation outside. You do not feel it, but it adds up every time you go out.",
        ),
        camera: { kind: "site" }, lockZoom: true, ui: [EDU_TARGET.LAYERS], layers: ["relief-hillshade", "survival-dose"],
        body: () =>
          t(
            <>
              <P>
                Marte casi no tiene campo magnético y su atmósfera es muy fina: en la superficie llega mucha
                más radiación que en la Tierra. El rover Curiosity la midió con su instrumento RAD.
              </P>
              <P>
                En el terreno varía menos que la incertidumbre de la medición, así que no hay una zona
                “segura” a la que ir: se maneja como un presupuesto por EVA (docs/radiation.md).
              </P>
            </>,
            <>
              <P>
                Mars has almost no magnetic field and its atmosphere is very thin: much more radiation reaches
                the surface than on Earth. The Curiosity rover measured it with its RAD instrument.
              </P>
              <P>
                Across the terrain it varies less than the measurement uncertainty, so there is no “safe” zone to
                go to: it is managed as a budget per EVA (docs/radiation.md).
              </P>
            </>,
          ),
      },
      {
        kind: "task",
        title: t("Medí tu dosis", "Measure your dose"),
        say: t("Armá una ruta y mirá cuánta radiación juntás.", "Build a route and see how much radiation you collect."),
        lockZoom: false, ui: [EDU_TARGET.SEARCH, EDU_TARGET.POINTS],
        goal: t("Armá una ruta con la dosis evaluada.", "Build a route with the dose evaluated."),
        focus: [EDU_TARGET.BREAKDOWN],
        body: () => (
          <P>
            {t(
              "Cualquier ruta sirve. Si querés, sumá una parada larga y mirá cómo crece.",
              "Any route works. If you want, add a long stop and watch it grow.",
            )}
          </P>
        ),
        check: ({ route }) => {
          if (!route) return NO_ROUTE;
          const d = limitOf(route, "dose");
          if (val(d?.used) !== null) return { done: true, hint: null };
          return {
            done: false,
            blocked: true,
            hint: t(
              "El planificador no pudo calcular la dosis de esta ruta (falta la tasa de base).",
              "The planner could not calculate the dose for this route (the baseline rate is missing).",
            ),
          };
        },
      },
      {
        kind: "info",
        title: t("Cuánto juntaste", "How much you collected"),
        say: t(
          "Esto es lo que juntaste en esta salida, comparado con el tope por salida.",
          "This is what you collected on this EVA, compared with the per-EVA cap.",
        ),
        camera: { kind: "route" }, lockZoom: true, ui: [EDU_TARGET.VERDICT],
        focus: [EDU_TARGET.BREAKDOWN],
        body: ({ route }) => {
          if (!route) return <NeedRoute />;
          const d = limitOf(route, "dose");
          const used = val(d?.used);
          const limit = val(d?.limit);
          const total = totalMinutes(route);
          const rate = used !== null && total ? (used / total) * 60 : null;
          return (
            <>
              <Facts
                rows={[
                  [t("Dosis de esta EVA", "Dose of this EVA"), measure(d?.used, 3)],
                  [t("Tope por EVA", "Per-EVA cap"), measure(d?.limit, 3)],
                  [t("Usaste del tope", "Cap used"), used !== null && limit ? `${num((used / limit) * 100, 1)} %` : t("sin dato", "no data")],
                  [t("Tasa (dosis ÷ duración)", "Rate (dose ÷ duration)"), rate === null ? t("sin dato", "no data") : `${num(rate, 4)} ${d?.used.unit ?? ""}/h`],
                ]}
              />
              <P>
                {t(
                  "La dosis crece con el tiempo afuera, no con el lugar. Por eso no cambia por dónde vas: cambia cuánto te podés quedar.",
                  "The dose grows with time outside, not with the place. That is why it does not change with where you go: it changes how long you can stay.",
                )}
              </P>
              <Caveat>
                {t(
                  "El planificador mira una sola salida. En una misión real la dosis se suma salida tras salida, pero ese total no lo calcula: no hay un tope de misión con fuente.",
                  "The planner looks at a single EVA. On a real mission the dose adds up EVA after EVA, but it does not calculate that total: there is no sourced mission cap.",
                )}
              </Caveat>
              {d?.used.source ? (
                <Caveat>
                  {t("Fuente de la tasa", "Source of the rate")}: {trNow(d.used.source)}.
                </Caveat>
              ) : null}
              {d?.limit.provenance === "ASSUMED" ? (
                <Caveat>
                  {t(
                    "El presupuesto por EVA lo eligió el equipo y todavía no tiene fuente citable.",
                    "The per-EVA budget was chosen by the team and has no citable source yet.",
                  )}
                </Caveat>
              ) : null}
            </>
          );
        },
      },
    ],
  };

  const robustez: Lesson = {
    id: "robustez",
    icon: "🛡️",
    title: t("Los planes fallan", "Plans fail"),
    tagline: t(
      "Una ruta buena aguanta salir tarde, caminar lento o cargar de más.",
      "A good route survives leaving late, walking slowly or carrying too much.",
    ),
    steps: [
      {
        kind: "info",
        title: t("El plan B ya tiene que estar en el plan A", "Plan B has to be part of plan A"),
        say: t(
          "Afuera siempre algo cambia: salís tarde, caminás más lento. Una buena ruta lo aguanta.",
          "Outside something always changes: you leave late, you walk slower. A good route survives it.",
        ),
        camera: { kind: "site" }, lockZoom: true,
        body: () => (
          <P>
            {t(
              "Afuera las cosas se demoran. El planificador toma tu misma ruta y la recalcula en peores condiciones: salir más tarde, caminar más lento, llevar más carga. No es una probabilidad: cuenta en cuántos de esos escenarios seguís bien.",
              "Outside, things get delayed. The planner takes your same route and recalculates it under worse conditions: leaving later, walking slower, carrying more load. It is not a probability: it counts in how many of those scenarios you are still fine.",
            )}
          </P>
        ),
      },
      {
        kind: "predict",
        anchor: EDU_TARGET.VERDICT,
        title: t("Antes de mirar", "Before looking"),
        say: t("Adiviná qué es lo que más limita tu ruta, antes de ver la respuesta.", "Guess what limits your route the most, before seeing the answer."),
        lockZoom: false, ui: [EDU_TARGET.SEARCH, EDU_TARGET.POINTS],
        question: t(
          "Armá una ruta. Sin ver el veredicto: ¿qué es lo que más la limita?",
          "Build a route. Without seeing the verdict: what limits it the most?",
        ),
        hide: [EDU_TARGET.VERDICT, EDU_TARGET.BREAKDOWN],
        body: () => <P>{t("El veredicto queda tapado hasta que elijas.", "The verdict stays hidden until you choose.")}</P>,
        reveal: revealFactor,
      },
      {
        kind: "task",
        title: t("Hacela robusta", "Make it robust"),
        timeSlider: true,
        say: t(
          "Ajustá la ruta hasta que aguante todos los imprevistos que se pueden calcular.",
          "Adjust the route until it survives every setback that can be calculated.",
        ),
        lockZoom: false, ui: [EDU_TARGET.VERDICT],
        goal: t(
          "Conseguí una ruta que no sea NO-GO y que aguante todos los escenarios que se pueden evaluar.",
          "Get a route that is not NO-GO and survives every scenario that can be evaluated.",
        ),
        focus: [EDU_TARGET.BREAKDOWN, EDU_TARGET.DEPART],
        body: () => <P>{t("Si falla, acortala, salí más temprano o sacá paradas.", "If it fails, shorten it, leave earlier or remove stops.")}</P>,
        check: ({ route }) => {
          if (!route) return NO_ROUTE;
          const rob = route.verdict.robustness;
          if (!rob || rob.evaluated === 0) {
            return {
              done: false,
              blocked: true,
              hint: t("El planificador no pudo evaluar escenarios de estrés en esta ruta.", "The planner could not evaluate stress scenarios on this route."),
            };
          }
          if (route.verdict.status === "NO_GO") {
            return {
              done: false,
              hint: t(
                "Así como está es NO-GO, aun sin imprevistos. Arreglá primero eso: el veredicto dice qué la limita.",
                "As it is, it is NO-GO even without setbacks. Fix that first: the verdict says what limits it.",
              ),
            };
          }
          const failing = rob.scenarios.filter((s) => s.status === "fail");
          if (failing.length === 0) return { done: true, hint: null };
          return {
            done: false,
            hint: `${t("Falla en", "Fails in")}: ${failing.map((s) => trNow(s.label).toLowerCase()).join(", ")}.`,
          };
        },
      },
      {
        kind: "info",
        title: t("Cómo quedó", "How it turned out"),
        say: t("Así aguanta tu ruta los imprevistos.", "This is how your route survives setbacks."),
        camera: { kind: "route" }, lockZoom: true,
        focus: [EDU_TARGET.BREAKDOWN],
        body: (ctx) => {
          if (!ctx.route?.verdict.robustness) return <NeedRoute />;
          const rob = ctx.route.verdict.robustness;
          const hadFails = ctx.attempts.some((a) => a.passed !== null && a.evaluated !== null && a.passed < a.evaluated);
          return (
            <>
              <Facts
                rows={rob.scenarios.map(
                  (s) =>
                    [
                      trNow(s.label),
                      s.status === "pass"
                        ? t("✓ aguanta", "✓ holds")
                        : s.status === "fail"
                          ? t("✕ falla", "✕ fails")
                          : t("sin evaluar", "not evaluated"),
                    ] as const,
                )}
              />
              <P>
                {hadFails
                  ? t("Arrancaste con una ruta que fallaba en algún escenario y la corregiste.", "You started with a route that failed in some scenario and you fixed it.")
                  : t("Tu ruta aguantó desde el principio. Probá salir más tarde para ver cómo se rompe.", "Your route held from the start. Try leaving later to see how it breaks.")}
              </P>
              {rob.scenarios.some((s) => s.status === "not_evaluated") ? (
                <Caveat>
                  {t(
                    "Los escenarios “sin evaluar” no se cuentan: el modelo no los puede calcular (lección siguiente).",
                    "“Not evaluated” scenarios are not counted: the model cannot calculate them (next lesson).",
                  )}
                </Caveat>
              ) : null}
            </>
          );
        },
      },
    ],
  };

  const incertezas: Lesson = {
    id: "incertezas",
    icon: "❓",
    title: t("Lo que no sabemos", "What we don't know"),
    tagline: t("Saber qué no calcula el planificador es parte de usarlo bien.", "Knowing what the planner doesn't compute is part of using it well."),
    steps: [
      {
        kind: "task",
        title: t("Armá una ruta", "Build a route"),
        say: t("Armá una ruta y vamos a mirar lo que el planificador no sabe.", "Build a route and let's look at what the planner doesn't know."),
        camera: { kind: "site" }, lockZoom: false, ui: [EDU_TARGET.SEARCH],
        goal: t("Cualquier ruta: vamos a leer lo que el planificador admite que no sabe.", "Any route: we'll read what the planner admits it doesn't know."),
        focus: [EDU_TARGET.POINTS],
        body: () => <P>{t("Este planificador es un prototipo educativo, no software de vuelo. Veamos dónde están sus bordes.", "This planner is an educational prototype, not flight software. Let's see where its edges are.")}</P>,
        check: hasRoute,
      },
      {
        kind: "info",
        title: t("Lo que el planificador te dice que no sabe", "What the planner tells you it doesn't know"),
        say: t("Un buen explorador sabe lo que no sabe. Esto es lo que el planificador no puede calcular.", "A good explorer knows what they don't know. This is what the planner can't compute."),
        camera: { kind: "route" }, lockZoom: true, ui: [EDU_TARGET.VERDICT],
        focus: [EDU_TARGET.BREAKDOWN],
        body: ({ route }) => {
          if (!route) return <NeedRoute />;
          const notEvaluated = route.verdict.robustness?.scenarios.filter((s) => s.status === "not_evaluated") ?? [];
          const inactive = route.cost?.factors.filter((f) => !f.active) ?? [];
          const openLimits = route.verdict.limits?.filter((l) => l.status === "not_evaluated" || l.status === "undefined") ?? [];
          const assumed = assumedLimits(route);
          return (
            <>
              {notEvaluated.length > 0 ? (
                <>
                  <P><strong>{t("Escenarios que no se pueden calcular:", "Scenarios that can't be computed:")}</strong></P>
                  <List items={notEvaluated.map((s) => <>{trNow(s.label)}{s.note ? `: ${trNow(s.note)}` : ""}</>)} />
                </>
              ) : null}
              {inactive.length > 0 ? (
                <>
                  <P><strong>{t("Peligros que el camino todavía no esquiva:", "Hazards the path doesn't avoid yet:")}</strong></P>
                  <List items={inactive.map((f) => <>{trNow(f.label)}{f.note ? `: ${trNow(f.note)}` : ""}</>)} />
                </>
              ) : null}
              {openLimits.length > 0 ? (
                <>
                  <P><strong>{t("Límites sin evaluar o sin definir:", "Limits not evaluated or not defined:")}</strong></P>
                  <List items={openLimits.map((l) => <>{trNow(l.label)}{l.note ? `: ${trNow(l.note)}` : ""}</>)} />
                </>
              ) : null}
              {assumed.length > 0 ? (
                <>
                  <P><strong>{t("Límites que eligió el equipo, sin fuente citable todavía:", "Limits the team chose, with no citable source yet:")}</strong></P>
                  <List items={assumed.map((l) => <>{trNow(l.label)}: {measure(l.limit)}</>)} />
                </>
              ) : null}
              <Caveat>
                {t(
                  "Un GO acá quiere decir “ninguno de los límites que sabemos calcular se rompe”. No quiere decir “es seguro”.",
                  "A GO here means “none of the limits we know how to compute is broken”. It doesn't mean “it's safe”.",
                )}
              </Caveat>
            </>
          );
        },
      },
    ],
  };

  const mision: Lesson = {
    id: "mision",
    requires: ["places"],
    keepsRoute: true,
    icon: "🚀",
    title: t("Misión final", "Final mission"),
    tagline: t("Una EVA completa a un lugar real, con todo lo que aprendiste.", "A full EVA to a real place, with everything you've learned."),
    steps: [
      {
        kind: "task",
        title: t("Elegí el objetivo", "Pick the target"),
        say: t("Tu misión: llegar a un lugar real del sitio. Marcá tu base y buscá el destino.", "Your mission: reach a real place at the site. Mark your base and search for the destination."),
        camera: { kind: "site" }, lockZoom: false, pins: true, layers: ["relief-hillshade", "relief-slope"],
        goal: t("Elegí como destino un lugar con nombre: un depósito de muestras o un objetivo científico si el sitio los tiene.", "Pick a named place as the destination: a sample depot or a science target if the site has them."),
        hide: [EDU_TARGET.VERDICT, EDU_TARGET.BREAKDOWN],
        focus: [EDU_TARGET.SEARCH],
        body: () => (
          <P>
            {t(
              "Marcá el hábitat y buscá el destino entre los lugares del sitio (tubos de muestra o objetivos que midió el rover). El veredicto queda tapado por ahora.",
              "Mark the habitat and search for the destination among the site's places (sample tubes or targets the rover measured). The verdict stays hidden for now.",
            )}
          </P>
        ),
        check: ({ places, waypoints, route }) => {
          if (!places || places.places.length === 0) {
            return { done: false, blocked: true, hint: t("Este sitio todavía no tiene lugares cargados (places.json).", "This site has no places loaded yet (places.json).") };
          }
          if (waypoints.length === 0) {
            return {
              done: false,
              hint: t("Primero marcá tu base: un clic en un lugar vacío del mapa, o «Poner el hábitat acá» en la ficha de un pin.", "First mark your base: click an empty spot on the map, or “Put the habitat here” on a pin's card."),
            };
          }
          // Si el sitio todavía no tiene muestras ni objetivos, vale cualquier lugar con nombre.
          const science = places.places.some((p) => p.kind === "sample" || p.kind === "target");
          const dest = waypoints.length >= 2 ? waypoints.at(-1) : undefined;
          const place = dest?.placeId ? places.places.find((p) => p.id === dest.placeId) : undefined;
          if (!place) {
            return { done: false, hint: t("Elegí el destino con el buscador o con un lugar sugerido, no con un clic suelto.", "Pick the destination with the search box or a suggested place, not with a loose click.") };
          }
          if (science && place.kind !== "sample" && place.kind !== "target") {
            return { done: false, hint: t("Este sitio tiene muestras u objetivos científicos: elegí uno de esos.", "This site has samples or science targets: pick one of those.") };
          }
          if (!route) return { done: false, hint: t("Esperando al planificador…", "Waiting for the planner…") };
          return {
            done: true,
            hint: science ? null : t("Este sitio todavía no tiene muestras ni objetivos cargados: vale cualquier lugar con nombre.", "This site has no samples or targets loaded yet: any named place counts."),
          };
        },
      },
      {
        kind: "predict",
        anchor: EDU_TARGET.VERDICT,
        title: t("Predecí", "Predict"),
        say: t("Antes de ver la respuesta: ¿qué va a limitar tu salida?", "Before seeing the answer: what will limit your outing?"),
        camera: { kind: "route" }, lockZoom: true,
        question: t("¿Qué va a limitar esta EVA?", "What will limit this EVA?"),
        hide: [EDU_TARGET.VERDICT, EDU_TARGET.BREAKDOWN],
        body: () => null,
        reveal: revealFactor,
      },
      {
        kind: "task",
        title: t("GO y robusta", "GO and robust"),
        timeSlider: true,
        say: t("Dejala en GO y que aguante todos los imprevistos. Podés cambiar la hora, sumar paradas o acortarla.", "Get it to GO and make it survive every contingency. You can change the time, add stops or shorten it."),
        lockZoom: false, ui: [EDU_TARGET.SUN, EDU_TARGET.PROFILE, EDU_TARGET.LAYERS],
        goal: t("Dejala en GO y que aguante todos los escenarios evaluables, sin cambiar el destino.", "Get it to GO and passing every evaluable scenario, without changing the destination."),
        focus: [EDU_TARGET.VERDICT, EDU_TARGET.DEPART, EDU_TARGET.POINTS],
        body: () => <P>{t("Usá todo: la hora de salida, paradas intermedias, el tiempo en cada estación.", "Use everything: departure time, intermediate stops, time at each station.")}</P>,
        check: ({ route }) => {
          if (!route) return NO_ROUTE;
          const v = route.verdict;
          // Un límite que no se pudo evaluar del todo fuerza CAUTION (api/safety.py): con
          // esos datos el GO es imposible y la consigna no se puede cumplir.
          const incomplete = (v.limits ?? []).filter(
            (l) => l.status !== "undefined" && (l.status === "not_evaluated" || !l.complete),
          );
          if (v.status === "CAUTION" && incomplete.length > 0) {
            return {
              done: false,
              blocked: true,
              hint: t(
                `Con los datos de hoy esta ruta no puede dar GO: no se pudo evaluar del todo ${incomplete
                  .map((l) => l.label.toLowerCase())
                  .join(", ")}. Probá otra hora o fecha.`,
                `With today's data this route can't reach GO: couldn't fully evaluate ${incomplete
                  .map((l) => trNow(l.label).toLowerCase())
                  .join(", ")}. Try another time or date.`,
              ),
            };
          }
          if (v.status !== "GO") {
            const word = v.status === "NO_GO" ? "NO-GO" : "CAUTION";
            return {
              done: false,
              hint: t(
                `Está en ${word}${v.limiting_factor ? `; limita ${FACTOR_LABEL[v.limiting_factor].toLowerCase()}` : ""}.`,
                `It's ${word}${v.limiting_factor ? `; limited by ${trNow(FACTOR_LABEL[v.limiting_factor]).toLowerCase()}` : ""}.`,
              ),
            };
          }
          const rob = v.robustness;
          if (rob && rob.evaluated > 0 && rob.passed < rob.evaluated) {
            return { done: false, hint: t(`GO, pero aguanta ${rob.passed} de ${rob.evaluated} escenarios.`, `GO, but it survives ${rob.passed} of ${rob.evaluated} scenarios.`) };
          }
          return { done: true, hint: null };
        },
      },
      {
        kind: "info",
        title: t("Lista para salir", "Ready to go"),
        say: t("¡Lista para salir! Imprimí la tira para la muñeca.", "Ready to go! Print the wrist cuff."),
        camera: { kind: "route" }, lockZoom: true, ui: [EDU_TARGET.SHARE],
        focus: [EDU_TARGET.VERDICT],
        body: ({ route }) => {
          if (!route) return <NeedRoute />;
          const v = route.verdict;
          const total = totalMinutes(route);
          return (
            <>
              <Facts
                rows={[
                  [t("Puntaje", "Score"), measure(v.score, 0)],
                  [t("Limita", "Limited by"), v.limiting_factor ? trNow(FACTOR_LABEL[v.limiting_factor]) : "—"],
                  [t("Duración", "Duration"), total === null ? t("sin dato", "no data") : formatMinutes(total)],
                  [t("Robustez", "Robustness"), v.robustness ? t(`${v.robustness.passed} de ${v.robustness.evaluated}`, `${v.robustness.passed} of ${v.robustness.evaluated}`) : t("sin dato", "no data")],
                ]}
              />
              <P>{t("Imprimí la tira para la muñeca con el botón “Imprimir tira” y compartí la travesía con el enlace.", "Print the wrist cuff with the “Print cuff checklist” button and share the traverse with the link.")}</P>
              <Caveat>{t("Prototipo educativo, no software de vuelo.", "Educational prototype, not flight software.")}</Caveat>
            </>
          );
        },
      },
    ],
  };

  return [datos, pendiente, reloj, consumibles, contacto, dosis, robustez, incertezas, mision];
}

const cache = new Map<Lang, readonly Lesson[]>();

/** Las lecciones en el idioma elegido. Quien las muestra tiene que depender del idioma (useT). */
export function getLessons(): readonly Lesson[] {
  const lang = useLang.getState().lang;
  let ls = cache.get(lang);
  if (!ls) {
    ls = build(lang === "en" ? (_es, en) => en : (es) => es);
    cache.set(lang, ls);
  }
  return ls;
}


export const lessonById = (id: string | null): Lesson | null => getLessons().find((l) => l.id === id) ?? null;
