/**
 * Planificador de EJEMPLO, para desarrollar la UI mientras /api/route no existe.
 *
 * REGLA (core value): esto no es el modelo de rutas del equipo y la UI lo dice
 * con un cartel. Qué sale de dónde:
 * - Distancia y rumbo: geometría esférica sobre la línea recta (DERIVED, real).
 * - Dosis: tasa base medida por MSL RAD en Gale (reference/rad_surface_dose.json),
 *   sin blindaje del terreno (MODELED).
 * - Velocidad, autonomía de O2 y batería, reserva y ventana de luz: PARÁMETROS DE
 *   EJEMPLO elegidos para que la UI tenga algo que mostrar. No son datos ni
 *   salen de ningún traje real. Están todos juntos abajo para que se vean.
 * - Pendiente y clase de terreno: no se calculan (falta el DTM). El tramo queda
 *   `unknown` y la pendiente en null; no se inventan.
 * - Indicaciones: sin catálogo de landmarks ni línea de vista no hay landmark
 *   que nombrar. Cada tramo lleva solo el respaldo por rumbo (geometría real de
 *   la línea recta), marcado como respaldo. Nunca un landmark de ejemplo.
 */
import { marsBearingDeg, marsDistanceM } from "../mars/geo";
import { ltstAt } from "../mars/mars24";
import { LOCAL_GEOMETRY, type SourceInfo } from "../domain/provenance";
import { formatBearing, formatDistanceM } from "../components/route/format";
import type {
  Direction,
  LimitingFactor,
  MeasuredValue,
  RouteLeg,
  RouteRequest,
  RouteResponse,
  RouteStop,
} from "./schemas";

/** Parámetros de ejemplo. Cambiar acá cambia todo el fixture. */
export const EXAMPLE_PARAMS = {
  walkSpeedKmh: 2.5,
  o2Hours: 8,
  batteryHours: 8,
  reserveMin: 30,
  daylightLtst: { from: 7, to: 17 },
} as const;

/** Tasa de dosis de base: MSL RAD, Hassler et al. 2014 (0.64 mSv/día terrestre). */
const RAD_DOSE_MSV_PER_DAY = 0.64;

const EXAMPLE: SourceInfo = {
  provenance: "MODELED",
  mission: null,
  instrument: "parámetro de ejemplo",
  source: "Planificador de ejemplo del frontend (src/api/routeFixture.ts)",
  assumptions: [
    `Caminata a ${EXAMPLE_PARAMS.walkSpeedKmh} km/h constante`,
    `Autonomía de ${EXAMPLE_PARAMS.o2Hours} h de O2 y ${EXAMPLE_PARAMS.batteryHours} h de batería, consumo lineal`,
    "Valores elegidos para probar la interfaz, no de un traje real",
  ],
};

const DOSE: SourceInfo = {
  provenance: "MODELED",
  mission: "MSL",
  instrument: "RAD",
  source: "Hassler et al. 2014 (reference/rad_surface_dose.json)",
  assumptions: [
    `Tasa de base medida en Gale (${RAD_DOSE_MSV_PER_DAY} mSv/día), igual en todo el recorrido`,
    "Sin blindaje del terreno ni eventos solares",
  ],
};

const STRAIGHT_LINE: SourceInfo = {
  ...LOCAL_GEOMETRY,
  assumptions: [
    ...(LOCAL_GEOMETRY.assumptions ?? []),
    "Tramo en línea recta: el ejemplo no esquiva obstáculos",
  ],
};

const MISSING_DTM: SourceInfo = {
  provenance: "DERIVED",
  mission: "MRO",
  instrument: "HiRISE DTM",
  resolution: "1 m/px",
  source: "Falta: requiere el DTM procesado por el pipeline",
};

const MISSING_LANDMARKS: SourceInfo = {
  provenance: "DERIVED",
  mission: null,
  instrument: "línea de vista",
  source: "Falta: requiere el catálogo de landmarks del pipeline y la línea de vista de /api/route",
};

/** Respaldo por rumbo de un tramo recto: lo único honesto sin landmarks. */
function bearingFallback(distanceM: number, bearingDeg: number): Direction {
  return {
    kind: "fallback_bearing",
    text: `Ejemplo sin landmarks evaluados: mantené el rumbo ${formatBearing(bearingDeg)} durante ${formatDistanceM(distanceM)}.`,
    landmark: null,
    distance: mv(distanceM, "m", STRAIGHT_LINE),
    relative_bearing_deg: null,
    visible_fraction: mv(null, null, MISSING_LANDMARKS),
  };
}

const mv = (value: number | null, unit: string | null, src: SourceInfo): MeasuredValue => ({
  ...src,
  value,
  unit,
});

const HOUR_MS = 3_600_000;

export function exampleRoute(req: RouteRequest): RouteResponse {
  const wps = req.waypoints;
  const t0 = new Date(req.depart_utc).getTime();
  const p = EXAMPLE_PARAMS;

  const legs: RouteLeg[] = [];
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i]!;
    const b = wps[i + 1]!;
    const d = marsDistanceM(a, b);
    const bearing = marsBearingDeg(a, b);
    legs.push({
      from: i,
      to: i + 1,
      coordinates: [
        [a.lon, a.lat],
        [b.lon, b.lat],
      ],
      class: "unknown",
      distance: mv(d, "m", STRAIGHT_LINE),
      duration: mv((d / 1000 / p.walkSpeedKmh) * 60, "min", EXAMPLE),
      bearing: mv(bearing, "°", STRAIGHT_LINE),
      max_slope: mv(null, "°", MISSING_DTM),
      directions: [bearingFallback(d, bearing)],
    });
  }

  // Línea de tiempo: llegar, quedarse dwell_min, salir. La salida sale a la
  // hora pedida (su dwell no cuenta); la llegada final no tiene hora de salida.
  const times: { arrive: number | null; depart: number | null }[] = [];
  let t = t0;
  wps.forEach((wp, i) => {
    const arrive = i === 0 ? null : t;
    const dwell = i === 0 ? 0 : wp.dwell_min * 60_000;
    const depart = i === wps.length - 1 ? null : (arrive ?? t0) + dwell;
    times.push({ arrive, depart });
    const leg = legs[i];
    if (leg && depart !== null) t = depart + (leg.duration.value ?? 0) * 60_000;
  });

  const tEnd = times.at(-1)?.arrive ?? t0;
  const o2End = p.o2Hours - (tEnd - t0) / HOUR_MS;
  const batEnd = p.batteryHours - (tEnd - t0) / HOUR_MS;
  const marginMin = Math.min(o2End, batEnd) * 60;
  const limiting: LimitingFactor = o2End <= batEnd ? "o2" : "battery";

  const stops: RouteStop[] = wps.map((wp, i) => {
    const at = times[i]?.arrive ?? t0;
    const h = (at - t0) / HOUR_MS;
    return {
      index: i,
      lat: wp.lat,
      lon: wp.lon,
      task: wp.task,
      arrive_utc: times[i]?.arrive != null ? new Date(times[i]!.arrive!).toISOString() : null,
      depart_utc: times[i]?.depart != null ? new Date(times[i]!.depart!).toISOString() : null,
      o2_remaining: mv(p.o2Hours - h, "h", EXAMPLE),
      battery_remaining: mv(((p.batteryHours - h) / p.batteryHours) * 100, "%", EXAMPLE),
      dose_accumulated: mv((RAD_DOSE_MSV_PER_DAY / 24) * h, "mSv", DOSE),
      margin: mv(marginMin, "min", EXAMPLE),
    };
  });

  // Veredicto: primero la luz, después la reserva del recurso que se acaba antes.
  const first = wps[0];
  const last = wps.at(-1);
  const ltDepart = first ? ltstAt(new Date(t0), first.lon) : 12;
  const ltArrive = last ? ltstAt(new Date(tEnd), last.lon) : 12;
  const crossesNight = tEnd - t0 > 12 * HOUR_MS;
  const dark =
    crossesNight ||
    ltDepart < p.daylightLtst.from ||
    ltArrive > p.daylightLtst.to ||
    ltArrive < ltDepart;

  let verdict: RouteResponse["verdict"];
  if (dark) {
    verdict = {
      status: "NO_GO",
      limiting_factor: "daylight",
      summary: `Fuera de la ventana de luz (${p.daylightLtst.from}:00–${p.daylightLtst.to}:00 hora solar local).`,
      margin: mv(marginMin, "min", EXAMPLE),
    };
  } else if (marginMin < p.reserveMin) {
    verdict = {
      status: "NO_GO",
      limiting_factor: limiting,
      summary:
        limiting === "o2"
          ? `El O2 no deja la reserva mínima de ${p.reserveMin} min al llegar.`
          : `La batería no deja la reserva mínima de ${p.reserveMin} min al llegar.`,
      margin: mv(marginMin, "min", EXAMPLE),
    };
  } else {
    verdict = {
      status: "GO",
      limiting_factor: limiting,
      summary:
        limiting === "o2"
          ? "Alcanza. Lo que se acaba primero es el O2."
          : "Alcanza. Lo que se acaba primero es la batería.",
      margin: mv(marginMin, "min", EXAMPLE),
    };
  }

  return { site: req.site, depart_utc: req.depart_utc, legs, stops, verdict };
}
