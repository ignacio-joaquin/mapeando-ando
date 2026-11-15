/**
 * Valida el reloj marciano del mapa contra efemérides de verdad.
 *
 * Corre el `src/mars/mars24.ts` real (no una copia) y lo compara muestra por
 * muestra contra `src/mars/ephemeris-reference.json`, que genera SPICE en el
 * server con `pipeline/check_mars24.py`. Es el criterio de cierre del ticket
 * del reloj.
 *
 *   node --experimental-strip-types web/scripts/check-mars24.mjs
 *
 * Sin el archivo de referencia no inventa nada: avisa cómo generarlo y sale
 * con código 2, para que el CI lo distinga de una validación fallada (1).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));
const REFERENCIA = resolve(AQUI, "../src/mars/ephemeris-reference.json");

// Tolerancias. Mars24 es una aproximación analítica: Allison & McEwen declaran
// del orden de segundos en la hora solar y centésimas de grado en Ls. Son
// suficientes para el reloj y el deslizador del planificador, no para navegar.
const TOLERANCIA_LTST_S = 15;
const TOLERANCIA_LS_DEG = 0.2;

if (!existsSync(REFERENCIA)) {
  console.error(
    [
      "Falta la referencia de efemérides.",
      "",
      `  esperaba: ${REFERENCIA}`,
      "",
      "La genera SPICE, en el server y con los kernels bajados:",
      "  .venv-pipeline/bin/python pipeline/check_mars24.py --site jezero",
      "",
      "Sin eso no hay contra qué validar el reloj. No se compara contra",
      "valores inventados.",
    ].join("\n"),
  );
  process.exit(2);
}

const { marsTime, localTrueSolarTime } = await import("../src/mars/mars24.ts");

const ref = JSON.parse(readFileSync(REFERENCIA, "utf8"));
const lon = ref.center.lon;

let peorLtst = 0;
let peorLs = 0;
const fallas = [];

for (const m of ref.samples) {
  const t = new Date(m.utc);
  const mt = marsTime(t);
  const ltstH = localTrueSolarTime(mt.mtc, lon, mt.eotHours);

  // Diferencia circular: 23:59:59 y 00:00:01 están a 2 s, no a casi un sol.
  const solS = 24 * 3600;
  let dLtst = Math.abs(ltstH * 3600 - m.ltst_s) % solS;
  if (dLtst > solS / 2) dLtst = solS - dLtst;

  let dLs = Math.abs(mt.ls - m.ls_deg) % 360;
  if (dLs > 180) dLs = 360 - dLs;

  peorLtst = Math.max(peorLtst, dLtst);
  peorLs = Math.max(peorLs, dLs);

  if (dLtst > TOLERANCIA_LTST_S || dLs > TOLERANCIA_LS_DEG) {
    fallas.push(
      `${m.utc}: LTST difiere ${dLtst.toFixed(1)} s, Ls difiere ${dLs.toFixed(3)}°`,
    );
  }
}

console.log(`Sitio ${ref.site} · ${ref.samples.length} muestras · referencia ${ref.generated_at}`);
console.log(`Peor diferencia de LTST: ${peorLtst.toFixed(1)} s (tolerancia ${TOLERANCIA_LTST_S} s)`);
console.log(`Peor diferencia de Ls:   ${peorLs.toFixed(3)}° (tolerancia ${TOLERANCIA_LS_DEG}°)`);

if (fallas.length) {
  console.error(`\n${fallas.length} muestras fuera de tolerancia:`);
  for (const f of fallas.slice(0, 10)) console.error(`  ${f}`);
  if (fallas.length > 10) console.error(`  … y ${fallas.length - 10} más`);
  process.exit(1);
}

console.log("\nEl reloj coincide con las efemérides dentro de la tolerancia.");
