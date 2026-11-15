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
 */
import { marsBearingDeg, marsDistanceM } from "../mars/geo";
import { ltstAt } from "../mars/mars24";
import { localGeometry, type SourceInfo } from "../domain/provenance";
import { getT, type Messages } from "../i18n";
import type {
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

/** Procedencias del ejemplo, con los textos del idioma activo. */
function exampleSources(t: Messages) {
  const example: SourceInfo = {
    provenance: "MODELED",
    mission: null,
    instrument: t.example.instrument,
    source: t.example.source,
    assumptions: t.example.assumptions(EXAMPLE_PARAMS),
  };
  const dose: SourceInfo = {
    provenance: "MODELED",
    mission: "MSL",
    instrument: "RAD",
    source: "Hassler et al. 2014 (reference/rad_surface_dose.json)",
    assumptions: t.example.doseAssumptions(RAD_DOSE_MSV_PER_DAY),
  };
  const geometry = localGeometry(t);
  const straightLine: SourceInfo = {
    ...geometry,
    assumptions: [...(geometry.assumptions ?? []), t.example.straightLine],
  };
  const missingDtm: SourceInfo = {
    provenance: "DERIVED",
    mission: "MRO",
    instrument: "HiRISE DTM",
    resolution: "1 m/px",
    source: t.example.missingDtm,
  };
  return { example, dose, straightLine, missingDtm };
}

const mv = (value: number | null, unit: string | null, src: SourceInfo): MeasuredValue => ({
  ...src,
  value,
  unit,
});

const HOUR_MS = 3_600_000;

/**
 * Los textos (supuestos, veredicto) salen en el idioma activo al momento del
 * cálculo; el planificador vuelve a calcular cuando cambia el idioma.
 */
export function exampleRoute(req: RouteRequest): RouteResponse {
  const msg = getT();
  const { example, dose, straightLine, missingDtm } = exampleSources(msg);
  const wps = req.waypoints;
  const t0 = new Date(req.depart_utc).getTime();
  const p = EXAMPLE_PARAMS;

  const legs: RouteLeg[] = [];
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i]!;
    const b = wps[i + 1]!;
    const d = marsDistanceM(a, b);
    legs.push({
      from: i,
      to: i + 1,
      coordinates: [
        [a.lon, a.lat],
        [b.lon, b.lat],
      ],
      class: "unknown",
      distance: mv(d, "m", straightLine),
      duration: mv((d / 1000 / p.walkSpeedKmh) * 60, "min", example),
      bearing: mv(marsBearingDeg(a, b), "°", straightLine),
      max_slope: mv(null, "°", missingDtm),
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
      o2_remaining: mv(p.o2Hours - h, "h", example),
      battery_remaining: mv(((p.batteryHours - h) / p.batteryHours) * 100, "%", example),
      dose_accumulated: mv((RAD_DOSE_MSV_PER_DAY / 24) * h, "mSv", dose),
      margin: mv(marginMin, "min", example),
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
      summary: msg.example.dark(p.daylightLtst.from, p.daylightLtst.to),
      margin: mv(marginMin, "min", example),
    };
  } else if (marginMin < p.reserveMin) {
    verdict = {
      status: "NO_GO",
      limiting_factor: limiting,
      summary:
        limiting === "o2"
          ? msg.example.noReserveO2(p.reserveMin)
          : msg.example.noReserveBattery(p.reserveMin),
      margin: mv(marginMin, "min", example),
    };
  } else {
    verdict = {
      status: "GO",
      limiting_factor: limiting,
      summary:
        limiting === "o2" ? msg.example.goO2 : msg.example.goBattery,
      margin: mv(marginMin, "min", example),
    };
  }

  return { site: req.site, depart_utc: req.depart_utc, legs, stops, verdict };
}
