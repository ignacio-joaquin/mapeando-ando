/**
 * Mars24 — hora solar marciana y Ls.
 * Algoritmo de Allison & McEwen (2000), tal como lo publica el NASA GISS
 * "Mars24 Sunclock algorithm". Precisión del orden de segundos: alcanza para
 * el reloj y el deslizador del planificador, no para navegación.
 *
 * Verificación contra efemérides (SPICE, pipeline): ver ticket del reloj.
 */

const DEG = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * DEG);
const cos = (deg: number) => Math.cos(deg * DEG);
const mod360 = (x: number) => ((x % 360) + 360) % 360;

/** TT - UTC en segundos (leap seconds + 32.184). Válido desde 2017-01-01. */
const TT_MINUS_UTC_S = 69.184;

export interface MarsTime {
  /** Mars Sol Date. */
  readonly msd: number;
  /** Coordinated Mars Time, hora decimal 0–24 en el meridiano 0. */
  readonly mtc: number;
  /** Longitud solar (estación), grados 0–360. */
  readonly ls: number;
  /** Ecuación del tiempo, en horas. */
  readonly eotHours: number;
}

export function marsTime(date: Date): MarsTime {
  const jdUt = 2_440_587.5 + date.getTime() / 86_400_000;
  const jdTt = jdUt + TT_MINUS_UTC_S / 86_400;
  const dt = jdTt - 2_451_545.0; // días desde J2000 (TT)

  // Anomalía media y longitud media del Sol ficticio.
  const m = mod360(19.3871 + 0.52402073 * dt);
  const alphaFms = mod360(270.3871 + 0.524038496 * dt);

  // Perturbaciones de corto plazo.
  const terms: readonly [number, number, number][] = [
    [0.0071, 2.2353, 49.409],
    [0.0057, 2.7543, 168.173],
    [0.0039, 1.1177, 191.837],
    [0.0037, 15.7866, 21.736],
    [0.0021, 2.1354, 15.957],
    [0.002, 2.4694, 95.528],
    [0.0018, 32.8493, 49.095],
  ];
  const pbs = terms.reduce(
    (acc, [a, tau, phi]) => acc + a * cos((0.985626 * dt) / tau + phi),
    0,
  );

  // Ecuación del centro.
  const nuMinusM =
    (10.691 + 3.0e-7 * dt) * sin(m) +
    0.623 * sin(2 * m) +
    0.05 * sin(3 * m) +
    0.005 * sin(4 * m) +
    0.0005 * sin(5 * m) +
    pbs;

  const ls = mod360(alphaFms + nuMinusM);

  // Ecuación del tiempo, en grados -> horas.
  const eotDeg =
    2.861 * sin(2 * ls) - 0.071 * sin(4 * ls) + 0.002 * sin(6 * ls) - nuMinusM;
  const eotHours = eotDeg * (24 / 360);

  const msd = (dt - 4.5) / 1.027491252 + 44_796.0 - 0.00096;
  const mtc = ((msd % 1) + 1) % 1 * 24;

  return { msd, mtc, ls, eotHours };
}

/** Hora solar media local (LMST) en horas decimales, para una longitud este. */
export function localMeanSolarTime(mtc: number, lonEast: number): number {
  const lonWest = mod360(-lonEast);
  return ((mtc - lonWest * (24 / 360)) % 24 + 24) % 24;
}

/** Hora solar verdadera local (LTST): lo que marca un reloj de sol en el sitio. */
export function localTrueSolarTime(
  mtc: number,
  lonEast: number,
  eotHours: number,
): number {
  return ((localMeanSolarTime(mtc, lonEast) + eotHours) % 24 + 24) % 24;
}

/** Número de sol del sitio (entero), a partir del MSD y la longitud. */
export function siteSol(msd: number, lonEast: number): number {
  const lonWest = mod360(-lonEast);
  return Math.floor(msd - lonWest / 360);
}

export function formatMarsTime(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  const s = Math.floor((((hours - h) * 60) - m) * 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Estación en el hemisferio norte marciano, según Ls. */
export function seasonFromLs(ls: number): string {
  if (ls < 90) return "primavera norte";
  if (ls < 180) return "verano norte";
  if (ls < 270) return "otoño norte";
  return "invierno norte";
}

/** LTST (horas, 0–24) en una longitud dada para un instante terrestre. */
export function ltstAt(date: Date, lonEast: number): number {
  const mt = marsTime(date);
  return localTrueSolarTime(mt.mtc, lonEast, mt.eotHours);
}

/** Sol medio en ms terrestres (1,027491252 días). */
export const SOL_MS = 88_775_244;

/**
 * Última medianoche local (LTST 00:00) en o antes del instante, en ms UTC.
 * Igual que `local_midnight_before` de api/mars_time.py.
 */
export function localMidnightBefore(date: Date, lonEast: number): number {
  const t = date.getTime();
  let m = t - (ltstAt(date, lonEast) / 24) * SOL_MS;
  // La ecuación del tiempo cambia segundos por sol: converge enseguida.
  for (let i = 0; i < 3; i++) {
    const off = ((ltstAt(new Date(m), lonEast) + 12) % 24 + 24) % 24 - 12;
    m -= (off / 24) * SOL_MS;
  }
  return m <= t + 1000 ? m : m - SOL_MS;
}

/** Diferencia de estación de `fromLs` a `toLs`, en grados, entre −180 y 180. */
export function dlsDeg(fromLs: number, toLs: number): number {
  return mod360(toLs - fromLs + 180) - 180;
}

/** Declinación del Sol (latitud subsolar) según Ls. Mars24, paso C-1. */
export function declinationDeg(ls: number): number {
  return Math.asin(0.42565 * sin(ls)) / DEG + 0.25 * sin(ls);
}
