/**
 * Malla del terreno vista desde un punto: una grilla polar centrada en el
 * observador (azimuts × anillos cada vez más separados), así el detalle está
 * donde se ve y lo lejano cuesta poco.
 *
 * Cada vértice sale de la mejor fuente que tenga dato: los tiles del DTM
 * (`relief-dem`) en el zoom que corresponde a su separación y, donde el DTM no
 * llega, el DEM global de 200 m (`relief-far`). Donde no hay ninguna, no hay
 * terreno: se ve cielo, nunca un relleno.
 *
 * Las posiciones son exactas sobre la esfera de Marte: con la distancia el
 * suelo cae por la curvatura (d²/2R, ~235 m a 40 km), que es lo que define qué
 * asoma en el horizonte.
 */
import { MARS_RADIUS_M } from "../mars/constants";
import type { DemSampler } from "./demTiles";

const DEG = Math.PI / 180;

export const AZIMUTHS = 720; // cada 0,5°
const RINGS = 700;
const R_MIN_M = 0.5;
/** Hasta dónde se dibuja: el recorte de 200 m llega ~60 km más allá del sitio. */
export const R_MAX_M = 150_000;
/** Separación entre anillos como fracción de la distancia (~1,8 %): el detalle cae con la distancia. */
export const RADIAL_STEP = (R_MAX_M / R_MIN_M) ** (1 / (RINGS - 1)) - 1;

/** Altura de los ojos de un astronauta parado (m). */
export const EYE_HEIGHT_M = 1.7;

export type VertexSource = "dtm" | "far" | "none";

export interface HorizonMesh {
  /** x = este, y = arriba, z = −norte (convención de Three.js), en metros desde los ojos. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Altura del suelo bajo el observador (m, sobre el areoide). */
  readonly groundM: number;
  readonly groundSource: Exclude<VertexSource, "none">;
  /** Elevación (°) del horizonte del relieve en cada azimut, desde los ojos. */
  readonly horizonDeg: Float32Array;
  /** Distancia (m) del punto que define ese horizonte. */
  readonly horizonDistM: Float32Array;
  /** Cuántos vértices salieron de cada fuente. */
  readonly counts: Readonly<Record<VertexSource, number>>;
}

export interface BuildProgress {
  readonly stage: "dtm" | "far";
  readonly done: number;
  readonly total: number;
}

function ringRadii(): Float64Array {
  const r = new Float64Array(RINGS);
  const q = (R_MAX_M / R_MIN_M) ** (1 / (RINGS - 1));
  for (let i = 0; i < RINGS; i++) r[i] = R_MIN_M * q ** i;
  return r;
}

/** Separación entre muestras alrededor del anillo i: la mayor de la radial y la angular. */
function ringSpacing(r: Float64Array, i: number): number {
  const radial = (r[Math.min(i + 1, r.length - 1)]! - r[Math.max(i - 1, 0)]!) / 2;
  return Math.max(radial, (r[i]! * 2 * Math.PI) / AZIMUTHS);
}

/** Punto a distancia `d` (m) por el círculo máximo, con rumbo `az` (rad desde el norte). */
function destination(lat: number, lon: number, az: number, d: number): [number, number] {
  const p1 = lat * DEG;
  const delta = d / MARS_RADIUS_M;
  const sp = Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(az);
  const p2 = Math.asin(sp);
  const l2 = lon * DEG + Math.atan2(Math.sin(az) * Math.sin(delta) * Math.cos(p1), Math.cos(delta) - Math.sin(p1) * sp);
  return [p2 / DEG, (((l2 / DEG + 540) % 360) - 180)];
}

export async function buildHorizonMesh(
  lat: number,
  lon: number,
  near: DemSampler | null,
  far: DemSampler | null,
  signal: AbortSignal,
  onProgress?: (p: BuildProgress) => void,
  eyeHeightM = EYE_HEIGHT_M,
): Promise<HorizonMesh> {
  const radii = ringRadii();
  const n = AZIMUTHS * RINGS;
  const lats = new Float64Array(n);
  const lons = new Float64Array(n);
  const zNear = new Int8Array(RINGS);
  const zFar = new Int8Array(RINGS);
  for (let i = 0; i < RINGS; i++) {
    const spacing = ringSpacing(radii, i);
    zNear[i] = near ? near.zoomFor(spacing, lat) : 0;
    zFar[i] = far ? far.zoomFor(spacing, lat) : 0;
  }
  for (let j = 0; j < AZIMUTHS; j++) {
    const az = (j / AZIMUTHS) * 2 * Math.PI;
    for (let i = 0; i < RINGS; i++) {
      const [la, lo] = destination(lat, lon, az, radii[i]!);
      lats[j * RINGS + i] = la;
      lons[j * RINGS + i] = lo;
    }
  }

  // 1. DTM: lo de cerca y lo que cubra hasta su borde.
  const h = new Float64Array(n).fill(NaN);
  const src = new Uint8Array(n); // 0 none, 1 dtm, 2 far
  let groundM = NaN;
  let groundSource: "dtm" | "far" = "dtm";
  if (near) {
    const keys = new Set<string>();
    const k0 = near.tileKey(lon, lat, near.set.maxzoom);
    if (k0) keys.add(k0);
    for (let v = 0; v < n; v++) {
      const k = near.tileKey(lons[v]!, lats[v]!, zNear[v % RINGS]!);
      if (k) keys.add(k);
    }
    await near.load(keys, signal, (done, total) => onProgress?.({ stage: "dtm", done, total }));
    groundM = near.sample(lon, lat, near.set.maxzoom);
    for (let v = 0; v < n; v++) {
      const x = near.sample(lons[v]!, lats[v]!, zNear[v % RINGS]!);
      if (Number.isFinite(x)) {
        h[v] = x;
        src[v] = 1;
      }
    }
  }

  // 2. DEM global de 200 m donde el DTM no llega.
  if (far) {
    const keys = new Set<string>();
    if (!Number.isFinite(groundM)) {
      const k0 = far.tileKey(lon, lat, far.set.maxzoom);
      if (k0) keys.add(k0);
    }
    for (let v = 0; v < n; v++) {
      if (src[v]) continue;
      const k = far.tileKey(lons[v]!, lats[v]!, zFar[v % RINGS]!);
      if (k) keys.add(k);
    }
    await far.load(keys, signal, (done, total) => onProgress?.({ stage: "far", done, total }));
    if (!Number.isFinite(groundM)) {
      groundM = far.sample(lon, lat, far.set.maxzoom);
      groundSource = "far";
    }
    for (let v = 0; v < n; v++) {
      if (src[v]) continue;
      const x = far.sample(lons[v]!, lats[v]!, zFar[v % RINGS]!);
      if (Number.isFinite(x)) {
        h[v] = x;
        src[v] = 2;
      }
    }
  }
  if (!Number.isFinite(groundM)) {
    throw new Error("No hay altura del terreno en este punto: queda fuera del DTM y del DEM de 200 m.");
  }

  // 3. Posiciones sobre la esfera, en el marco local del observador (ojos en el origen).
  const eyeR = MARS_RADIUS_M + groundM + eyeHeightM;
  const positions = new Float32Array((n + 1) * 3);
  positions[1] = -eyeHeightM; // vértice 0: el suelo bajo los pies
  const horizonDeg = new Float32Array(AZIMUTHS).fill(-90);
  const horizonDistM = new Float32Array(AZIMUTHS);
  const counts = { dtm: 0, far: 0, none: 0 };
  for (let j = 0; j < AZIMUTHS; j++) {
    const az = (j / AZIMUTHS) * 2 * Math.PI;
    const se = Math.sin(az);
    const cn = Math.cos(az);
    for (let i = 0; i < RINGS; i++) {
      const v = j * RINGS + i;
      if (!src[v]) {
        counts.none++;
        continue;
      }
      counts[src[v] === 1 ? "dtm" : "far"]++;
      const delta = radii[i]! / MARS_RADIUS_M;
      const rr = MARS_RADIUS_M + h[v]!;
      const horiz = rr * Math.sin(delta);
      const up = rr * Math.cos(delta) - eyeR;
      const o = (v + 1) * 3;
      positions[o] = horiz * se;
      positions[o + 1] = up;
      positions[o + 2] = -horiz * cn;
      const elev = Math.atan2(up, horiz) / DEG;
      if (elev > horizonDeg[j]!) {
        horizonDeg[j] = elev;
        horizonDistM[j] = radii[i]!;
      }
    }
  }

  // 4. Triángulos, salteando los que tocan un vértice sin dato.
  const idx: number[] = [];
  const has = (v: number) => src[v] !== 0;
  for (let j = 0; j < AZIMUTHS; j++) {
    const jn = (j + 1) % AZIMUTHS;
    const a0 = j * RINGS;
    const b0 = jn * RINGS;
    // Abanico al centro (orden antihorario visto desde arriba: normal hacia arriba).
    if (has(a0) && has(b0)) idx.push(0, b0 + 1, a0 + 1);
    for (let i = 0; i < RINGS - 1; i++) {
      const a = a0 + i;
      const b = b0 + i;
      if (has(a) && has(b) && has(a + 1)) idx.push(a + 1, b + 1, a + 2);
      if (has(b) && has(b + 1) && has(a + 1)) idx.push(b + 1, b + 2, a + 2);
    }
  }

  return {
    positions,
    indices: Uint32Array.from(idx),
    groundM,
    groundSource,
    horizonDeg,
    horizonDistM,
    counts,
  };
}

/** Elevación del horizonte del relieve en un azimut (°), interpolando entre muestras. */
export function horizonAt(mesh: HorizonMesh, azimuthDeg: number): number {
  const f = (((azimuthDeg % 360) + 360) % 360) / (360 / AZIMUTHS);
  const j = Math.floor(f) % AZIMUTHS;
  const k = (j + 1) % AZIMUTHS;
  const t = f - Math.floor(f);
  return mesh.horizonDeg[j]! * (1 - t) + mesh.horizonDeg[k]! * t;
}
