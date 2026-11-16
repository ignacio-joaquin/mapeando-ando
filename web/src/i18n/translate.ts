/**
 * Traductor de texto-dato español → inglés. Primero busca la frase exacta;
 * después prueba los patrones (frases con números o nombres adentro); por
 * último, si la frase está hecha de partes conocidas separadas por ". " o "; ",
 * traduce cada parte. Lo que no reconoce queda en español.
 */
import { EXACT, PATTERNS } from "./data.en";
import { translateDirection } from "./directions";

const cache = new Map<string, string>();

function one(s: string): string | null {
  const exact = EXACT[s];
  if (exact !== undefined) return exact;
  const dir = translateDirection(s);
  if (dir !== null) return dir;
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    // Un patrón puede devolver null: calzó la forma pero no conoce las partes.
    const out = fn(m, translateData);
    if (out !== null) return out;
  }
  return null;
}

export function translateData(raw: string): string {
  const hit = cache.get(raw);
  if (hit !== undefined) return hit;
  const s = raw.trim();
  let out = one(s) ?? one(s.replace(/\.$/, ""))?.concat(s.endsWith(".") ? "." : "") ?? null;
  if (out === null) {
    // Frase compuesta: "A. B." o "A; B". Se traduce por partes si todas se conocen.
    const parts = s.split(/(?<=[.;:])\s+/);
    if (parts.length > 1) {
      const tr = parts.map((p) => one(p) ?? one(p.replace(/[.;:]$/, ""))?.concat(p.slice(-1).match(/[.;:]/) ? p.slice(-1) : ""));
      if (tr.every((x) => x != null)) out = tr.join(" ");
    }
  }
  const res = out ?? raw;
  if (out === null && import.meta.env.DEV) console.debug("[i18n] sin traducción:", raw);
  cache.set(raw, res);
  return res;
}
