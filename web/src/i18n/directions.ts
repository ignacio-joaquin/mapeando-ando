/**
 * Indicaciones paso a paso (api/directions.py) al inglés.
 *
 * La API arma cada frase con una gramática cerrada: reloj ("a las 2"), largo
 * ("unos 15 min (1,2 km)"), nombre del landmark ("el borde norte del cráter
 * Jezero"), el Sol respecto del cuerpo, altura en dedos o puños. Acá está la
 * misma gramática al revés. Si una frase no calza (la API cambió una
 * plantilla), devuelve null y se muestra en español: no se adivina.
 *
 * Si se toca una plantilla de api/directions.py, se toca también acá.
 */

const HAND: Record<string, string> = { derecha: "right", izquierda: "left" };
const SHOULDER: Record<string, string> = { derecho: "right", izquierdo: "left" };

const SIDE: Record<string, string> = {
  norte: "north",
  noreste: "northeast",
  este: "east",
  sureste: "southeast",
  sur: "south",
  suroeste: "southwest",
  oeste: "west",
  noroeste: "northwest",
};

const COMPASS: Record<string, string> = { N: "N", NE: "NE", E: "E", SE: "SE", S: "S", SO: "SW", O: "W", NO: "NW" };

const REASON: Record<string, string> = {
  "Sin referencia visible": "No visible reference",
  "No se pudo evaluar qué se ve (falta terreno en este trecho)":
    "Could not evaluate what is visible (no terrain on this stretch)",
  "Sin landmarks evaluados": "No landmarks evaluated",
  "Sin catálogo de landmarks (falta places.json)": "No landmark catalog (places.json is missing)",
  "Sin terreno para la línea de vista (falta el DTM y el DEM)":
    "No terrain for the line of sight (the DTM and the DEM are missing)",
};

/** "1,2 km" -> "1.2 km". */
function dist(s: string): string {
  return s.replace(/(\d),(\d)/g, "$1.$2");
}

/** "unos 15 min (1,2 km)" o solo la distancia. */
function walk(s: string): string {
  const m = /^unos (\d+) min \((.+)\)$/.exec(s);
  return m ? `about ${m[1]} min (${dist(m[2]!)})` : dist(s);
}

/** "a la 1" / "a las 10" -> "at 1 o'clock". */
function clockAt(s: string): string | null {
  const m = /^a las? (\d{1,2})$/.exec(s);
  return m ? `at ${m[1]} o'clock` : null;
}

/** "la 1" / "las 10" (después de "hacia") -> "1 o'clock". */
function clockTo(s: string): string | null {
  const m = /^las? (\d{1,2})$/.exec(s);
  return m ? `${m[1]} o'clock` : null;
}

function bodySide(s: string): string | null {
  if (s === "de frente") return "in front of you";
  if (s === "en la espalda") return "at your back";
  let m = /^adelante a la (derecha|izquierda)$/.exec(s);
  if (m) return `ahead to your ${HAND[m[1]!]}`;
  m = /^sobre el hombro (derecho|izquierdo)$/.exec(s);
  if (m) return `over your ${SHOULDER[m[1]!]} shoulder`;
  m = /^atrás a la (derecha|izquierda)$/.exec(s);
  if (m) return `behind you to the ${HAND[m[1]!]}`;
  return null;
}

/** "el Sol sobre el hombro derecho y tu sombra hacia las 9". */
function sunPhrase(s: string): string | null {
  const m = /^el Sol (.+) y tu sombra hacia (las? \d{1,2})$/.exec(s);
  if (!m) return null;
  const b = bodySide(m[1]!);
  const c = clockTo(m[2]!);
  return b && c ? `the Sun ${b} and your shadow toward ${c}` : null;
}

function height(s: string): string | null {
  if (s === "apenas sobre el horizonte") return "just above the horizon";
  const m = /^a (un|\d+) (dedos?|puños?) sobre el horizonte$/.exec(s);
  if (!m) return null;
  const n = m[1] === "un" ? 1 : Number(m[1]);
  const unit = m[2]!.startsWith("dedo") ? "finger" : "fist";
  return `${n === 1 ? "one" : n} ${unit}${n === 1 ? "" : "s"} above the horizon`;
}

/** Nombre base de un landmark ("el cráter Jezero", "el mástil del hábitat"…). */
function baseName(s: string): string | null {
  if (s === "el mástil del hábitat") return "the habitat mast";
  let m = /^el cráter sin nombre de ([\d,]+) km \((.+)\)$/.exec(s);
  if (m) return `the unnamed ${dist(m[1]!)} km crater (${m[2]})`;
  m = /^el cerro sin nombre (.+)$/.exec(s);
  if (m) return `unnamed hill ${m[1]}`;
  m = /^el cráter (.+)$/.exec(s);
  if (m) return `${m[1]} crater`;
  // Monte, domo, colina, mesa: el nombre IAU ya dice qué es (Aeolis Mons).
  m = /^(?:el monte|los montes|el domo|los domos|la colina|las colinas|la mesa|las mesas) (.+)$/.exec(s);
  if (m) return m[1]!;
  return null;
}

/** "de la mesa X" -> el nombre después de la preposición contraída. */
function afterDe(s: string): string | null {
  let m = /^del (.+)$/.exec(s);
  if (m) return baseName(`el ${m[1]}`);
  m = /^de (.+)$/.exec(s);
  return m ? baseName(m[1]!) : null;
}

const WHICH: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^, el (más alto|más grande|más bajo|más chico) de (los dos|los \d+) que se ven hacia ahí$/, (m) =>
    `, the ${{ "más alto": "tallest", "más grande": "largest", "más bajo": "lowest", "más chico": "smallest" }[m[1]!]} of the ${count(m[2]!)} visible that way`],
  [/^, el de más a la (izquierda|derecha) de (los dos|los \d+) que se ven hacia ahí$/, (m) =>
    `, the ${m[1] === "izquierda" ? "leftmost" : "rightmost"} of the ${count(m[2]!)} visible that way`],
  [/^, el del medio de (los dos|los \d+) que se ven hacia ahí$/, (m) => `, the middle one of the ${count(m[1]!)} visible that way`],
];

function count(s: string): string {
  return s === "los dos" ? "two" : s.replace("los ", "");
}

/** Nombre completo: base, o "el borde X de…", más el "cuál de los parecidos". */
function fullName(s: string): string | null {
  let rest = s;
  let suffix = "";
  const comma = s.indexOf(", el ");
  if (comma >= 0) {
    const tail = s.slice(comma);
    const w = WHICH.map(([re, fn]) => {
      const m = re.exec(tail);
      return m ? fn(m) : null;
    }).find((x) => x !== null);
    if (!w) return null;
    suffix = w;
    rest = s.slice(0, comma);
  }
  const side = /^el borde (\S+) (de.+)$/.exec(rest);
  if (side) {
    const sideEn = SIDE[side[1]!];
    const of = afterDe(side[2]!);
    return sideEn && of ? `the ${sideEn} rim of ${of}${suffix}` : null;
  }
  const b = baseName(rest);
  return b ? b + suffix : null;
}

type Rule = [RegExp, (m: RegExpExecArray) => string | null];

const RULES: Rule[] = [
  // Indicación principal
  [/^Girá a la (derecha|izquierda) hasta tener (.+) (a las? \d{1,2}) y caminá (.+)\.$/, (m) => {
    const n = fullName(m[2]!);
    const c = clockAt(m[3]!);
    return n && c ? `Turn ${HAND[m[1]!]} until you have ${n} ${c} and walk ${walk(m[4]!)}.` : null;
  }],
  [/^Caminá (.+?) hacia (.+), (a las? \d{1,2})\.$/, (m) => {
    const n = fullName(m[2]!);
    const c = clockAt(m[3]!);
    return n && c ? `Walk ${walk(m[1]!)} toward ${n}, ${c}.` : null;
  }],
  [/^Caminá (.+?) con (.+) (a las? \d{1,2}), a tu espalda\.$/, (m) => {
    const n = fullName(m[2]!);
    const c = clockAt(m[3]!);
    return n && c ? `Walk ${walk(m[1]!)} with ${n} ${c}, behind you.` : null;
  }],
  [/^Caminá (.+?) con (.+) (a las? \d{1,2})\.$/, (m) => {
    const n = fullName(m[2]!);
    const c = clockAt(m[3]!);
    return n && c ? `Walk ${walk(m[1]!)} with ${n} ${c}.` : null;
  }],
  // Respaldos: por el Sol o por rumbo, con o sin giro
  [/^(.+?)(?:\. Girá a la (derecha|izquierda), hacia (las? \d{1,2}) y |: )(caminá (.+?) con (el Sol .+)|mantené el rumbo (\d{3})° \((\w+)\) durante (.+))\.$/, (m) => {
    const reason = REASON[m[1]!] ?? null;
    if (!reason) return null;
    let lead = `${reason}: `;
    if (m[2]) {
      const c = clockTo(m[3]!);
      if (!c) return null;
      lead = `${reason}. Turn ${HAND[m[2]]}, toward ${c} and `;
    }
    if (m[6]) {
      const sp = sunPhrase(m[6]);
      return sp ? `${lead}walk ${walk(m[5]!)} with ${sp}.` : null;
    }
    const comp = COMPASS[m[8]!];
    return comp ? `${lead}keep a bearing of ${m[7]}° (${comp}) for ${walk(m[9]!)}.` : null;
  }],
  // Señal de parada
  [/^(Pará|Llegaste) cuando (.+) te quede (a las? \d{1,2})\.$/, (m) => {
    const n = fullName(m[2]!);
    const c = clockAt(m[3]!);
    if (!n || !c) return null;
    return m[1] === "Pará" ? `Stop when ${n} is ${c}.` : `You have arrived when ${n} is ${c}.`;
  }],
  // Confirmaciones
  [/^A esta hora el Sol está muy alto \((\d+)°\): la sombra es corta y no sirve para orientarse\.$/, (m) =>
    `At this hour the Sun is very high (${m[1]}°): your shadow is short and useless for finding your way.`],
  [/^Tenés (el Sol .+)\.$/, (m) => {
    const sp = sunPhrase(m[1]!);
    return sp ? `You have ${sp}.` : null;
  }],
  [/^El mástil del hábitat se ve (a las? \d{1,2})(, a tu espalda)?\.$/, (m) => {
    const c = clockAt(m[1]!);
    return c ? `The habitat mast is visible ${c}${m[2] ? ", behind you" : ""}.` : null;
  }],
  [/^El mástil queda a unos (.+)\.$/, (m) => `The mast is about ${dist(m[1]!)} away.`],
  [/^Se ve como una loma baja \(el borde\) a unos (.+?), (.+)\.$/, (m) => {
    const h = height(m[2]!);
    return h ? `It looks like a low rise (the rim) about ${dist(m[1]!)} away, ${h}.` : null;
  }],
  [/^Queda a unos (.+?), (.+)\.$/, (m) => {
    const h = height(m[2]!);
    return h ? `It is about ${dist(m[1]!)} away, ${h}.` : null;
  }],
];

/** La frase en inglés, o null si no calza con ninguna plantilla conocida. */
export function translateDirection(s: string): string | null {
  for (const [re, fn] of RULES) {
    const m = re.exec(s);
    if (m) {
      const out = fn(m);
      if (out) return out;
    }
  }
  return null;
}
