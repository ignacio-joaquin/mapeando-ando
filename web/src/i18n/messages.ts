/**
 * Textos de la UI en español e inglés. Un solo lugar para todo lo que lee el
 * usuario: si un texto no está acá, no cambia con el toggle.
 *
 * `en` está tipado con la forma de `es`: si falta una clave, o sobra, el
 * typecheck falla. Los textos con datos son funciones, para que el orden de
 * las palabras lo decida cada idioma.
 *
 * Lo que NO pasa por acá: lo que manda el server (veredicto de /api/route,
 * notas de la API, errores del pipeline, supuestos de la API). Llega en el
 * idioma en que lo escribe el backend.
 */
import type { LayerId } from "../map/layers";
import type { LegClass, LimitingFactor } from "../api/schemas";
import type { Provenance } from "../domain/provenance";
import type { Season } from "../mars/mars24";

/** Texto de una capa del catálogo (src/map/layers.ts). */
export interface LayerText {
  readonly label: string;
  /** Unidad del valor que representa. Sin unidad: no va. */
  readonly unit?: string;
  readonly resolution?: string;
  readonly source: string;
  readonly assumptions?: readonly string[];
  /** Una etiqueta por color de `legendColors`, en el mismo orden. */
  readonly legend: readonly string[];
}

/** Parámetros del planificador de ejemplo que se muestran en la UI. */
export interface ExampleParamsText {
  readonly walkSpeedKmh: number;
  readonly o2Hours: number;
  readonly batteryHours: number;
  readonly reserveMin: number;
  readonly daylightLtst: { readonly from: number; readonly to: number };
}

/** Una etiqueta por clase de SLOPE_CLASSES (src/map/layers.ts), mismo orden. */
type SlopeLabels = readonly [string, string, string, string];

const esSlope: SlopeLabels = [
  "0–10° transitable",
  "10–20° con cuidado",
  "20–30° límite del rover",
  "> 30° no transitable",
];

const esLayers: Record<LayerId, LayerText> = {
  "base-ortho": {
    label: "Ortoimagen",
    resolution: "25 cm/px",
    source: "Ortomosaico HiRISE (USGS)",
    legend: ["imagen real, sin realce"],
  },
  "relief-hillshade": {
    label: "Hillshade",
    resolution: "1 m/px",
    source: "Calculado por el pipeline desde el DTM HiRISE (USGS)",
    assumptions: [
      "Iluminación sintética fija: no es la luz real del momento",
      "Relieve exagerado x3 en vertical",
    ],
    legend: ["sombra", "luz"],
  },
  "relief-contours": {
    label: "Curvas de nivel",
    unit: "m",
    resolution: "1 m/px",
    source: "Calculado por el pipeline desde el DTM HiRISE (USGS)",
    legend: ["equidistancia 10 m"],
  },
  "relief-slope": {
    label: "Pendiente",
    unit: "°",
    resolution: "1 m/px",
    source: "Calculado por el pipeline desde el DTM HiRISE (USGS)",
    legend: esSlope,
  },
  "survival-hazard": {
    label: "Peligro",
    unit: "índice 0–1",
    resolution: "1 m/px",
    source: "Índice del pipeline a partir del DTM y la ortoimagen HiRISE",
    assumptions: ["Índice propio, no una medición: combina terreno con pesos definidos por el equipo"],
    legend: ["bajo", "medio", "alto"],
  },
  "survival-shelter": {
    label: "Refugio",
    unit: "índice 0–1",
    resolution: "1 m/px",
    source: "Índice del pipeline a partir del DTM HiRISE",
    assumptions: ["Índice propio, no una medición"],
    legend: ["protegido", "expuesto"],
  },
  "survival-dose": {
    label: "Dosis",
    unit: "µSv/h",
    resolution: "derivada, 200 m/px",
    source: "Base medida por MSL RAD en Gale (Hassler et al. 2014, reference/rad_surface_dose.json)",
    assumptions: [
      "Valor de base medido en Gale, 2012–2013; se extrapola al terreno",
      "Varía con el ciclo solar, la presión estacional y eventos solares",
    ],
    legend: ["nominal", "elevada", "limitar exposición"],
  },
  "survival-shadows": {
    label: "Sombras",
    unit: "hora solar local",
    resolution: "1 m/px",
    source: "Geometría solar (SPICE) sobre el DTM HiRISE",
    assumptions: ["Solo geometría: no considera polvo ni atmósfera"],
    legend: ["en sombra", "al sol"],
  },
};

export const es = {
  /** Para números y fechas (toLocaleString). */
  locale: "es-AR",
  /** Atributo lang de <html>. */
  htmlLang: "es",

  app: {
    subtitle: "mapa de supervivencia EVA",
    siteNav: "Sitio",
    langNav: "Idioma de la interfaz",
    apiError: (m: string) => `API: ${m}`,
    status: "commit",
    data: "datos",
    dataReady: "listos",
    dataDownloading: "descargándose",
    querying: "consultando el server…",
    plannerAria: "Planificador de travesía",
    files: (ok: number, total: number) => `${ok}/${total} archivos`,
    noData: "Sin datos descargados: el mapa muestra el recuadro del sitio, no imagen real.",
    sitesError: "No se pudo leer el inventario de sitios.",
    loadingSites: "Cargando sitios…",
    marsClock: "Reloj marciano",
    inspector: "Inspector",
    layers: "Capas",
    disclaimer: "Prototipo educativo, no software de vuelo.",
    runningFixtures: " Corriendo con datos de ejemplo.",
  },

  fixtureBanner: {
    title: "Datos de ejemplo.",
    before: "No hay backend conectado: ningún valor de esta pantalla es una medición. Para datos reales, copiá",
    middle: "a",
    after: "con la IP del server.",
  },

  measure: { missing: "falta el dato" },

  provenance: {
    OBSERVED: "observado",
    DERIVED: "derivado",
    MODELED: "modelado",
  } satisfies Record<Provenance, string>,

  badge: {
    localCalc: "cálculo local",
    localCalcLong: "cálculo local del frontend",
    resolution: "Resolución:",
    source: "Fuente:",
    assumptions: "Supuestos:",
  },

  sources: {
    localGeometryInstrument: "geometría esférica",
    localGeometrySource: "Cálculo en el navegador (src/mars/geo.ts)",
    localGeometryAssumptions: (km: string) => [
      `Esfera IAU Mars 2000 de radio ${km} km, la misma de los DTM y de la API`,
      "Distancia sobre la superficie en línea recta, sin relieve",
    ],
    mars24Source: "Algoritmo Mars24 (Allison & McEwen 2000), calculado en el navegador",
    mars24Assumptions: ["Hora del reloj de esta computadora", "Longitud del centro del sitio"],
    mars24LtstAssumptions: ["Hora solar verdadera local en la longitud de cada punto"],
  },

  inspector: {
    cursor: "Cursor",
    offMap: "— fuera del mapa —",
    picked: "Punto fijado",
    clear: "limpiar",
    coordinates: "Coordenadas",
    distanceToCenter: "Distancia al centro",
    elevation: "Elevación",
    slope: "Pendiente",
    querying: "consultando…",
    noBackend:
      "Sin backend conectado: no hay de dónde leer la elevación. No se muestra ningún valor estimado.",
    hint: "Con el modo «inspeccionar» del planificador, clic en el mapa para fijar un punto.",
  },

  layerStack: {
    groups: { relieve: "Relieve", supervivencia: "Supervivencia" },
    indexError: (m: string) => `⚠ No se pudo leer el índice de capas del pipeline: ${m}`,
    pipelineFailed: "⚠ El pipeline no pudo generarla. Hay que volver a correr precompute.py.",
    waitingPipeline: "Esperando la salida del pipeline (MAP-9).",
    opacity: "opacidad",
    opacityOf: (label: string) => `Opacidad de ${label}`,
    noErrorDetail: "error sin detalle",
  },

  layers: esLayers,
  slopeClasses: esSlope,

  clock: {
    ltst: "Hora solar local (LTST)",
    lmst: "Media local (LMST)",
    sol: "Sol del sitio",
    ls: "Ls",
    mtc: "MTC",
    seasons: {
      spring: "primavera norte",
      summer: "verano norte",
      autumn: "otoño norte",
      winter: "invierno norte",
    } satisfies Record<Season, string>,
  },

  scale: {
    title: (km: string) => `Esfera IAU Mars 2000, radio ${km} km: el mismo de los DTM y de api/terrain.py`,
    label: (km: string) => `escala marciana · R ${km} km`,
  },

  legClass: {
    ok: "transitable",
    caution: "con cuidado",
    limit: "al límite",
    blocked: "no transitable",
    unknown: "sin evaluar (falta DTM)",
  } satisfies Record<LegClass, string>,

  waypoint: {
    origin: "Salida",
    destination: "Llegada",
    station: (n: number) => `Estación ${n}`,
  },

  /** Puntos cardinales cada 45°, empezando por el norte. */
  compass: ["N", "NE", "E", "SE", "S", "SO", "O", "NO"],

  planner: {
    title: "Planificar travesía",
    clickModeAria: "Qué hace un clic en el mapa",
    addPoints: "+ puntos",
    inspect: "inspeccionar",
    departTime: "Hora de salida (hora de tu computadora)",
    now: "ahora",
    atDeparture: "En la salida:",
    routeError: (m: string) => `No se pudo calcular la ruta. ${m}`,
    print: "Imprimir tira de la travesía",
    hintDestination: "Ahora hacé clic donde querés llegar (B).",
    hintOrigin: "Hacé clic en el mapa para poner la salida (A).",
    recalculating: "Recalculando la travesía… El veredicto anterior ya no vale.",
    route: (n: number) => `Recorrido · ${n} ${n === 1 ? "punto" : "puntos"}`,
    reverse: "invertir",
    clearAll: "borrar todo",
    hintStations:
      "Clic en el mapa agrega una estación antes de la llegada. Los marcadores se pueden arrastrar.",
    exampleTitle: "Veredicto de ejemplo.",
    exampleBefore: "El server todavía no tiene",
    exampleAfter: (p: ExampleParamsText) =>
      `: esto lo calcula el frontend en línea recta, sin terreno, con parámetros supuestos (${p.walkSpeedKmh} km/h, ${p.o2Hours} h de O2 y de batería, reserva de ${p.reserveMin} min, luz de ${p.daylightLtst.from} a ${p.daylightLtst.to} h LTST). No usar para decidir.`,
    sourcesSummary: "De dónde sale cada número",
    hoursLtst: "Horas (LTST)",
    o2: "O2",
    battery: "Batería",
    dose: "Dosis",
    doseAccumulated: "Dosis acumulada",
    distanceBearing: "Distancia y rumbo",
    duration: "Duración",
    toggleStop: (label: string, open: boolean) => `${label}: ${open ? "cerrar" : "abrir"}`,
    moveUp: "Subir",
    moveDown: "Bajar",
    remove: "Quitar",
    taskStation: "Tarea (ej. tomar muestra)",
    taskOptional: "Tarea (opcional)",
    taskAria: (label: string) => `Tarea en ${label}`,
    minutesAria: (label: string) => `Minutos en ${label}`,
    min: "min",
    arrives: "Llega",
    departs: "Sale",
    yourTime: (t: string) => `Tu hora: ${t}`,
    seeHere: "Ver qué hay en este punto",
    bearing: "rumbo",
    maxSlope: "Pendiente máx.",
    legColors: "Colores de los tramos",
    dashed: "(línea punteada)",
  },

  verdict: {
    factors: {
      o2: "Oxígeno",
      battery: "Batería",
      dose: "Dosis de radiación",
      daylight: "Luz solar",
      terrain: "Terreno",
    } satisfies Record<LimitingFactor, string>,
    limitingFactor: "Factor limitante",
    reserve: "Reserva al llegar",
  },

  photo: {
    heading: "Lo que vas a ver al llegar",
    loading: "Buscando la foto del rover más cercana…",
    error: (m: string) => `No se pudieron traer las fotos. ${m}`,
    none: "Sin foto.",
    noneNear: "No hay fotos del rover cerca de este punto.",
    missingEndpoint:
      "Falta el endpoint de fotos del server (MAP-33): todavía no hay fotos reales para mostrar.",
    openFull: "Abrir la imagen completa",
    alt: (rover: string, camera: string, sol: number) => `${rover}, ${camera}, sol ${sol}`,
    sol: "sol",
    takenBefore: "Tomada a",
    takenAfter: "de esta estación",
    credit: "Crédito:",
    others: "Otras fotos cercanas",
    thumb: (i: number, camera: string, sol: number) => `Foto ${i}: ${camera}, sol ${sol}`,
    source: (rover: string, sol: number) => `Imagen cruda de ${rover}, sol ${sol} (mars.nasa.gov)`,
    assumption: "Tomada desde donde estaba el rover, no desde el punto exacto de la estación",
  },

  profile: {
    title: "Perfil de elevación",
    missing:
      "Falta el perfil. Lo devuelve el backend al muestrear el DTM sobre la ruta; mientras la ruta la calcule el planificador de ejemplo, o el DTM no esté descargado, acá no se dibuja nada. No se inventa una curva.",
    aria: (dist: string, zMin: number, zMax: number) =>
      `Perfil de elevación de la travesía: ${dist} y entre ${zMin} y ${zMax} metros de elevación`,
  },

  cuff: {
    emptyTitle: "Mapa Marciano · tira de EVA",
    empty:
      "No hay una travesía calculada para imprimir. Marcá salida y llegada en el mapa y esperá el veredicto.",
    title: "MAPA MARCIANO · TIRA DE EVA",
    departure: (ltst: string, earth: string, date: string) =>
      `SALIDA ${ltst} LTST (${earth} hora Tierra, ${date})`,
    points: (n: number) => `${n} PUNTOS`,
    reserve: "Reserva al llegar:",
    example:
      "EJEMPLO — calculado sin /api/route, en línea recta y con parámetros supuestos. NO USAR PARA DECIDIR.",
    cols: {
      arrive: "LLEGA",
      depart: "SALE",
      bearing: "RUMBO",
      dist: "DIST",
      task: "TAREA",
      o2: "O2",
      margin: "MARGEN",
    },
    footnote: "RUMBO y DIST: hacia el punto siguiente. Horas en hora solar local (LTST) de cada punto.",
    sources: "FUENTES",
    sourceCols: {
      hours: "Horas (LLEGA / SALE)",
      bearingDist: "RUMBO y DIST",
      o2: "O2",
      margin: "MARGEN y reserva",
    },
    missing: "falta",
    totalMissing: "distancia total: falta el dato",
    total: (d: string) => `${d} en total`,
  },

  example: {
    instrument: "parámetro de ejemplo",
    source: "Planificador de ejemplo del frontend (src/api/routeFixture.ts)",
    assumptions: (p: ExampleParamsText) => [
      `Caminata a ${p.walkSpeedKmh} km/h constante`,
      `Autonomía de ${p.o2Hours} h de O2 y ${p.batteryHours} h de batería, consumo lineal`,
      "Valores elegidos para probar la interfaz, no de un traje real",
    ],
    doseAssumptions: (msvPerDay: number) => [
      `Tasa de base medida en Gale (${msvPerDay} mSv/día), igual en todo el recorrido`,
      "Sin blindaje del terreno ni eventos solares",
    ],
    straightLine: "Tramo en línea recta: el ejemplo no esquiva obstáculos",
    missingDtm: "Falta: requiere el DTM procesado por el pipeline",
    dark: (from: number, to: number) =>
      `Fuera de la ventana de luz (${from}:00–${to}:00 hora solar local).`,
    noReserveO2: (min: number) => `El O2 no deja la reserva mínima de ${min} min al llegar.`,
    noReserveBattery: (min: number) => `La batería no deja la reserva mínima de ${min} min al llegar.`,
    goO2: "Alcanza. Lo que se acaba primero es el O2.",
    goBattery: "Alcanza. Lo que se acaba primero es la batería.",
  },

  api: {
    responded: (path: string, status: number) => `${path} respondió ${status}`,
    contract: (path: string, m: string) => `${path} no cumple el contrato: ${m}`,
    photosResponded: (status: number) => `fotos: el server respondió ${status}`,
    photosContract: (m: string) => `fotos: no cumple el contrato: ${m}`,
  },
};

export type Messages = typeof es;

const enSlope: SlopeLabels = [
  "0–10° traversable",
  "10–20° caution",
  "20–30° rover limit",
  "> 30° not traversable",
];

const enLayers: Record<LayerId, LayerText> = {
  "base-ortho": {
    label: "Orthoimage",
    resolution: "25 cm/px",
    source: "HiRISE orthomosaic (USGS)",
    legend: ["real image, no enhancement"],
  },
  "relief-hillshade": {
    label: "Hillshade",
    resolution: "1 m/px",
    source: "Computed by the pipeline from the HiRISE DTM (USGS)",
    assumptions: [
      "Fixed synthetic lighting: not the actual light at this moment",
      "Relief exaggerated 3x vertically",
    ],
    legend: ["shadow", "light"],
  },
  "relief-contours": {
    label: "Contour lines",
    unit: "m",
    resolution: "1 m/px",
    source: "Computed by the pipeline from the HiRISE DTM (USGS)",
    legend: ["10 m interval"],
  },
  "relief-slope": {
    label: "Slope",
    unit: "°",
    resolution: "1 m/px",
    source: "Computed by the pipeline from the HiRISE DTM (USGS)",
    legend: enSlope,
  },
  "survival-hazard": {
    label: "Hazard",
    unit: "index 0–1",
    resolution: "1 m/px",
    source: "Pipeline index from the HiRISE DTM and orthoimage",
    assumptions: ["Our own index, not a measurement: combines terrain with team-defined weights"],
    legend: ["low", "medium", "high"],
  },
  "survival-shelter": {
    label: "Shelter",
    unit: "index 0–1",
    resolution: "1 m/px",
    source: "Pipeline index from the HiRISE DTM",
    assumptions: ["Our own index, not a measurement"],
    legend: ["sheltered", "exposed"],
  },
  "survival-dose": {
    label: "Dose",
    unit: "µSv/h",
    resolution: "derived, 200 m/px",
    source: "Baseline measured by MSL RAD at Gale (Hassler et al. 2014, reference/rad_surface_dose.json)",
    assumptions: [
      "Baseline measured at Gale, 2012–2013; extrapolated to the terrain",
      "Varies with the solar cycle, seasonal pressure and solar events",
    ],
    legend: ["nominal", "elevated", "limit exposure"],
  },
  "survival-shadows": {
    label: "Shadows",
    unit: "local solar time",
    resolution: "1 m/px",
    source: "Solar geometry (SPICE) over the HiRISE DTM",
    assumptions: ["Geometry only: ignores dust and atmosphere"],
    legend: ["in shadow", "in sunlight"],
  },
};

export const en: Messages = {
  locale: "en-US",
  htmlLang: "en",

  app: {
    subtitle: "EVA survival map",
    siteNav: "Site",
    langNav: "Interface language",
    apiError: (m) => `API: ${m}`,
    status: "commit",
    data: "data",
    dataReady: "ready",
    dataDownloading: "downloading",
    querying: "checking the server…",
    plannerAria: "Traverse planner",
    files: (ok, total) => `${ok}/${total} files`,
    noData: "No data downloaded yet: the map shows the site outline, not real imagery.",
    sitesError: "Couldn't read the site inventory.",
    loadingSites: "Loading sites…",
    marsClock: "Mars clock",
    inspector: "Inspector",
    layers: "Layers",
    disclaimer: "Educational prototype, not flight software.",
    runningFixtures: " Running on example data.",
  },

  fixtureBanner: {
    title: "Example data.",
    before: "No backend connected: no value on this screen is a measurement. For real data, copy",
    middle: "to",
    after: "with the server IP.",
  },

  measure: { missing: "data missing" },

  provenance: {
    OBSERVED: "observed",
    DERIVED: "derived",
    MODELED: "modeled",
  },

  badge: {
    localCalc: "local calc",
    localCalcLong: "computed in the browser",
    resolution: "Resolution:",
    source: "Source:",
    assumptions: "Assumptions:",
  },

  sources: {
    localGeometryInstrument: "spherical geometry",
    localGeometrySource: "Computed in the browser (src/mars/geo.ts)",
    localGeometryAssumptions: (km) => [
      `IAU Mars 2000 sphere, radius ${km} km, same as the DTMs and the API`,
      "Straight-line surface distance, ignores relief",
    ],
    mars24Source: "Mars24 algorithm (Allison & McEwen 2000), computed in the browser",
    mars24Assumptions: ["This computer's clock", "Longitude of the site center"],
    mars24LtstAssumptions: ["Local true solar time at each point's longitude"],
  },

  inspector: {
    cursor: "Cursor",
    offMap: "— off the map —",
    picked: "Pinned point",
    clear: "clear",
    coordinates: "Coordinates",
    distanceToCenter: "Distance to center",
    elevation: "Elevation",
    slope: "Slope",
    querying: "querying…",
    noBackend: "No backend connected: nowhere to read elevation from. No estimated value is shown.",
    hint: "With the planner in “inspect” mode, click the map to pin a point.",
  },

  layerStack: {
    groups: { relieve: "Relief", supervivencia: "Survival" },
    indexError: (m) => `⚠ Couldn't read the pipeline layer index: ${m}`,
    pipelineFailed: "⚠ The pipeline failed to generate it. precompute.py needs to run again.",
    waitingPipeline: "Waiting for pipeline output (MAP-9).",
    opacity: "opacity",
    opacityOf: (label) => `${label} opacity`,
    noErrorDetail: "error with no details",
  },

  layers: enLayers,
  slopeClasses: enSlope,

  clock: {
    ltst: "Local true solar time (LTST)",
    lmst: "Local mean solar time (LMST)",
    sol: "Site sol",
    ls: "Ls",
    mtc: "MTC",
    seasons: {
      spring: "northern spring",
      summer: "northern summer",
      autumn: "northern autumn",
      winter: "northern winter",
    },
  },

  scale: {
    title: (km) => `IAU Mars 2000 sphere, radius ${km} km: same as the DTMs and api/terrain.py`,
    label: (km) => `Mars scale · R ${km} km`,
  },

  legClass: {
    ok: "traversable",
    caution: "caution",
    limit: "at the limit",
    blocked: "not traversable",
    unknown: "not evaluated (no DTM)",
  },

  waypoint: {
    origin: "Start",
    destination: "End",
    station: (n) => `Station ${n}`,
  },

  compass: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],

  planner: {
    title: "Plan a traverse",
    clickModeAria: "What a click on the map does",
    addPoints: "+ points",
    inspect: "inspect",
    departTime: "Departure time (your computer's clock)",
    now: "now",
    atDeparture: "At departure:",
    routeError: (m) => `Couldn't compute the route. ${m}`,
    print: "Print traverse cuff checklist",
    hintDestination: "Now click where you want to end up (B).",
    hintOrigin: "Click the map to set the start (A).",
    recalculating: "Recomputing the traverse… The previous verdict no longer applies.",
    route: (n) => `Route · ${n} ${n === 1 ? "point" : "points"}`,
    reverse: "reverse",
    clearAll: "clear all",
    hintStations: "Clicking the map adds a station before the end. Markers can be dragged.",
    exampleTitle: "Example verdict.",
    exampleBefore: "The server doesn't have",
    exampleAfter: (p) =>
      ` yet: this is computed by the frontend in a straight line, without terrain, using assumed parameters (${p.walkSpeedKmh} km/h, ${p.o2Hours} h of O2 and battery, ${p.reserveMin} min reserve, daylight from ${p.daylightLtst.from} to ${p.daylightLtst.to} h LTST). Do not use it to decide.`,
    sourcesSummary: "Where each number comes from",
    hoursLtst: "Times (LTST)",
    o2: "O2",
    battery: "Battery",
    dose: "Dose",
    doseAccumulated: "Accumulated dose",
    distanceBearing: "Distance and bearing",
    duration: "Duration",
    toggleStop: (label, open) => `${label}: ${open ? "close" : "open"}`,
    moveUp: "Move up",
    moveDown: "Move down",
    remove: "Remove",
    taskStation: "Task (e.g. take a sample)",
    taskOptional: "Task (optional)",
    taskAria: (label) => `Task at ${label}`,
    minutesAria: (label) => `Minutes at ${label}`,
    min: "min",
    arrives: "Arrives",
    departs: "Departs",
    yourTime: (t) => `Your time: ${t}`,
    seeHere: "See what's at this point",
    bearing: "bearing",
    maxSlope: "Max slope",
    legColors: "Leg colors",
    dashed: "(dashed line)",
  },

  verdict: {
    factors: {
      o2: "Oxygen",
      battery: "Battery",
      dose: "Radiation dose",
      daylight: "Daylight",
      terrain: "Terrain",
    },
    limitingFactor: "Limiting factor",
    reserve: "Reserve on arrival",
  },

  photo: {
    heading: "What you'll see when you get there",
    loading: "Looking for the nearest rover photo…",
    error: (m) => `Couldn't load the photos. ${m}`,
    none: "No photo.",
    noneNear: "There are no rover photos near this point.",
    missingEndpoint:
      "The server's photo endpoint is missing (MAP-33): no real photos to show yet.",
    openFull: "Open the full image",
    alt: (rover, camera, sol) => `${rover}, ${camera}, sol ${sol}`,
    sol: "sol",
    takenBefore: "Taken",
    takenAfter: "from this station",
    credit: "Credit:",
    others: "Other nearby photos",
    thumb: (i, camera, sol) => `Photo ${i}: ${camera}, sol ${sol}`,
    source: (rover, sol) => `Raw image from ${rover}, sol ${sol} (mars.nasa.gov)`,
    assumption: "Taken from where the rover was, not from the station's exact spot",
  },

  profile: {
    title: "Elevation profile",
    missing:
      "No profile yet. The backend returns it by sampling the DTM along the route; while the route comes from the example planner, or the DTM isn't downloaded, nothing is drawn here. We don't make up a curve.",
    aria: (dist, zMin, zMax) =>
      `Traverse elevation profile: ${dist}, between ${zMin} and ${zMax} meters of elevation`,
  },

  cuff: {
    emptyTitle: "Mapa Marciano · EVA cuff checklist",
    empty: "There's no computed traverse to print. Set a start and an end on the map and wait for the verdict.",
    title: "MAPA MARCIANO · EVA CUFF CHECKLIST",
    departure: (ltst, earth, date) => `DEPART ${ltst} LTST (${earth} Earth time, ${date})`,
    points: (n) => `${n} POINTS`,
    reserve: "Reserve on arrival:",
    example:
      "EXAMPLE — computed without /api/route, in a straight line, with assumed parameters. DO NOT USE TO DECIDE.",
    cols: {
      arrive: "ARRIVE",
      depart: "DEPART",
      bearing: "BEARING",
      dist: "DIST",
      task: "TASK",
      o2: "O2",
      margin: "MARGIN",
    },
    footnote: "BEARING and DIST: to the next point. Times in local true solar time (LTST) at each point.",
    sources: "SOURCES",
    sourceCols: {
      hours: "Times (ARRIVE / DEPART)",
      bearingDist: "BEARING and DIST",
      o2: "O2",
      margin: "MARGIN and reserve",
    },
    missing: "missing",
    totalMissing: "total distance: data missing",
    total: (d) => `${d} total`,
  },

  example: {
    instrument: "example parameter",
    source: "Frontend example planner (src/api/routeFixture.ts)",
    assumptions: (p) => [
      `Constant walking speed of ${p.walkSpeedKmh} km/h`,
      `${p.o2Hours} h of O2 and ${p.batteryHours} h of battery, linear consumption`,
      "Values chosen to exercise the interface, not from a real suit",
    ],
    doseAssumptions: (msvPerDay) => [
      `Baseline rate measured at Gale (${msvPerDay} mSv/day), constant along the route`,
      "No terrain shielding or solar events",
    ],
    straightLine: "Straight-line leg: the example doesn't avoid obstacles",
    missingDtm: "Missing: needs the DTM processed by the pipeline",
    dark: (from, to) => `Outside the daylight window (${from}:00–${to}:00 local solar time).`,
    noReserveO2: (min) => `O2 doesn't leave the minimum ${min} min reserve on arrival.`,
    noReserveBattery: (min) => `The battery doesn't leave the minimum ${min} min reserve on arrival.`,
    goO2: "It's enough. O2 runs out first.",
    goBattery: "It's enough. The battery runs out first.",
  },

  api: {
    responded: (path, status) => `${path} returned ${status}`,
    contract: (path, m) => `${path} doesn't match the contract: ${m}`,
    photosResponded: (status) => `photos: the server returned ${status}`,
    photosContract: (m) => `photos: doesn't match the contract: ${m}`,
  },
};
