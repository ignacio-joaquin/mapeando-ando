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
import type { Attempt, Prediction } from "../state/edu";
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

/** Piezas de la interfaz que una lección puede señalar u ocultar (atributo data-edu). */
export const EDU_TARGET = {
  VERDICT: "verdict",
  BREAKDOWN: "breakdown",
  DEPART: "depart",
  SUN: "sun-timeline",
  LAYERS: "layers",
  POINTS: "points",
  SEARCH: "search",
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
  readonly body: (ctx: LessonContext) => ReactNode;
  /** Se resaltan en la interfaz mientras dura el paso. */
  readonly focus?: readonly EduTarget[];
  /** Se tapan mientras dura el paso (para predecir sin ver la respuesta). */
  readonly hide?: readonly EduTarget[];
  /** Capas del mapa que se prenden al entrar al paso, si están disponibles. */
  readonly layers?: readonly string[];
}

export interface InfoStep extends StepBase {
  readonly kind: "info";
}

export interface TaskStep extends StepBase {
  readonly kind: "task";
  /** La consigna, en una línea. */
  readonly goal: string;
  readonly check: (ctx: LessonContext) => CheckResult;
}

export interface PredictStep extends StepBase {
  readonly kind: "predict";
  readonly question: string;
  readonly reveal: (ctx: LessonContext, prediction: Prediction) => ReactNode;
}

export type LessonStep = InfoStep | TaskStep | PredictStep;

export interface Lesson {
  readonly id: string;
  readonly title: string;
  /** La dificultad, en una frase. */
  readonly tagline: string;
  readonly steps: readonly LessonStep[];
}

/** Factores que el alumno puede elegir al predecir. Calorías no: no tiene tope todavía. */
export const PREDICTABLE: readonly LimitingFactor[] = ["terrain", "o2", "battery", "daylight", "contact", "dose"];

// ------------------------------------------------------------------ chequeos comunes

const NO_ROUTE: CheckResult = {
  done: false,
  hint: "Armá una ruta: marcá el hábitat con un clic y elegí un destino.",
};

const hasRoute = (ctx: LessonContext): CheckResult => (ctx.route ? { done: true, hint: null } : NO_ROUTE);

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

function revealFactor(route: RouteResponse | null, prediction: Prediction): ReactNode {
  if (!route) return <NeedRoute />;
  const real = route.verdict.limiting_factor;
  if (!real) {
    return <P>El planificador no pudo nombrar un factor limitante: ningún límite se pudo evaluar del todo.</P>;
  }
  const hit = real === prediction;
  const l = limitOf(route, real);
  return (
    <div className="flex flex-col gap-2">
      <P>
        {hit ? <strong className="text-ok">✓ Acertaste. </strong> : <strong className="text-warn">✕ No. </strong>}
        Dijiste <strong>{prediction === "none" ? "nada" : FACTOR_LABEL[prediction]}</strong>; el
        margen más chico es el de <strong>{FACTOR_LABEL[real]}</strong>
        {l ? <> ({marginPct(l)} de margen)</> : null}.
      </P>
      <P>
        El puntaje de la ruta es ese margen: la cadena se corta por el eslabón más débil, no por el
        promedio.
      </P>
    </div>
  );
}

// ------------------------------------------------------------------ lecciones

const datos: Lesson = {
  id: "datos",
  title: "Desconfiá de un número sin fuente",
  tagline: "En Marte no hay segunda opinión: tenés que saber de dónde sale cada dato.",
  steps: [
    {
      kind: "info",
      title: "Cuatro tipos de dato",
      body: () => (
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
        </>
      ),
    },
    {
      kind: "task",
      title: "Armá una ruta cualquiera",
      goal: "Marcá el hábitat y elegí un destino.",
      focus: [EDU_TARGET.POINTS, EDU_TARGET.SEARCH],
      body: () => <P>Cualquier destino sirve. Vamos a mirar de qué está hecha la respuesta.</P>,
      check: hasRoute,
    },
    {
      kind: "info",
      title: "De qué está hecha tu ruta",
      focus: [EDU_TARGET.BREAKDOWN],
      body: ({ route }) => {
        if (!route) return <NeedRoute />;
        const c = countProvenance(route, { OBSERVED: 0, DERIVED: 0, MODELED: 0, ASSUMED: 0 });
        const unknown = route.legs.filter((l) => l.class === "unknown").length;
        const assumed = assumedLimits(route);
        return (
          <>
            <P>Contando todos los valores de la respuesta del planificador:</P>
            <Facts
              rows={(Object.keys(c) as Provenance[]).map((p) => [PROVENANCE_LABEL[p], String(c[p])] as const)}
            />
            {unknown > 0 ? (
              <Caveat>
                {unknown} {unknown === 1 ? "tramo va" : "tramos van"} punteado: ahí no hay terreno de 1 m y el
                planificador no lo pudo evaluar. Punteado no quiere decir seguro.
              </Caveat>
            ) : null}
            {assumed.length > 0 ? (
              <Caveat>
                Límites que eligió el equipo sin fuente citable:{" "}
                {assumed.map((l) => `${l.label} (${measure(l.limit)})`).join(", ")}. Abrí “Límites duros” y
                tocá el badge de cada uno.
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
  title: "No se puede caminar por cualquier lado",
  tagline: "La línea recta casi nunca es el camino: la pendiente decide por dónde vas.",
  steps: [
    {
      kind: "info",
      title: "Por qué la pendiente manda",
      layers: ["relief-slope"],
      focus: [EDU_TARGET.LAYERS],
      body: () => (
        <>
          <P>
            Con un traje de más de 100 kg, en regolito suelto y con la vista recortada por el casco,
            una ladera empinada es una caída posible y un consumo de O₂ que se dispara.
          </P>
          <P>
            Prendí la capa de pendiente: lo que la leyenda marca “no transitable” es lo que el planificador no pisa. Ese corte es el
            mismo en el mapa y en el cálculo de la ruta.
          </P>
        </>
      ),
    },
    {
      kind: "task",
      title: "Forzá un desvío",
      goal: "Elegí un destino al que no se pueda ir en línea recta.",
      layers: ["relief-slope"],
      focus: [EDU_TARGET.SEARCH, EDU_TARGET.POINTS],
      body: () => (
        <P>
          Buscá un destino del otro lado de una zona naranja o roja de la capa de pendiente (el borde
          de un cráter, una loma) y mirá cómo dobla la ruta.
        </P>
      ),
      check: ({ route }) => {
        if (!route) return NO_ROUTE;
        const d = walkedVsStraight(route);
        const steep = route.legs.some((l) => l.class === "caution" || l.class === "limit" || l.class === "blocked");
        if (!d) return { done: steep, hint: steep ? null : "Esta ruta tiene tramos sin distancia: probá otro destino." };
        const extra = d.walked / d.straight - 1;
        if (extra >= 0.15 || steep) return { done: true, hint: null };
        return {
          done: false,
          hint: `Tu ruta camina un ${num(extra * 100, 0)} % más que la línea recta: casi no se desvía. Buscá un destino detrás de algo empinado.`,
        };
      },
    },
    {
      kind: "info",
      title: "Lo que te costó",
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
                ["Línea recta", d ? formatDistanceM(d.straight) : "sin dato"],
                ["Caminado", d ? formatDistanceM(d.walked) : "sin dato"],
                ["Desvío", d ? `+${num((d.walked / d.straight - 1) * 100, 0)} %` : "sin dato"],
                ["Pendiente más fuerte que pisás", `${num(maxSlope(route), 1)}°`],
                ["Límite de pendiente", measure(terrain?.limit)],
                ["Costo extra por pendiente", slopeMin === null ? "sin dato" : formatMinutes(slopeMin)],
              ]}
            />
            <P>
              El planificador no busca la ruta más corta: busca la de menor costo, y una celda empinada
              cuesta más que su tiempo de caminata. Por eso a veces conviene dar la vuelta aunque se pueda
              pasar.
            </P>
            <Caveat>
              El límite de pendiente es un supuesto del equipo. Y el modelo de consumo (Pandolf) se validó
              en pendientes mucho más suaves que ese límite (docs/seguridad.md): en lo empinado, el consumo
              es una extrapolación.
            </Caveat>
          </>
        );
      },
    },
  ],
};

const reloj: Lesson = {
  id: "reloj",
  title: "El mapa cambia con la hora",
  tagline: "La misma ruta puede ser segura a la mañana y peligrosa a la tarde.",
  steps: [
    {
      kind: "info",
      title: "Planificar en 4D",
      focus: [EDU_TARGET.SUN],
      body: () => (
        <>
          <P>
            Un sol dura 24 h 39 min. Las sombras de los cráteres se mueven con el sol, y en la sombra hace
            más frío y el traje trabaja más. Además, tenés que estar de vuelta antes de que oscurezca.
          </P>
          <P>
            Por eso el planificador mira a qué hora pasás por cada celda: no es un mapa fijo, es un mapa
            que cambia mientras caminás.
          </P>
        </>
      ),
    },
    {
      kind: "task",
      title: "Hacé que la hora cambie el veredicto",
      goal: "Con los mismos puntos, encontrá dos horas de salida con veredictos distintos.",
      focus: [EDU_TARGET.DEPART, EDU_TARGET.SUN],
      body: () => (
        <P>
          Armá una ruta y movete solo con la hora de salida. Probá salir cerca del atardecer, o una ruta
          larga con una parada de una hora.
        </P>
      ),
      check: (ctx) => {
        if (!ctx.route) return NO_ROUTE;
        const daylight = limitOf(ctx.route, "daylight");
        const same = sameGeometry(ctx.attempts);
        const statuses = new Set(same.map((a) => a.status));
        if (statuses.size >= 2) return { done: true, hint: null };
        if (daylight?.status === "not_evaluated") {
          return {
            done: false,
            blocked: true,
            hint:
              "Para esta fecha el server no tiene sombras calculadas: el planificador no sabe cuándo atardece, " +
              "y sin eso la hora no cambia el veredicto. Si la línea de sol de abajo del mapa muestra algún sol, " +
              "probá una fecha de ese sol.",
          };
        }
        const only = same[0];
        return {
          done: false,
          hint:
            same.length <= 1
              ? "Ahora cambiá la hora de salida sin tocar los puntos."
              : `Probaste ${same.length} horas con estos puntos y todas dieron ${only ? STATUS_WORD[only.status] : "lo mismo"}. Acercate al atardecer, o alargá la ruta.`,
        };
      },
    },
    {
      kind: "info",
      title: "Lo que cambió",
      focus: [EDU_TARGET.BREAKDOWN],
      body: (ctx) => {
        if (!ctx.route) return <NeedRoute />;
        const origin = ctx.waypoints[0];
        const same = [...sameGeometry(ctx.attempts)].sort((a, b) => a.departMs - b.departMs);
        const daylight = limitOf(ctx.route, "daylight");
        const shadowMin = costMinutes(ctx.route, "shadow");
        return (
          <>
            <P>Tus salidas con los mismos puntos:</P>
            <Facts
              rows={same.map(
                (a) =>
                  [
                    origin ? `${ltstShort(new Date(a.departMs), origin.lon)} LTST` : new Date(a.departMs).toISOString(),
                    `${STATUS_WORD[a.status]}${a.limiting ? ` · ${FACTOR_LABEL[a.limiting]}` : ""}`,
                  ] as const,
              )}
            />
            <P>Y en la ruta que tenés ahora:</P>
            <Facts
              rows={[
                ["Margen de luz", marginPct(daylight)],
                ["Costo extra por sombra", shadowMin === null ? "sin dato" : formatMinutes(shadowMin)],
              ]}
            />
            {daylight?.limit.assumptions?.length ? <Caveat>{daylight.limit.assumptions.join(" ")}</Caveat> : null}
          </>
        );
      },
    },
  ],
};

const consumibles: Lesson = {
  id: "consumibles",
  title: "El aire y la batería se acaban",
  tagline: "Todo lo que hacés afuera se paga en O₂ y en batería, aunque estés quieto.",
  steps: [
    {
      kind: "info",
      title: "La mochila es tu vida",
      body: () => (
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
        </>
      ),
    },
    {
      kind: "task",
      title: "Gastá la mitad",
      goal: "Armá una ruta donde al O₂ o a la batería les quede menos de la mitad del margen.",
      focus: [EDU_TARGET.POINTS, EDU_TARGET.BREAKDOWN],
      body: () => (
        <P>
          Sumá una parada y subile la permanencia (por ejemplo 120 min), o andá más lejos. Mirá cuál se
          acaba primero.
        </P>
      ),
      check: ({ route }) => {
        if (!route) return NO_ROUTE;
        const o2 = limitOf(route, "o2");
        const bat = limitOf(route, "battery");
        if (o2?.margin == null && bat?.margin == null) {
          return { done: false, blocked: true, hint: "El planificador no pudo evaluar O₂ ni batería en esta ruta." };
        }
        const lowest = Math.min(o2?.margin ?? 1, bat?.margin ?? 1);
        if (lowest < 0.5) return { done: true, hint: null };
        return {
          done: false,
          hint: `Te queda ${marginPct(o2)} de margen de O₂ y ${marginPct(bat)} de batería. Quedate más tiempo en una parada.`,
        };
      },
    },
    {
      kind: "info",
      title: "Qué se acabó primero",
      focus: [EDU_TARGET.BREAKDOWN],
      body: ({ route }) => {
        if (!route) return <NeedRoute />;
        const o2 = limitOf(route, "o2");
        const bat = limitOf(route, "battery");
        const first =
          o2?.margin != null && bat?.margin != null ? (o2.margin <= bat.margin ? "el O₂" : "la batería") : null;
        const total = totalMinutes(route);
        return (
          <>
            <Facts
              rows={[
                ["Duración de la EVA", total === null ? "sin dato" : formatMinutes(total)],
                ["O₂ usado / disponible", `${measure(o2?.used, 3)} / ${measure(o2?.limit, 3)}`],
                ["Margen de O₂", marginPct(o2)],
                ["Batería usada / disponible", `${measure(bat?.used, 0)} / ${measure(bat?.limit, 0)}`],
                ["Margen de batería", marginPct(bat)],
              ]}
            />
            {first ? <P>En esta ruta se acaba primero {first}.</P> : null}
            {o2?.limit.assumptions?.length ? <Caveat>{o2.limit.assumptions.join(" ")}</Caveat> : null}
            <Caveat>
              Es un modelo (Pandolf ajustado a la gravedad de Marte, con los valores del traje EMU de la
              ISS), no una medición: el consumo real cambia con cada persona.
            </Caveat>
          </>
        );
      },
    },
  ],
};

const contacto: Lesson = {
  id: "contacto",
  title: "Perder de vista el hábitat",
  tagline: "Sin GPS ni repetidoras, la radio va en línea recta: una loma te deja incomunicado.",
  steps: [
    {
      kind: "info",
      title: "Por qué importa la línea de vista",
      body: () => (
        <P>
          En Marte no hay GPS ni antenas en el terreno. Si una loma queda entre vos y el hábitat, perdés
          la radio. El planificador cuenta los minutos seguidos sin línea de vista y evita, si puede, las
          celdas tapadas.
        </P>
      ),
    },
    {
      kind: "task",
      title: "Escondete",
      goal: "Armá una ruta donde pases al menos un rato sin contacto con el hábitat.",
      layers: ["relief-hillshade"],
      focus: [EDU_TARGET.SEARCH, EDU_TARGET.BREAKDOWN],
      body: () => <P>Llevá el destino detrás de una loma o al fondo de un cráter.</P>,
      check: ({ route }) => {
        if (!route) return NO_ROUTE;
        const c = limitOf(route, "contact");
        if (!c || c.status === "not_evaluated") {
          return { done: false, blocked: true, hint: "Sin el DTM no se puede calcular la línea de vista en esta ruta: probá adentro del terreno de 1 m." };
        }
        const used = val(c.used);
        if (used !== null && used > 0) return { done: true, hint: null };
        return { done: false, hint: "Toda la ruta tiene vista al hábitat. Andá más lejos o detrás de un relieve." };
      },
    },
    {
      kind: "info",
      title: "Cuánto estuviste solo",
      focus: [EDU_TARGET.BREAKDOWN],
      body: ({ route }) => {
        if (!route) return <NeedRoute />;
        const c = limitOf(route, "contact");
        const min = costMinutes(route, "contact");
        return (
          <>
            <Facts
              rows={[
                ["Racha más larga sin contacto", measure(c?.used)],
                ["Límite", measure(c?.limit)],
                ["Margen", marginPct(c)],
                ["Costo extra por ir tapado", min === null ? "sin dato" : formatMinutes(min)],
              ]}
            />
            {c?.note ? <Caveat>{c.note}</Caveat> : null}
            {c?.used.assumptions?.length ? <Caveat>Supuestos: {c.used.assumptions.join(" · ")}</Caveat> : null}
          </>
        );
      },
    },
  ],
};

const dosis: Lesson = {
  id: "dosis",
  title: "La radiación se acumula",
  tagline: "No la sentís y no te frena hoy: se suma EVA tras EVA.",
  steps: [
    {
      kind: "info",
      title: "Un presupuesto, no una zona",
      body: () => (
        <>
          <P>
            Marte casi no tiene campo magnético y su atmósfera es muy fina: en la superficie llega mucha
            más radiación que en la Tierra. El rover Curiosity la midió con su instrumento RAD.
          </P>
          <P>
            En el terreno varía menos que la incertidumbre de la medición, así que no hay una zona
            “segura” a la que ir: se maneja como un presupuesto por EVA (docs/radiation.md).
          </P>
        </>
      ),
    },
    {
      kind: "task",
      title: "Medí tu dosis",
      goal: "Armá una ruta con la dosis evaluada.",
      focus: [EDU_TARGET.BREAKDOWN],
      body: () => <P>Cualquier ruta sirve. Si querés, sumá una parada larga y mirá cómo crece.</P>,
      check: ({ route }) => {
        if (!route) return NO_ROUTE;
        const d = limitOf(route, "dose");
        if (val(d?.used) !== null) return { done: true, hint: null };
        return { done: false, blocked: true, hint: "El planificador no pudo calcular la dosis de esta ruta (falta la tasa de base)." };
      },
    },
    {
      kind: "info",
      title: "Cuántas EVAs te entran",
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
                ["Dosis de esta EVA", measure(d?.used, 3)],
                ["Presupuesto por EVA", measure(d?.limit, 3)],
                ["Tasa (dosis ÷ duración)", rate === null ? "sin dato" : `${num(rate, 4)} ${d?.used.unit ?? ""}/h`],
                ["EVAs así dentro del presupuesto", used && limit ? num(Math.floor(limit / used), 0) : "sin dato"],
              ]}
            />
            <P>
              La dosis crece con el tiempo afuera, no con el lugar. Por eso no cambia la ruta: cambia
              cuántas salidas te podés permitir.
            </P>
            {d?.used.source ? <Caveat>Fuente de la tasa: {d.used.source}.</Caveat> : null}
            {d?.limit.provenance === "ASSUMED" ? (
              <Caveat>El presupuesto por EVA lo eligió el equipo y todavía no tiene fuente citable.</Caveat>
            ) : null}
          </>
        );
      },
    },
  ],
};

const robustez: Lesson = {
  id: "robustez",
  title: "Los planes fallan",
  tagline: "Una ruta buena aguanta salir tarde, caminar lento o cargar de más.",
  steps: [
    {
      kind: "info",
      title: "El plan B ya tiene que estar en el plan A",
      body: () => (
        <P>
          Afuera las cosas se demoran. El planificador toma tu misma ruta y la recalcula en peores
          condiciones: salir 30 min tarde, caminar un 20 % más lento, llevar un 10 % más de carga. No es
          una probabilidad: cuenta en cuántos de esos escenarios seguís bien.
        </P>
      ),
    },
    {
      kind: "predict",
      title: "Antes de mirar",
      question: "Armá una ruta. Sin ver el veredicto: ¿qué es lo que más la limita?",
      hide: [EDU_TARGET.VERDICT, EDU_TARGET.BREAKDOWN],
      body: () => <P>El veredicto queda tapado hasta que elijas.</P>,
      reveal: (ctx, p) => revealFactor(ctx.route, p),
    },
    {
      kind: "task",
      title: "Hacela robusta",
      goal: "Conseguí una ruta que no sea NO-GO y que aguante todos los escenarios que se pueden evaluar.",
      focus: [EDU_TARGET.BREAKDOWN, EDU_TARGET.DEPART],
      body: () => <P>Si falla, acortala, salí más temprano o sacá paradas.</P>,
      check: ({ route }) => {
        if (!route) return NO_ROUTE;
        const rob = route.verdict.robustness;
        if (!rob || rob.evaluated === 0) {
          return { done: false, blocked: true, hint: "El planificador no pudo evaluar escenarios de estrés en esta ruta." };
        }
        if (route.verdict.status === "NO_GO") return { done: false, hint: "La ruta ya es NO-GO en el caso base." };
        const failing = rob.scenarios.filter((s) => s.status === "fail");
        if (failing.length === 0) return { done: true, hint: null };
        return {
          done: false,
          hint: `Falla en: ${failing.map((s) => s.label.toLowerCase()).join(", ")}.`,
        };
      },
    },
    {
      kind: "info",
      title: "Cómo quedó",
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
                    s.label,
                    s.status === "pass" ? "✓ aguanta" : s.status === "fail" ? "✕ falla" : "sin evaluar",
                  ] as const,
              )}
            />
            <P>
              {hadFails
                ? "Arrancaste con una ruta que fallaba en algún escenario y la corregiste."
                : "Tu ruta aguantó desde el principio. Probá salir más tarde para ver cómo se rompe."}
            </P>
            {rob.scenarios.some((s) => s.status === "not_evaluated") ? (
              <Caveat>Los escenarios “sin evaluar” no se cuentan: el modelo no los puede calcular (lección siguiente).</Caveat>
            ) : null}
          </>
        );
      },
    },
  ],
};

const incertezas: Lesson = {
  id: "incertezas",
  title: "Lo que no sabemos",
  tagline: "Saber qué no calcula el planificador es parte de usarlo bien.",
  steps: [
    {
      kind: "task",
      title: "Armá una ruta",
      goal: "Cualquier ruta: vamos a leer lo que el planificador admite que no sabe.",
      focus: [EDU_TARGET.POINTS],
      body: () => <P>Este planificador es un prototipo educativo, no software de vuelo. Veamos dónde están sus bordes.</P>,
      check: hasRoute,
    },
    {
      kind: "info",
      title: "Lo que el planificador te dice que no sabe",
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
                <P><strong>Escenarios que no se pueden calcular:</strong></P>
                <List items={notEvaluated.map((s) => <>{s.label}{s.note ? `: ${s.note}` : ""}</>)} />
              </>
            ) : null}
            {inactive.length > 0 ? (
              <>
                <P><strong>Peligros que el camino todavía no esquiva:</strong></P>
                <List items={inactive.map((f) => <>{f.label}{f.note ? `: ${f.note}` : ""}</>)} />
              </>
            ) : null}
            {openLimits.length > 0 ? (
              <>
                <P><strong>Límites sin evaluar o sin definir:</strong></P>
                <List items={openLimits.map((l) => <>{l.label}{l.note ? `: ${l.note}` : ""}</>)} />
              </>
            ) : null}
            {assumed.length > 0 ? (
              <>
                <P><strong>Límites que eligió el equipo, sin fuente citable todavía:</strong></P>
                <List items={assumed.map((l) => <>{l.label}: {measure(l.limit)}</>)} />
              </>
            ) : null}
            <Caveat>
              Un GO acá quiere decir “ninguno de los límites que sabemos calcular se rompe”. No quiere decir
              “es seguro”.
            </Caveat>
          </>
        );
      },
    },
  ],
};

const mision: Lesson = {
  id: "mision",
  title: "Misión final",
  tagline: "Una EVA completa a un lugar real, con todo lo que aprendiste.",
  steps: [
    {
      kind: "task",
      title: "Elegí el objetivo",
      goal: "Elegí como destino un lugar con nombre: un depósito de muestras o un objetivo científico si el sitio los tiene.",
      hide: [EDU_TARGET.VERDICT, EDU_TARGET.BREAKDOWN],
      focus: [EDU_TARGET.SEARCH],
      body: () => (
        <P>
          Marcá el hábitat y buscá el destino entre los lugares del sitio (tubos de muestra o
          objetivos que midió el rover). El veredicto queda tapado por ahora.
        </P>
      ),
      check: ({ places, waypoints, route }) => {
        if (!places || places.places.length === 0) {
          return { done: false, blocked: true, hint: "Este sitio todavía no tiene lugares cargados (places.json)." };
        }
        // Si el sitio todavía no tiene muestras ni objetivos, vale cualquier lugar con nombre.
        const science = places.places.some((p) => p.kind === "sample" || p.kind === "target");
        const dest = waypoints.length >= 2 ? waypoints.at(-1) : undefined;
        const place = dest?.placeId ? places.places.find((p) => p.id === dest.placeId) : undefined;
        if (!place) {
          return { done: false, hint: "Elegí el destino con el buscador o con un lugar sugerido, no con un clic suelto." };
        }
        if (science && place.kind !== "sample" && place.kind !== "target") {
          return { done: false, hint: "Este sitio tiene muestras u objetivos científicos: elegí uno de esos." };
        }
        if (!route) return { done: false, hint: "Esperando al planificador…" };
        return {
          done: true,
          hint: science ? null : "Este sitio todavía no tiene muestras ni objetivos cargados: vale cualquier lugar con nombre.",
        };
      },
    },
    {
      kind: "predict",
      title: "Predecí",
      question: "¿Qué va a limitar esta EVA?",
      hide: [EDU_TARGET.VERDICT, EDU_TARGET.BREAKDOWN],
      body: () => null,
      reveal: (ctx, p) => revealFactor(ctx.route, p),
    },
    {
      kind: "task",
      title: "GO y robusta",
      goal: "Dejala en GO y que aguante todos los escenarios evaluables, sin cambiar el destino.",
      focus: [EDU_TARGET.VERDICT, EDU_TARGET.DEPART, EDU_TARGET.POINTS],
      body: () => <P>Usá todo: la hora de salida, paradas intermedias, el tiempo en cada estación.</P>,
      check: ({ route }) => {
        if (!route) return NO_ROUTE;
        const v = route.verdict;
        if (v.status !== "GO") {
          return { done: false, hint: `Está en ${v.status === "NO_GO" ? "NO-GO" : "CAUTION"}${v.limiting_factor ? `; limita ${FACTOR_LABEL[v.limiting_factor].toLowerCase()}` : ""}.` };
        }
        const rob = v.robustness;
        if (rob && rob.evaluated > 0 && rob.passed < rob.evaluated) {
          return { done: false, hint: `GO, pero aguanta ${rob.passed} de ${rob.evaluated} escenarios.` };
        }
        return { done: true, hint: null };
      },
    },
    {
      kind: "info",
      title: "Lista para salir",
      focus: [EDU_TARGET.VERDICT],
      body: ({ route }) => {
        if (!route) return <NeedRoute />;
        const v = route.verdict;
        const total = totalMinutes(route);
        return (
          <>
            <Facts
              rows={[
                ["Puntaje", measure(v.score, 0)],
                ["Limita", v.limiting_factor ? FACTOR_LABEL[v.limiting_factor] : "—"],
                ["Duración", total === null ? "sin dato" : formatMinutes(total)],
                ["Robustez", v.robustness ? `${v.robustness.passed} de ${v.robustness.evaluated}` : "sin dato"],
              ]}
            />
            <P>Imprimí la tira para la muñeca con el botón “Imprimir tira” y compartí la travesía con el enlace.</P>
            <Caveat>Prototipo educativo, no software de vuelo.</Caveat>
          </>
        );
      },
    },
  ],
};

export const LESSONS: readonly Lesson[] = [datos, pendiente, reloj, consumibles, contacto, dosis, robustez, incertezas, mision];

export const lessonById = (id: string | null): Lesson | null => LESSONS.find((l) => l.id === id) ?? null;
