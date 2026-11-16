/**
 * Diccionario español → inglés para el texto que viene como dato: lo que manda la API
 * (resumen del veredicto, notas, supuestos, fuentes), los JSON del pipeline y las
 * constantes de datos del frontend. Lo usa translate.ts.
 *
 * Generado a mano desde los textos de api/, pipeline/ y web/src. Si una frase del
 * backend cambia y no está acá, se muestra en español (no se inventa una traducción).
 */

type Tr = (s: string) => string;
type Fn = (m: RegExpExecArray, tr: Tr) => string | null;

/** Decimal con coma (como lo escribe el backend) → con punto. */
const n = (s: string): string => s.replace(/(\d),(\d)/g, "$1.$2");

/** "Batería usada" → "battery used": minúscula solo si la palabra no es una sigla. */
const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

let lower: Map<string, string> | null = null;
/** Una etiqueta que el backend pasó a minúscula ("falla en: salir 30 min tarde"). */
function lowerTr(s: string): string {
  if (!lower) {
    lower = new Map();
    for (const [k, v] of Object.entries(EXACT)) lower.set(k.toLowerCase(), lowerFirst(v));
  }
  return lower.get(s) ?? s;
}

/** "del minuto 3 al 20, entre el km 0,4 y el 1,2 del recorrido" */
function whereEn(s: string): string {
  const m = /^del minuto (\d+) al (\d+)(?:, entre el km (.+) y el (.+) del recorrido)?$/.exec(s);
  if (!m) return s;
  return `from minute ${m[1]} to ${m[2]}${m[3] ? `, between km ${n(m[3])} and ${n(m[4]!)} of the route` : ""}`;
}

/** "despliegue y vuelos 1, 2 y 5" */
function landingsEn(s: string): string {
  return s
    .replace(/\bdespliegue\b/g, "deployment")
    .replace(/\bvuelos\b/g, "flights")
    .replace(/\bvuelo\b/g, "flight")
    .replace(/ y /g, " and ");
}

/** "a 12 m" / "a distancia desconocida" */
function farEn(s: string): string {
  if (s === "a distancia desconocida") return "at an unknown distance";
  const m = /^a (.+) m$/.exec(s);
  return m ? `${n(m[1]!)} m away` : s;
}

const PHRASE: Record<string, string> = {
  "la pendiente": "the slope",
  "la reserva de O2": "the O2 reserve",
  "la reserva de batería": "the battery reserve",
  "el regreso antes del atardecer": "returning before sunset",
  "el tiempo sin contacto con el hábitat": "time without contact with the habitat",
  "la dosis de radiación": "the radiation dose",
  "las calorías": "calories",
  "nada evaluable": "nothing evaluable",
};

function headEn(s: string, tr: Tr): string | null {
  let m = /^No va: se rompe el límite de (.+?)\.(?: (.+))?$/s.exec(s);
  if (m) return `No go: the ${lowerTr(m[1]!)} limit is broken.${m[2] ? ` ${tr(m[2])}` : ""}`;
  m = /^(Va con cuidado|Va): limita (.+?)\. Robusta en (\d+) de (\d+) escenarios(?: \((\d+) sin modelo para evaluarlos\))?\.$/.exec(s);
  if (m) {
    const head = m[1] === "Va" ? "Go" : "Go with caution";
    const skipped = m[5] ? ` (${m[5]} with no model to evaluate them)` : "";
    return `${head}: limited by ${PHRASE[m[2]!] ?? m[2]}. Robust in ${m[3]} of ${m[4]} scenarios${skipped}.`;
  }
  m = /^No va: (.+)$/s.exec(s);
  if (m) return `No go: ${tr(m[1]!)}`;
  return null;
}

function reasonEn(r: string): string {
  let m = /^puntaje (.+) < (.+)$/.exec(r);
  if (m) return `score ${m[1]} < ${m[2]}`;
  m = /^falla en: (.+)$/.exec(r);
  if (m) return `fails in: ${m[1]!.split(", ").map(lowerTr).join(", ")}`;
  m = /^sin evaluar del todo: (.+)$/.exec(r);
  if (m) return `not fully evaluated: ${m[1]!.split(", ").map(lowerTr).join(", ")}`;
  return r;
}

function caveatEn(c: string, tr: Tr): string {
  let m = /^calculada con ajustes del usuario \((.+)\)$/.exec(c);
  if (m) {
    const items = m[1]!.split(", ").map((it) => {
      const x = /^(.+?) (-?[\d.]+(?:e-?\d+)?)( .+)?$/.exec(it);
      return x ? `${tr(x[1]!)} ${x[2]}${x[3] ?? ""}` : it;
    });
    return `computed with user settings (${items.join(", ")})`;
  }
  m = /^no se evaluó la luz: no se pudo leer la pila de sombras del sol (.+)$/.exec(c);
  if (m) return `daylight wasn't evaluated: the shadow stack for sol ${m[1]} couldn't be read`;
  m = /^no se evaluó la luz: falta la pila de sombras de ese sol y no hay otra de la misma estación \(±(.+)° Ls\)$/.exec(c);
  if (m) return `daylight wasn't evaluated: that sol's shadow stack is missing and there's no other from the same season (±${n(m[1]!)}° Ls)`;
  m = /^la luz se estimó con las sombras del sol (\S+), de la misma estación \(ΔLs (.+)°\)$/.exec(c);
  if (m) return `daylight was estimated with the shadows of sol ${m[1]}, from the same season (ΔLs ${n(m[2]!)}°)`;
  return tr(c);
}

/** Resumen del veredicto: "Va: limita … Cuidado: …; … Ojo: …; …." */
function summaryEn(s: string, tr: Tr): string | null {
  let rest = s;
  let ojo = "";
  let cuidado = "";
  const io = rest.lastIndexOf(" Ojo: ");
  if (io >= 0) {
    ojo = rest.slice(io + 6).replace(/\.$/, "");
    rest = rest.slice(0, io);
  }
  const ic = rest.lastIndexOf(" Cuidado: ");
  if (ic >= 0) {
    cuidado = rest.slice(ic + 10).replace(/\.$/, "");
    rest = rest.slice(0, ic);
  }
  const head = headEn(rest, tr);
  if (head === null) return null;
  let out = head;
  if (cuidado) out += ` Caution: ${cuidado.split("; ").map(reasonEn).join("; ")}.`;
  if (ojo) out += ` Note: ${ojo.split("; ").map((c) => caveatEn(c, tr)).join("; ")}.`;
  return out;
}

export const EXACT: Readonly<Record<string, string>> = {
  "0,1 a 0,5: indicio débil": "0.1 to 0.5: weak indication",
  "0,5 a 1: consistente con hielo": "0.5 to 1: consistent with ice",
  "0–10° transitable": "0–10° passable",
  "1 m/px (suelo suelto: 100 m/px)": "1 m/px (loose ground: 100 m/px)",
  "10–20° con cuidado": "10–20° with care",
  "13,3–20 µSv/h": "13.3–20 µSv/h",
  "20–25° límite del rover": "20–25° rover limit",
  "6,7–13,3 µSv/h": "6.7–13.3 µSv/h",
  "75–85 % (refugio)": "75–85 % (shelter)",
  "< 6,7 µSv/h": "< 6.7 µSv/h",
  "> 25° no transitable": "> 25° impassable",
  "> 97 % cielo abierto": "> 97 % open sky",
  "A* sobre la pendiente del DTM (api/planner.py)": "A* over the DTM slope (api/planner.py)",
  "Aeródromos del helicóptero (MMGIS)": "Helicopter airfields (MMGIS)",
  "Ajustes": "Settings",
  "Alcanza. Lo que se acaba primero es el O2.": "It is enough. What runs out first is the O2.",
  "Alcanza. Lo que se acaba primero es la batería.": "It is enough. What runs out first is the battery.",
  "Algoritmo Mars24 (Allison & McEwen 2000), calculado en el navegador": "Mars24 algorithm (Allison & McEwen 2000), calculated in the browser",
  "Allton 1989 (JSC-23454), ficha del taladro": "Allton 1989 (JSC-23454), drill sheet",
  "Allton 1989 (JSC-23454), tabla de Apollo 16": "Allton 1989 (JSC-23454), Apollo 16 table",
  "Allton 1989, Catalog of Apollo Lunar Surface Geological Sampling Tools and Containers (JSC-23454), tabla de Apollo 17": "Allton 1989, Catalog of Apollo Lunar Surface Geological Sampling Tools and Containers (JSC-23454), Apollo 17 table",
  "Alturas sobre el punto más bajo del DTM (datum_m): la forma es la real, el cero no.": "Heights above the DTM's lowest point (datum_m): the shape is real, the zero isn't.",
  "Alturas sobre el punto más bajo del recorte (datum_m), igual que relief-dem.": "Heights above the crop's lowest point (datum_m), same as relief-dem.",
  "Amanecer con terreno (minutos LTST)": "Sunrise with terrain (LTST minutes)",
  "Amanecer y atardecer: los de ese sol, a la misma hora solar local": "Sunrise and sunset: those of that sol, at the same local solar time",
  "Apollo Lunar Surface Drill, total de sus 4 componentes": "Apollo Lunar Surface Drill, total of its 4 components",
  "Astronauta": "Astronaut",
  "Atardecer con terreno (minutos LTST)": "Sunset with terrain (LTST minutes)",
  "Atardecer sobre horizonte plano": "Sunset over a flat horizon",
  "Atardecer sobre horizonte plano, del index.json de la pila de sombras": "Sunset over a flat horizon, from the shadow stack's index.json",
  "Azimut y elevación del Sol calculados en el centro del DTM y aplicados a todo el DTM.": "Sun azimuth and elevation computed at the DTM center and applied to the whole DTM.",
  "Base medida por MSL RAD en Gale (Hassler et al. 2014, reference/rad_surface_dose.json), modulada por sky-view del terreno": "Baseline measured by MSL RAD at Gale (Hassler et al. 2014, reference/rad_surface_dose.json), modulated by the terrain sky-view",
  "Base: 0,64 ± 0,12 mSv/día (26,7 µSv/h), medida en Gale en 2012–2013; varía con el ciclo solar, la presión estacional y eventos solares": "Baseline: 0.64 ± 0.12 mSv/day (26.7 µSv/h), measured at Gale in 2012–2013; it varies with the solar cycle, seasonal pressure and solar events",
  "Batería": "Battery",
  "Bolsa de recolección de muestras (SCB 1)": "Sample collection bag (SCB 1)",
  "CRISM MTRDR browse, parámetros de resumen (Viviano-Beck et al. 2014), PDS Geosciences": "CRISM MTRDR browse, summary parameters (Viviano-Beck et al. 2014), PDS Geosciences",
  "Calculado por el pipeline desde el DTM HiRISE (USGS)": "Calculated by the pipeline from the HiRISE DTM (USGS)",
  "Calculado por el pipeline desde el DTM HiRISE (USGS) y el IR nocturno de THEMIS": "Calculated by the pipeline from the HiRISE DTM (USGS) and THEMIS nighttime IR",
  "Calculado por el pipeline desde el DTM HiRISE (USGS) y la capa de refugios": "Calculated by the pipeline from the HiRISE DTM (USGS) and the shelters layer",
  "Calorías": "Calories",
  "Calorías por EVA": "Calories per EVA",
  "Caminar un 20 % más lento": "Walk 20 % slower",
  "Caminata de Tobler (1993) escalada a 0,8 m/s en plano": "Tobler (1993) hiking function scaled to 0.8 m/s on flat ground",
  "Campo magnético del sitio": "Site magnetic field",
  "Capacidad de O2": "O2 capacity",
  "Capacidad del traje menos la reserva · EMU de la ISS (docs/consumibles del traje.md)": "Suit capacity minus the reserve · ISS EMU (docs/consumibles del traje.md)",
  "Carga escrita a mano en el planificador": "Load typed by hand in the planner",
  "Cielo visible": "Visible sky",
  "Combina neutrones, térmico, geomorfología y radar con los pesos del equipo de SWIM": "Combines neutrons, thermal, geomorphology and radar with the SWIM team's weights",
  "Combina neutrones, térmico, geomorfología y radar con los pesos del equipo de SWIM.": "Combines neutrons, thermal, geomorphology and radar with the SWIM team's weights.",
  "Composite de consistencia de hielo 0-1 m de SWIM 2.0 (Putzig, Morgan et al. 2020, PSI), recortado al DTM sin remuestrear": "SWIM 2.0 0-1 m ice consistency composite (Putzig, Morgan et al. 2020, PSI), cropped to the DTM without resampling",
  "Composite de consistencia de hielo 0–1 m de SWIM 2.0 (Putzig, Morgan et al. 2020, PSI), recortado al sitio sin remuestrear": "SWIM 2.0 0–1 m ice consistency composite (Putzig, Morgan et al. 2020, PSI), clipped to the site without resampling",
  "Con el brazo estirado, un dedo tapa unos 2° y un puño unos 10°": "With your arm outstretched, a finger covers about 2° and a fist about 10°",
  "Consumo base": "Base power draw",
  "Copia del DTM de USGS en COG: mismo dato y misma grilla, solo cambia el formato.": "Copy of the USGS DTM as a COG: same data and grid, only the format changes.",
  "Criterio relativo del equipo: marca lo más frío del sitio, no arena confirmada.": "The team's relative criterion: it marks the coldest part of the site, not confirmed sand.",
  "Cráter sin nombre (catálogo de Robbins)": "Unnamed crater (Robbins catalog)",
  "Cráteres de Robbins & Hynek 2012": "Robbins & Hynek 2012 craters",
  "Cuenta márgenes, no es una probabilidad": "It counts margins, it isn't a probability",
  "Curvas de nivel": "Contour lines",
  "Cuánto evita la ruta cada cosa al elegir el camino. 0 = no le importa.": "How much the route avoids each thing when choosing the path. 0 = it does not care.",
  "Cuánto evita la sombra (frío) a la hora de paso.": "How much it avoids shadow (cold) at the time of passage.",
  "Cuánto prefiere la ruta el terreno plano.": "How much the route prefers flat terrain.",
  "Cuánto prefiere quedar a la vista del hábitat.": "How much it prefers staying in view of the habitat.",
  "Cálculo en el navegador (src/mars/geo.ts)": "Calculated in the browser (src/mars/geo.ts)",
  "Cámara": "Camera",
  "DEM 200 m de Gale (sin el DTM)": "Gale 200 m DEM (without the DTM)",
  "DEM fusionado de 1 m de USGS (~107 x 33 km) a lo largo del traverse de Curiosity y la base de Mount Sharp. Donde no hay estéreo HiRISE se completó con CTX/HRSC/MOLA: verificar la resolución real en la zona elegida para la ruta de ejemplo.": "USGS 1 m merged DEM (~107 x 33 km) along Curiosity's traverse and the base of Mount Sharp. Where there's no HiRISE stereo it was filled with CTX/HRSC/MOLA: check the real resolution in the area chosen for the sample route.",
  "DTM HiRISE 1 m del Terrain Relative Navigation de Mars 2020 (~21 x 21 km).": "1 m HiRISE DTM from Mars 2020 Terrain Relative Navigation (~21 x 21 km).",
  "DTM HiRISE 1 m del Terrain Relative Navigation de Mars 2020 (~21 x 21 km): cubre el piso del cráter, el frente del delta y el depósito Three Forks.": "Mars 2020 Terrain Relative Navigation 1 m HiRISE DTM (~21 x 21 km): covers the crater floor, the delta front and the Three Forks depot.",
  "DTM de 1 m remuestreado a ~2,5 m/px para dibujar": "1 m DTM resampled to ~2.5 m/px for drawing",
  "De lejos solo se dibujan las curvas cada 50 m; las de 10 m aparecen al acercarse": "From afar only the 50 m contours are drawn; the 10 m ones appear when zooming in",
  "De noche (Sol bajo el horizonte plano), un velo sobre todo el sitio": "At night (Sun below the flat horizon), a veil over the whole site",
  "De noche la roca guarda el calor y se ve tibia; la arena y el polvo se enfrían rápido y se ven fríos": "At night rock keeps its heat and looks warm; sand and dust cool quickly and look cold",
  "Declinación por Ls y ángulo horario por hora solar verdadera local: error de décimas de grado": "Declination from Ls and hour angle from local true solar time: error of tenths of a degree",
  "Depósito de muestras": "Sample depot",
  "Desde 25° no se pisa (el corte único del mapa)": "From 25° it is not walked (the map's single cutoff)",
  "Dispensador de 20 bolsas documentadas": "Dispenser of 20 documented sample bags",
  "Distancia sobre la superficie en línea recta, sin relieve": "Straight-line distance over the surface, ignoring relief",
  "Dosis (capa secundaria)": "Dose (secondary layer)",
  "Dosis de radiación": "Radiation dose",
  "Dosis de radiación máxima por EVA.": "Maximum radiation dose per EVA.",
  "Dosis de radiación por EVA": "Radiation dose per EVA",
  "Duración del tramo (api/consumables.py) repartida por distancia": "Leg duration (api/consumables.py) split by distance",
  "EMU completo con mochila (PLSS).": "Full EMU with backpack (PLSS).",
  "Eficiencia de batería": "Battery efficiency",
  "El DTM de este sitio todavía no está descargado.": "This site's DTM isn't downloaded yet.",
  "El DTM no tiene ninguna celda completa con dato": "The DTM has no complete cell with data",
  "El Sol se mueve unos 15° por hora: vale para la hora de paso estimada": "The Sun moves about 15° per hour: valid for the estimated time of passage",
  "El composite de SWIM no se superpone con el DTM del sitio.": "The SWIM composite doesn't overlap the site's DTM.",
  "El corte de rugosidad más bajo (σ 0,15 m) está cerca de la precisión vertical del DTM (decenas de cm).": "The lowest roughness cut (σ 0.15 m) is close to the DTM's vertical precision (tens of cm).",
  "El hidrógeno de minerales hidratados también sube el índice: un positivo débil no confirma hielo": "Hydrogen in hydrated minerals also raises the index: a weak positive does not confirm ice",
  "El hidrógeno de minerales hidratados también sube el índice: un valor positivo débil no confirma hielo.": "Hydrogen in hydrated minerals also raises the index: a weak positive value doesn't confirm ice.",
  "El hábitat cae fuera del DTM: no se puede calcular la línea de vista.": "The habitat falls outside the DTM: line of sight can't be computed.",
  "El hábitat cae fuera del terreno de 1 m real (DTM HiRISE): borré la travesía. Marcá el hábitat de nuevo, adentro del contorno.": "The habitat falls outside the real 1 m terrain (HiRISE DTM): I cleared the traverse. Mark the habitat again, inside the outline.",
  "El hábitat que marcaste como salida en el planificador": "The habitat you marked as departure in the planner",
  "El navegador no deja leer píxeles (OffscreenCanvas 2D)": "The browser does not allow reading pixels (OffscreenCanvas 2D)",
  "El nomenclátor IAU todavía no está descargado (download.py)": "The IAU gazetteer isn't downloaded yet (download.py)",
  "El número solo las ordena por intensidad": "The number only ranks them by intensity",
  "El peligro de terreno salió sin THEMIS: no distingue roca de arena suelta.": "The terrain hazard came out without THEMIS: it doesn't tell rock from loose sand.",
  "El polvo fino y la arena se ven igual de fríos: los dos hunden el paso.": "Fine dust and sand look equally cold: both sink your step.",
  "El punto está en el borde del DTM": "The point is at the edge of the DTM",
  "El recorte de THEMIS no se superpone con el DTM del sitio.": "The THEMIS crop doesn't overlap the site's DTM.",
  "El recorte de THEMIS no tiene datos sobre el DTM.": "The THEMIS crop has no data over the DTM.",
  "El terreno promediado no ve obstáculos más chicos que su celda (rocas, dunas chicas)": "The averaged terrain doesn't see obstacles smaller than its cell (rocks, small dunes)",
  "El valor depende de ese largo: a mayor distancia, pendiente más suave": "The value depends on that length: the longer the distance, the gentler the slope",
  "Elevación sobre el horizonte plano; si el relieve tapa el Sol se dice aparte": "Elevation above the flat horizon; if the relief blocks the Sun it is stated separately",
  "En el mapa, brillo estirado entre el p2 y el p98 del sitio y en cuadros de 100 m (vecino más cercano); el COG guarda los DN originales.": "On the map, brightness stretched between the site's p2 and p98 in 100 m squares (nearest neighbor); the COG keeps the original DN.",
  "En el mapa, brillo estirado entre el p2 y el p98 del sitio y en cuadros de 100 m, sin interpolar": "On the map, brightness stretched between the site's p2 and p98, in 100 m cells, without interpolation",
  "Energía nominal.": "Nominal energy.",
  "Es el punto más fuerte de la observación: alrededor puede haber más terreno con la misma señal": "It's the strongest point of the observation: there may be more terrain with the same signal around it",
  "Es la posición del rover al soltar el tubo, no la del tubo: el tubo quedó al alcance del brazo.": "It's the rover's position when dropping the tube, not the tube's: the tube was left within arm's reach.",
  "Escala vertical real: se corrige que MapLibre mide con el radio de la Tierra": "True vertical scale: corrected because MapLibre measures with Earth's radius",
  "Escala, vertical y color en cada foto de muestra": "Scale, vertical and color in every sample photo",
  "Ese punto no tiene terreno de 1 m real (DTM HiRISE): no se puede planificar ahí. Elegí uno dentro del área cubierta.": "That point has no real 1 m terrain (HiRISE DTM): you cannot plan there. Pick one inside the covered area.",
  "Eslabón más débil: 100 · min(1 − usado/límite) sobre los límites duros (api/safety.py)": "Weakest link: 100 · min(1 − used/limit) over the hard limits (api/safety.py)",
  "Evitar pendiente": "Avoid slope",
  "Evitar sombra": "Avoid shadow",
  "Factor de terreno": "Terrain factor",
  "Falta dem200_crop.tif: el horizonte lejano (más allá del DTM) no se incluye, así que el sky-view sale más alto de lo real.": "dem200_crop.tif is missing: the far horizon (beyond the DTM) isn't included, so the sky-view comes out higher than real.",
  "Falta el DTM del sitio (precompute.py)": "The site's DTM is missing (precompute.py)",
  "Falta el DTM para la línea de vista.": "The DTM for line of sight is missing.",
  "Falta el DTM procesado del sitio (pipeline/precompute.py): no se puede calcular la línea de vista al hábitat.": "The site's processed DTM is missing (pipeline/precompute.py): line of sight to the habitat can't be computed.",
  "Falta el endpoint de fotos del server (MAP-33): todavía no hay fotos reales para mostrar.": "The server's photos endpoint is missing (MAP-33): there are no real photos to show yet.",
  "Falta el paso del pipeline que baje la última observación": "Missing the pipeline step that downloads the latest observation",
  "Falta el terreno para calcular la línea de vista": "The terrain to compute line of sight is missing",
  "Falta la pila de sombras de ese sol.": "That sol's shadow stack is missing.",
  "Falta la pila de sombras de ese sol: no se sabe la hora del atardecer.": "That sol's shadow stack is missing: the sunset time is unknown.",
  "Falta la tasa de dosis de referencia.": "The reference dose rate is missing.",
  "Falta reference/rad_surface_dose.json": "Missing reference/rad_surface_dose.json",
  "Falta slope.tif: no se evaluó el terreno.": "slope.tif is missing: the terrain wasn't evaluated.",
  "Falta: requiere el DTM procesado por el pipeline": "Missing: requires the DTM processed by the pipeline",
  "Falta: requiere el catálogo de landmarks del pipeline y la línea de vista de /api/route": "Missing: requires the pipeline landmark catalog and the line of sight from /api/route",
  "Fe/Mg-filosilicatos": "Fe/Mg phyllosilicates",
  "Fixtures locales: el backend no está conectado.": "Local fixtures: the backend is not connected.",
  "Fracción de celdas de la ruta en sombra a la hora estimada de paso": "Share of route cells in shadow at the estimated time of passage",
  "Fuga de O2": "O2 leak",
  "Gatillo, empuñadura y soporte (0,6 lb)": "Trigger, handle and bracket (0.6 lb)",
  "Gazetteer of Planetary Nomenclature (IAU/USGS), centro del rasgo": "Gazetteer of Planetary Nomenclature (IAU/USGS), feature center",
  "Hasselblad de 70 mm con lente, empuñadura y un cargador": "70 mm Hasselblad with lens, handle and one magazine",
  "Hasselblad eléctrica de datos (3,1 lb)": "Hasselblad electric data camera (3.1 lb)",
  "Hassler et al. 2014 (reference/rad_surface_dose.json)": "Hassler et al. 2014 (reference/rad_surface_dose.json)",
  "Herramienta de Apollo como referencia: un kit para Marte puede pesar distinto": "Apollo tool as a reference: a kit for Mars may weigh differently",
  "HiRISE (DTM)": "HiRISE (DTM)",
  "HiRISE es la cámara del Mars Reconnaissance Orbiter: fotografía Marte desde la órbita con detalle de menos de un metro.": "HiRISE is the Mars Reconnaissance Orbiter's camera: it photographs Mars from orbit with sub-meter detail.",
  "HiRISE orthomosaic 25 cm (MRO HiRISE, USGS), misma proyección que el DTM": "HiRISE orthomosaic 25 cm (MRO HiRISE, USGS), same projection as the DTM",
  "Hielo somero (SWIM, 0–1 m)": "Shallow ice (SWIM, 0–1 m)",
  "Hillshade": "Hillshade",
  "Hora del reloj de esta computadora": "Time from this computer's clock",
  "Hora solar verdadera local en la longitud de cada punto": "Local true solar time at each point's longitude",
  "Horizonte plano; el Sol se mueve unos 15° por hora: vale para la hora de paso": "Flat horizon; the Sun moves about 15° per hour: valid for the time of passage",
  "Iluminación sintética fija: no es la luz real del momento": "Fixed synthetic illumination: not the real light of the moment",
  "Iluminación sintética fija: no es la luz real del momento.": "Fixed synthetic lighting: not the real light at the moment.",
  "Imagen real, sin realce. Recortada al bbox del sitio.": "Real image, no enhancement. Cropped to the site's bbox.",
  "Inventario de los productos de óxidos de PIXL; fetch_targets.py saca de cada etiqueta el nombre del objetivo (PDS Geosciences Node)": "Inventory of PIXL oxide products; fetch_targets.py takes the target name from each label (PDS Geosciences Node)",
  "Junta piedritas de 1 a 2 cm del regolito": "Collects 1 to 2 cm pebbles from the regolith",
  "Kit de muestras": "Sample kit",
  "La capa existe (loose_soil.tif, THEMIS de noche) pero el A* todavía no la lee: hoy solo refuerza el peligro de terreno del mapa.": "The layer exists (loose_soil.tif, night-time THEMIS) but the A* doesn't read it yet: today it only reinforces the map's terrain hazard.",
  "La capa existe (roughness.tif) pero el A* todavía no la lee.": "The layer exists (roughness.tif) but the A* doesn't read it yet.",
  "La descarga de datos todavía no terminó.": "The data download hasn't finished yet.",
  "La diferencia entre lugares es menor que la incertidumbre de la medición: lo que pesa es el tiempo afuera (presupuesto de la travesía)": "The difference between places is smaller than the measurement uncertainty: what matters is the time outside (traverse budget)",
  "La dosis por celda (survival-dose) varía menos que la incertidumbre de RAD: entra en el presupuesto de dosis de la travesía, no en el costo del A*.": "Per-cell dose (survival-dose) varies less than RAD's uncertainty: it goes into the traverse's dose budget, not the A* cost.",
  "La masa transportada supera la del astronauta (L/W > 1): Pandolf se validó con cargas menores, el término de carga puede sobreestimar.": "The carried mass exceeds the astronaut's (L/W > 1): Pandolf was validated with lighter loads, so the load term may overestimate.",
  "La pendiente de slope.tif es por píxel: no ve escalones más chicos que el píxel": "slope.tif slope is per pixel: it doesn't see steps smaller than a pixel",
  "La ruta queda fuera de la capa de dosis por terreno": "The route falls outside the terrain dose layer",
  "La salida es el hábitat": "The start is the habitat",
  "Lente de 60 mm (1,7 lb)": "60 mm lens (1.7 lb)",
  "Lista de observaciones de ChemCam: objetivo, tipo, sol, site/drive del rover y distancia (MSL ChemCam LIBS RDR, PDS Geosciences Node)": "ChemCam observation list: target, type, sol, rover site/drive and distance (MSL ChemCam LIBS RDR, PDS Geosciences Node)",
  "Lista maestra de observaciones de SuperCam: objetivo, tipo, sol, site/drive del rover (en el nombre del EDR) y distancia de foco (PDS Geosciences Node)": "SuperCam master observation list: target, type, sol, rover site/drive (in the EDR name) and focus distance (PDS Geosciences Node)",
  "Llevar un 10 % más de carga": "Carry 10 % more load",
  "Lo eligió el equipo, sin una fuente que lo respalde todavía. Tomalo como una regla de juego, no como un dato.": "The team chose it, with no source backing it yet. Treat it as a rule of the game, not as data.",
  "Lo midió un instrumento, desde la órbita o en la superficie de Marte. Es lo más parecido a un dato directo, con el error propio del instrumento.": "An instrument measured it, from orbit or on the surface of Mars. It is the closest thing to direct data, with the instrument's own error.",
  "Localización del equipo del rover publicada en MMGIS (mars.nasa.gov)": "Rover team localization published in MMGIS (mars.nasa.gov)",
  "Longitud del centro del sitio": "Longitude of the site center",
  "Los cráteres de Robbins todavía no están (fetch_extras.py)": "The Robbins craters aren't there yet (fetch_extras.py)",
  "Los valores de los límites (o la parte que los arma, como la reserva o el margen antes del atardecer) son del equipo, ver docs/seguridad.md": "The limit values (or the part that builds them, like the reserve or the margin before sunset) were chosen by the team, see docs/seguridad.md",
  "Los waypoints del rover todavía no están descargados (download.py)": "The rover waypoints aren't downloaded yet (download.py)",
  "Límites del veredicto": "Verdict limits",
  "Línea de vista al hábitat sobre el DTM (api/contact.py) y tiempos de caminata": "Line of sight to the habitat over the DTM (api/contact.py) and walking times",
  "Línea de vista al hábitat sobre el DTM (api/contact.py), la misma que usa el planificador": "Line of sight to the habitat over the DTM (api/contact.py), the same one the planner uses",
  "Línea de vista al mástil del hábitat (api/contact.py), desde el punto A marcado": "Line of sight to the habitat mast (api/contact.py), from the marked point A",
  "MOLA + HRSC blended DEM global 200 m (MGS MOLA + Mars Express HRSC, USGS). Se recorta por sitio con lectura remota; no se descarga entero (~11 GB).": "MOLA + HRSC blended DEM global 200 m (MGS MOLA + Mars Express HRSC, USGS). Cropped per site with remote reads; not downloaded whole (~11 GB).",
  "MOLA DEM global 463 m (MGS MOLA, USGS). Solo altimetría láser, sin mezcla HRSC; se recorta por sitio con lectura remota (~2,1 GB entero).": "MOLA DEM global 463 m (MGS MOLA, USGS). Laser altimetry only, no HRSC blend; cropped per site with remote reads (~2.1 GB whole).",
  "Manda la peor entre la clase de pendiente y la de rugosidad σ (desvío estándar del relieve en 5 m, sin la tendencia)": "The worse of the slope class and the roughness class σ wins (standard deviation of the relief over 5 m, detrended)",
  "Mandá ltst o band (uno de los dos)": "Send ltst or band (one of the two)",
  "Mango de extensión largo": "Long extension handle",
  "Mantener contacto": "Keep contact",
  "Margen antes del atardecer": "Margin before sunset",
  "Mars24 es el reloj marciano de la NASA (Goddard Institute for Space Studies).": "Mars24 is NASA's Mars clock (Goddard Institute for Space Studies).",
  "Martillo geológico": "Geological hammer",
  "Martillo pesado": "Heavy hammer",
  "Masa sin traje.": "Mass without the suit.",
  "Minutos al refugio": "Minutes to shelter",
  "Minutos al refugio fuerte": "Minutes to strong shelter",
  "Minutos seguidos sin contacto": "Consecutive minutes without contact",
  "Minutos seguidos sin línea de vista al hábitat.": "Consecutive minutes without line of sight to the habitat.",
  "Mosaico controlado del IR nocturno de THEMIS (USGS Astrogeology / ASU), recortado al DTM sin remuestrear": "Controlled THEMIS night-time IR mosaic (USGS Astrogeology / ASU), cropped to the DTM without resampling",
  "Mosaico controlado del IR nocturno de THEMIS (USGS Astrogeology / ASU), recortado al sitio sin remuestrear": "THEMIS nighttime IR controlled mosaic (USGS Astrogeology / ASU), clipped to the site without resampling",
  "Muestras juntadas u otro equipo; el planificador no la verifica": "Collected samples or other equipment; the planner does not verify it",
  "Más tibio de noche = roca o suelo compacto; más frío = arena, polvo o grano fino.": "Warmer at night = rock or compact soil; colder = sand, dust or fine grains.",
  "Mástil de 3 m sobre el suelo (api/contact.py)": "3 m mast above the ground (api/contact.py)",
  "Máximo sin contacto": "Max without contact",
  "Máximos locales del DTM del sitio (pipeline/places.py, kind landmark)": "Local maxima of the site DTM (pipeline/places.py, kind landmark)",
  "Máximos locales del DTM del sitio (precompute.py)": "Local maxima of the site's DTM (precompute.py)",
  "Mínimos locales del DTM del sitio (precompute.py)": "Local minima of the site's DTM (precompute.py)",
  "NAIF SPICE (spiceypy) vía pipeline/sun_geometry.py": "NAIF SPICE (spiceypy) via pipeline/sun_geometry.py",
  "Navegar": "Navigate",
  "Ningún límite duro depende hoy del refugio y los refugios todavía no entran al planificador.": "No hard limit depends on shelters today, and shelters aren't in the planner yet.",
  "Ningún tramo se resolvió sobre el terreno.": "No leg was solved over the terrain.",
  "No distingue roca firme de arena suelta.": "It doesn't tell solid rock from loose sand.",
  "No están ni contours.gpkg ni contours.geojson: hay que correr precompute.py completo.": "Neither contours.gpkg nor contours.geojson exists: precompute.py has to be run in full.",
  "No hay altura del terreno en este punto: queda fuera del DTM y del DEM de 200 m.": "There is no terrain height at this point: it is outside the DTM and the 200 m DEM.",
  "No hay modelo térmico del traje: el frío no cambia ningún límite que podamos calcular. No se inventa el efecto.": "There's no thermal model of the suit: cold doesn't change any limit we can compute. The effect isn't made up.",
  "No incluye los neutrones que rebotan en el suelo.": "Doesn't include neutrons bouncing off the ground.",
  "No se movió: ahí no hay terreno de 1 m real (DTM HiRISE).": "It did not move: there is no real 1 m terrain there (HiRISE DTM).",
  "No se pudo calcular el sky-view de Bradbury Landing (faltan los datos de Gale): la dosis no está normalizada y sale hasta ~8 % más baja.": "Bradbury Landing's sky-view couldn't be computed (Gale data missing): the dose isn't normalized and comes out up to ~8 % lower.",
  "No se pudo evaluar qué se ve (falta terreno en este trecho)": "Couldn't evaluate what's visible (terrain missing on this stretch)",
  "No se pudo leer la pila de sombras en alguna hora: el tramo no tuvo en cuenta la sombra": "The shadow stack couldn't be read at some hour: the leg didn't account for shadow",
  "Nomenclátor IAU": "IAU gazetteer",
  "Nomenclátor IAU/USGS": "IAU/USGS Gazetteer",
  "Normalizada para dar exactamente la base en Bradbury Landing, donde midió RAD": "Normalized to give exactly the baseline at Bradbury Landing, where RAD measured",
  "Normalizada para dar exactamente la base en Bradbury Landing, donde midió RAD.": "Normalized to give exactly the baseline at Bradbury Landing, where RAD measured.",
  "O2 primario de la mochila.": "Primary O2 in the backpack.",
  "O2 y batería que tienen que sobrar al terminar (0,2 = 20 %).": "O2 and battery that must be left over at the end (0.2 = 20 %).",
  "Objetivos de APXS soles 0–3076 con posición medida, estratigrafía y región (suplemento de Thompson et al. 2022, PDS Geosciences Node)": "APXS targets sols 0–3076 with measured position, stratigraphy and region (Thompson et al. 2022 supplement, PDS Geosciences Node)",
  "Objetivos de APXS soles 3054–3712 con posición medida, estratigrafía y región (suplemento 2024, PDS Geosciences Node)": "APXS targets sols 3054–3712 with measured position, stratigraphy and region (2024 supplement, PDS Geosciences Node)",
  "Opacidad de polvo (τ)": "Dust opacity (τ)",
  "Ortoimagen": "Orthoimage",
  "Ortomosaico HiRISE (USGS)": "HiRISE orthomosaic (USGS)",
  "Oxígeno": "Oxygen",
  "PDS Geosciences Node, listas de observaciones de los instrumentos": "PDS Geosciences Node, instrument observation lists",
  "PDS Geosciences Node, listas de observaciones de los instrumentos; posición del rover de MMGIS por site y drive": "PDS Geosciences Node, instrument observation lists; rover position from MMGIS by site and drive",
  "Pala grande ajustable": "Large adjustable scoop",
  "Pala, pinzas, mango largo, bolsa de recolección y 20 bolsitas": "Scoop, tongs, long handle, collection bag and 20 small bags",
  "Pandolf (1977) + Santee (2001) ajustado a gravedad marciana · EMU ISS": "Pandolf (1977) + Santee (2001) adjusted to Martian gravity · ISS EMU",
  "Pandolf no modela la rigidez de un traje presurizado; el gasto real puede ser mayor.": "Pandolf doesn't model the stiffness of a pressurized suit; the real expenditure may be higher.",
  "Para sumar una parada, primero elegí el destino.": "To add a stop, first choose the destination.",
  "Parte de la energía nominal que llega a la carga.": "Share of nominal energy that reaches the load.",
  "Parte rocas y clava los tubos": "Breaks rocks and drives the tubes",
  "Peligro de terreno": "Terrain hazard",
  "Pendiente": "Slope",
  "Pendiente < 25° y al menos ~10 m² (dos o tres personas)": "Slope < 25° and at least ~10 m² (two or three people)",
  "Pendiente a la escala del DTM: no ve rocas ni escalones más chicos que el píxel.": "Slope at DTM scale: it doesn't see rocks or steps smaller than a pixel.",
  "Pendiente máxima": "Maximum slope",
  "Peor celda pisada, con la pendiente que no se puede esquivar dentro de cada celda de trabajo (la f-ésima más alta de f × f píxeles de slope.tif)": "Worst cell stepped on, with the slope that can't be avoided inside each working cell (the f-th highest of f × f pixels of slope.tif)",
  "Pesos de la ruta": "Route weights",
  "Pinzas de 32 pulgadas": "32-inch tongs",
  "Planificador de ejemplo del frontend (src/api/routeFixture.ts)": "Frontend sample planner (src/api/routeFixture.ts)",
  "Poco cielo es reparo geométrico, no una dosis calculada.": "Little sky is geometric shelter, not a computed dose.",
  "Posición del Sol con Mars24 (Allison & McEwen 2000): declinación por Ls y hora solar local": "Sun position with Mars24 (Allison & McEwen 2000): declination from Ls and local solar time",
  "Posición del objetivo medida por el equipo del rover (tabla de APXS).": "Target position measured by the rover team (APXS table).",
  "Presión": "Pressure",
  "Presupuesto de dosis": "Dose budget",
  "Primero marcá el hábitat en el mapa: es de donde salís.": "First mark the habitat on the map: it is where you leave from.",
  "Producto cualitativo de 8 bits: brillo relativo dentro del mosaico, no temperatura ni inercia térmica en unidades.": "Qualitative 8-bit product: relative brightness within the mosaic, not temperature or thermal inertia in units.",
  "Producto cualitativo de 8 bits: brillo relativo dentro del sitio, no una temperatura": "Qualitative 8-bit product: relative brightness within the site, not a temperature",
  "Promedio de la dosis por celda sobre los puntos de la ruta; la espera en las estaciones usa el mismo promedio": "Average per-cell dose over the route's points; waiting at stations uses the same average",
  "Provisorio hasta que exista el costo del planificador": "Provisional until the planner cost exists",
  "Pérdida del traje.": "Suit leakage.",
  "Píxel de ~3 km: no ubica nada más chico que eso.": "~3 km pixel: it can't locate anything smaller than that.",
  "Píxel de ~3 km: no ubica nada más chico que eso. 1–5 m y > 5 m se descartaron (docs/context.md §5)": "~3 km pixel: it cannot locate anything smaller. 1–5 m and > 5 m were discarded (docs/context.md §5)",
  "RAD es el detector de radiación del rover Curiosity, que la mide en la superficie del cráter Gale.": "RAD is the Curiosity rover's radiation detector, which measures it on the surface of Gale crater.",
  "Radiación isótropa desde el cielo: el blindaje del terreno es una cota superior": "Isotropic radiation from the sky: terrain shielding is an upper bound",
  "Radiación isótropa desde el cielo: sobreestima el blindaje del terreno (cota superior).": "Isotropic radiation from the sky: it overestimates terrain shielding (upper bound).",
  "Radiación por terreno": "Radiation by terrain",
  "Radio en línea de vista directa, sin repetidores ni difracción": "Direct line-of-sight radio, no relays or diffraction",
  "Rasgo con nombre IAU": "IAU-named feature",
  "Rastrillo": "Rake",
  "Recorrido": "Route",
  "Recortada al bbox de sites/<sitio>.json: afuera no hay imagen.": "Cropped to the bbox in sites/<site>.json: there's no image outside it.",
  "Refugio = cielo visible ≤ 85 %; fuerte = ≤ 75 %": "Shelter = visible sky ≤ 85 %; strong = ≤ 75 %",
  "Refugio fuerte = cielo visible ≤ 75 %": "Strong shelter = visible sky ≤ 75 %",
  "Refugios": "Shelters",
  "Registro absoluto de ~150-275 m (1,5 a 2,75 píxeles de THEMIS).": "Absolute registration of ~150-275 m (1.5 to 2.75 THEMIS pixels).",
  "Registro de ~150–275 m: no sirve para ubicar algo más chico que unos cientos de metros": "~150–275 m registration: not useful to locate anything smaller than a few hundred meters",
  "Regreso antes del atardecer": "Return before sunset",
  "Relieve": "Terrain",
  "Relieve exagerado x3 en vertical": "Relief exaggerated x3 vertically",
  "Reparo geométrico, no una dosis calculada": "Geometric cover, not a calculated dose",
  "Reserva al ritmo de consumo medio de la travesía": "Reserve at the traverse's average consumption rate",
  "Reserva al volver": "Reserve on return",
  "Reserva de O2 al volver": "O2 reserve on return",
  "Reserva de batería al volver": "Battery reserve on return",
  "Respaldo": "Fallback",
  "Respaldo por el Sol": "Fallback by the Sun",
  "Respaldo por rumbo": "Fallback by bearing",
  "Ritmo parejo dentro del tramo": "Steady pace within the leg",
  "Robbins & Hynek 2012, mosaico diurno THEMIS IR (API OGC de USGS)": "Robbins & Hynek 2012, THEMIS IR daytime mosaic (USGS OGC API)",
  "Rumbo inicial de la estación de salida a la de llegada del tramo": "Initial bearing from the leg's start station to its end station",
  "SWIM no tiene datos sobre el DTM del sitio.": "SWIM has no data over the site's DTM.",
  "SWIM: ningún píxel del sitio es consistente con hielo somero (0-1 m).": "SWIM: no pixel at the site is consistent with shallow ice (0-1 m).",
  "Saca columnas de suelo de hasta 3 m": "Extracts soil columns up to 3 m long",
  "Sale antes del amanecer.": "Leaves before sunrise.",
  "Sale cuando ya no queda luz para volver con margen.": "Leaves when there's no daylight left to return with margin.",
  "Sale de un modelo: una fórmula con supuestos, listados abajo. Si un supuesto no se cumple, el número cambia.": "It comes from a model: a formula with assumptions, listed below. If an assumption does not hold, the number changes.",
  "Sale de una cuenta fija hecha sobre algo medido: por ejemplo, la pendiente se calcula con las alturas del relieve. Si lo medido está bien, esto también.": "It comes from a fixed calculation on something measured: for example, slope is computed from terrain heights. If the measurement is right, so is this.",
  "Salir 30 min tarde": "Leave 30 min late",
  "Sample Depot bundle de PDS Geosciences Node (sample_tube_locations.csv)": "PDS Geosciences Node Sample Depot bundle (sample_tube_locations.csv)",
  "Se descuenta la curvatura de Marte": "Mars' curvature is accounted for",
  "Seguridad": "Safety",
  "Señales minerales de CRISM (MRO), de los browse MTRDR": "CRISM mineral signals (MRO), from the MTRDR browse products",
  "Si al sitio le falta THEMIS, la capa sale solo con la geometría (lo dice terrain.json)": "If the site has no THEMIS, the layer uses geometry only (terrain.json says so)",
  "Si el badge nombra THEMIS, suelo suelto: lo ~20 % más frío de noche del sitio según THEMIS; solo sube 'bajo' a 'medio', nunca bloquea, y se ve en cuadros de 100 m": "If the badge names THEMIS, loose ground: the ~20 % of the site that is coldest at night according to THEMIS; it only raises 'low' to 'medium', never blocks, and shows in 100 m cells",
  "Si la ruta rompe uno, es NO-GO.": "If the route breaks one, it is NO-GO.",
  "Sin DEM lejano: el terreno fuera del DTM (p. ej. el borde del cráter) no proyecta sombra; el amanecer sale temprano.": "No far DEM: terrain outside the DTM (e.g. the crater rim) casts no shadow; sunrise comes out early.",
  "Sin DTM no se puede calcular la línea de vista al hábitat.": "Without a DTM, line of sight to the habitat can't be computed.",
  "Sin blindaje del terreno ni eventos solares": "No terrain shielding or solar events",
  "Sin catálogo de landmarks (falta places.json)": "No landmark catalog (places.json is missing)",
  "Sin contacto con el hábitat": "No contact with the habitat",
  "Sin dato = no se sabe: el planificador no lo cuenta como límite roto, pero avisa": "No data = unknown: the planner doesn't count it as a broken limit, but it warns",
  "Sin dato a menos de 500 m del borde del DTM": "No data within 500 m of the DTM edge",
  "Sin dato en el borde del DTM y alrededor de cada hueco del DTM.": "No data at the DTM edge and around each DTM gap.",
  "Sin el refugio más cercano": "Without the nearest shelter",
  "Sin elev_m hace falta site_id para leer el DTM": "Without elev_m, site_id is needed to read the DTM",
  "Sin la pila de sombras de ese sol: aproximación analítica, sin efemérides SPICE": "Without that sol's shadow stack: analytic approximation, no SPICE ephemerides",
  "Sin landmarks evaluados": "No landmarks evaluated",
  "Sin nombre oficial: el número solo la ordena por profundidad": "No official name: the number only ranks it by depth",
  "Sin nombre oficial: el número solo lo ordena por relieve": "No official name: the number only ranks it by relief",
  "Sin pendiente del DTM en la ruta: no se evaluó.": "No DTM slope along the route: not evaluated.",
  "Sin referencia visible": "No visible reference",
  "Sin terreno para la línea de vista (falta el DTM y el DEM)": "No terrain for line of sight (the DTM and DEM are missing)",
  "Sitio desconocido": "Unknown site",
  "Sitio desconocido o datos todavía no descargados": "Unknown site or data not downloaded yet",
  "Sky-view factor (Zakšek et al. 2011) calculado desde el DTM HiRISE (USGS)": "Sky-view factor (Zakšek et al. 2011) calculated from the HiRISE DTM (USGS)",
  "Sobre el plano horizontal: no corrige por la inclinación del propio píxel.": "On the horizontal plane: it doesn't correct for the pixel's own tilt.",
  "Sol puntual (centro del disco); sin refracción ni polvo.": "Point Sun (disk center); no refraction or dust.",
  "Sol puntual, sin refracción ni polvo; solo sol directo": "Point-like Sun, no refraction or dust; direct sunlight only",
  "Solo el terreno a menos de 500 m": "Only terrain within 500 m",
  "Solo geometría del terreno: no incluye gravedad, traje ni carga": "Terrain geometry only: does not include gravity, suit or load",
  "Solo geometría del terreno: no incluye gravedad, traje ni carga.": "Terrain geometry only: doesn't include gravity, suit or load.",
  "Solo la forma del terreno: que sea un cráter de impacto no está verificado": "Terrain shape only: that it's an impact crater isn't verified",
  "Solo para dibujar el horizonte lejano: ninguna medida sale de estos tiles.": "Only for drawing the far horizon: no measurement comes from these tiles.",
  "Solo para dibujar el relieve en 3D: ninguna medida sale de estos tiles.": "Only for drawing the 3D relief: no measurement comes from these tiles.",
  "Solo para ver el relieve: alturas y pendientes salen del DTM de 1 m, no del 3D": "Only for viewing the relief: heights and slopes come from the 1 m DTM, not from the 3D",
  "Solo rugosidad: en Pandolf la pendiente entra aparte como el grado G de la ruta.": "Roughness only: in Pandolf the slope enters separately as the route grade G.",
  "Sombra / frío": "Shadow / cold",
  "Sombras": "Shadows",
  "Subsuelo bajo tus pies (RIMFAX)": "Subsurface under your feet (RIMFAX)",
  "Suelo suelto (THEMIS)": "Loose soil (THEMIS)",
  "Suelo suelto según THEMIS de noche (100 m, criterio relativo del equipo): solo sube 'bajo' a 'medio', nunca bloquea. Se ve en cuadros de 100 m.": "Loose soil per night-time THEMIS (100 m, the team's relative criterion): it only raises 'low' to 'medium', never blocks. Shown in 100 m squares.",
  "Supervivencia": "Survival",
  "Supuestos del EMU de la ISS (docs/consumibles del traje.md)": "ISS EMU assumptions (docs/consumibles del traje.md)",
  "Supuestos del traje y de lo que llevás encima.": "Assumptions about the suit and what you carry.",
  "Taladro de núcleo": "Core drill",
  "Temperatura del aire": "Air temperature",
  "Tiempo sin contacto": "Time without contact",
  "Todavía no está el mapa de cobertura del pipeline: no se pudo verificar que los puntos tengan terreno de 1 m.": "The pipeline coverage map is not there yet: could not verify that the points have 1 m terrain.",
  "Todavía no se bajan las observaciones del rover ni las alertas de DONKI: los valores faltan y no se reemplazan por ejemplos.": "The rover's observations and DONKI alerts aren't downloaded yet: the values are missing and aren't replaced with examples.",
  "Tope sin definir por el equipo: se muestra el gasto, no cuenta en el puntaje.": "Cap not defined by the team: the expenditure is shown but doesn't count toward the score.",
  "Tormenta de polvo (más frío)": "Dust storm (colder)",
  "Traje": "Suit",
  "Tramo en línea recta: el ejemplo no esquiva obstáculos": "Straight-line segment: the sample does not avoid obstacles",
  "Tramo en línea recta: no se evaluó el terreno": "Straight-line leg: the terrain wasn't evaluated",
  "Tubo de 4 cm, inferior": "4 cm tube, lower",
  "Tubo de 4 cm, superior": "4 cm tube, upper",
  "Tubos de núcleo": "Core tubes",
  "Térmico de noche (THEMIS)": "Nighttime thermal (THEMIS)",
  "Ubicación de los 10 tubos del depósito Three Forks: posición del rover al soltar cada tubo (Mars 2020 Sample Depot bundle, PDS Geosciences Node)": "Location of the 10 tubes of the Three Forks depot: rover position when dropping each tube (Mars 2020 Sample Depot bundle, PDS Geosciences Node)",
  "Un DTM de 1 m no ve rocas sueltas de menos de ~3-5 m: la rugosidad marca zonas con bloques, no rocas.": "A 1 m DTM doesn't see loose rocks under ~3-5 m: roughness marks blocky areas, not rocks.",
  "Un DTM de 1 m no ve rocas sueltas de menos de ~3–5 m": "A 1 m DTM does not see loose rocks smaller than ~3–5 m",
  "Un cargador de 70 mm (1,4 lb)": "One 70 mm magazine (1.4 lb)",
  "Un extremo del tramo cae fuera del DTM del sitio.": "One end of the leg falls outside the site's DTM.",
  "Un par de tubos de 4 cm, para clavar a martillo": "A pair of 4 cm tubes, driven with a hammer",
  "Un punto cae fuera de la pila de sombras del sitio": "A point falls outside the site's shadow stack",
  "Una celda cuenta solo si todos sus píxeles del DTM tienen dato: el borde real del DTM puede quedar hasta una celda más afuera.": "A cell counts only if all its DTM pixels have data: the real DTM edge may lie up to one cell further out.",
  "Una máscara por hora: la hora la elige el deslizador del sol": "One mask per hour: the sun slider picks the hour",
  "Valor fijado por el equipo, sin fuente citable todavía (docs/seguridad.md)": "Value set by the team, with no citable source yet (docs/seguridad.md)",
  "Valores elegidos para probar la interfaz, no de un traje real": "Values chosen to test the interface, not from a real suit",
  "Velocidad con la pendiente media de la celda, promediando subir y bajar.": "Speed with the cell's mean slope, averaging uphill and downhill.",
  "Ventilador, bomba, radio y electrónica.": "Fan, pump, radio and electronics.",
  "Volver al menos esto antes de que se ponga el Sol.": "Be back at least this long before the Sun sets.",
  "Vuelta al hábitat": "Return to the habitat",
  "Waypoints del helicóptero publicados en MMGIS (mars.nasa.gov)": "Helicopter waypoints published in MMGIS (mars.nasa.gov)",
  "aeródromo de Ingenuity": "Ingenuity airfield",
  "al límite": "at the limit",
  "alto: 20–25° o σ 0,25–0,40 m": "high: 20–25° or σ 0.25–0.40 m",
  "bajo: < 10°, σ < 0,15 m y suelo firme": "low: < 10°, σ < 0.15 m and firm ground",
  "brillo relativo": "relative brightness",
  "carbonato de Mg": "Mg carbonate",
  "carbonatos de Mg": "Mg carbonates",
  "catálogo completo para cráteres de 1 km o más": "complete catalog for craters of 1 km or more",
  "cerro (del DTM)": "hill (from the DTM)",
  "cerro del DTM, sin nombre": "unnamed DTM hill",
  "clase": "class",
  "con cuidado": "with care",
  "con vista al hábitat": "with line of sight to the habitat",
  "consistencia de hielo (-1 a +1)": "ice consistency (-1 to +1)",
  "consistencia de hielo (−1 a +1)": "ice consistency (−1 to +1)",
  "costo = Σ celdas Δt · (1 + Σ_k w_k · r_k)": "cost = Σ cells Δt · (1 + Σ_k w_k · r_k)",
  "cráter": "crater",
  "cráter Robbins": "Robbins crater",
  "dato del usuario": "user input",
  "derivada, 100 m/px": "derived, 100 m/px",
  "derivado": "derived",
  "dose_rate.tif (pipeline/radiation.py): base de RAD × sky-view del terreno": "dose_rate.tif (pipeline/radiation.py): RAD baseline × terrain sky-view",
  "el dato grueso de campo magnético cortical (MGS MAG/ER)": "the coarse crustal magnetic field data (MGS MAG/ER)",
  "el perfil del radar de subsuelo de Mars 2020 RIMFAX": "the Mars 2020 RIMFAX subsurface radar profile",
  "el server todavía no tiene el endpoint de sombras o no conoce el sitio": "the server does not have the shadows endpoint yet or does not know the site",
  "elev_m tiene que venir en todos los puntos o en ninguno": "elev_m must be in all points or in none",
  "en sombra": "in shadow",
  "equidistancia 10 m (de lejos, 50 m)": "10 m interval (50 m from afar)",
  "error sin detalle": "error without detail",
  "filosilicatos de Al o sílice hidratada": "Al phyllosilicates or hydrated silica",
  "filosilicatos de Fe/Mg": "Fe/Mg phyllosilicates",
  "fracción": "fraction",
  "fuera del DTM": "outside the DTM",
  "gdal2tiles no generó ningún tile": "gdal2tiles didn't generate any tile",
  "geometría esférica": "spherical geometry",
  "grilla de Gale (DTM + DEM 200 m)": "Gale grid (DTM + 200 m DEM)",
  "hay tramos con terreno sin evaluar": "some legs have unevaluated terrain",
  "hidratación": "hydration",
  "hondonada (del DTM)": "depression (from the DTM)",
  "hora solar local": "local solar time",
  "imagen real, sin realce": "real image, no enhancement",
  "invierno norte": "northern winter",
  "largo de la ruta": "route length",
  "ltst tiene que ser HH:MM, con HH de 00 a 23 y MM de 00 a 59": "ltst must be HH:MM, with HH from 00 to 23 and MM from 00 to 59",
  "línea de vista": "line of sight",
  "masa de vuelo": "flight mass",
  "max(clase de pendiente, clase de rugosidad σ); cortes con ≥, como api/planner.py.": "max(slope class, roughness class σ); cuts with ≥, like api/planner.py.",
  "medio: 10–20°, σ 0,15–0,25 m o suelo suelto (THEMIS)": "medium: 10–20°, σ 0.15–0.25 m or loose ground (THEMIS)",
  "minerales hidratados": "hydrated minerals",
  "modelado": "modeled",
  "modelo del traje": "suit model",
  "más frío de noche: arena, polvo, grano fino": "colder at night: sand, dust, fine grains",
  "más tibio de noche: roca o suelo compacto": "warmer at night: rock or compact ground",
  "no hay backend (datos de ejemplo)": "no backend (sample data)",
  "no hay pendiente: falló el paso relief-slope": "no slope: the relief-slope step failed",
  "no se calculó": "not computed",
  "no se evaluó el contacto con el hábitat: falta el DTM en la salida": "contact with the habitat wasn't evaluated: the DTM is missing at the start",
  "no se pudo leer la pila de sombras en algunas horas: esos tramos no tuvieron en cuenta la sombra": "the shadow stack couldn't be read at some hours: those legs didn't account for shadow",
  "no transitable": "impassable",
  "no transitable: ≥ 25° o σ ≥ 0,40 m": "impassable: ≥ 25° or σ ≥ 0.40 m",
  "nombre IAU": "IAU name",
  "objetivo": "target",
  "objetivo científico": "science target",
  "observado": "observed",
  "olivino": "olivine",
  "otoño norte": "northern autumn",
  "parámetro de ejemplo": "sample parameter",
  "pila a la del DTM; se dibuja hasta z15 (~2,5 m/px)": "stack at the DTM's resolution; drawn up to z15 (~2.5 m/px)",
  "pipeline/illumination.py: geometría solar (SPICE) sobre el DTM": "pipeline/illumination.py: solar geometry (SPICE) over the DTM",
  "primavera norte": "northern spring",
  "punto A": "point A",
  "refugio (cielo ≤ 85 %)": "shelter (sky ≤ 85 %)",
  "refugio fuerte (cielo ≤ 75 %)": "strong shelter (sky ≤ 75 %)",
  "rover": "rover",
  "señal mineral desde órbita (CRISM)": "mineral signal from orbit (CRISM)",
  "sin contacto (rayado)": "no contact (hatched)",
  "sin dato": "no data",
  "sin evaluar (falta DTM)": "not evaluated (no DTM)",
  "sin la pendiente procesada los tramos van en línea recta y el terreno no se evaluó": "without the processed slope, legs are straight lines and the terrain wasn't evaluated",
  "sin sol directo en este sol": "no direct sun this sol",
  "slope.tif (pipeline/precompute.py)": "slope.tif (pipeline/precompute.py)",
  "suelto probable": "probably loose",
  "supuesto del equipo, sin fuente citable": "team assumption, no citable source",
  "terrain.json no tiene curvas de nivel que hayan salido bien: hay que correr precompute.py completo.": "terrain.json has no successful contour lines: precompute.py has to be run in full.",
  "transitable": "passable",
  "tubo de muestra": "sample tube",
  "verano norte": "northern summer",
  "Índice, no medición: +1 = los datos son consistentes con hielo, 0 = sin indicio, -1 = los datos van en contra.": "An index, not a measurement: +1 = data consistent with ice, 0 = no hint, -1 = data against it.",
  "Índice, no medición: +1 = los datos son consistentes con hielo, 0 = sin indicio, −1 = los datos van en contra": "Index, not a measurement: +1 = the data are consistent with ice, 0 = no indication, −1 = the data argue against it",
  "η de Pandolf: 1 = pavimento, 1,1 = regolito compacto, más = suelto.": "Pandolf's η: 1 = pavement, 1.1 = compact regolith, higher = loose.",
  "σ ≈ la mitad de la altura de los escalones: σ 0,40 m ≈ bloques de ~1 m": "σ ≈ half the step height: σ 0.40 m ≈ ~1 m blocks",
  "−0,1 a 0,1: sin indicio": "−0.1 to 0.1: no indication",
  "−0,5 a −0,1: algo en contra": "−0.5 to −0.1: somewhat against",
  "−1 a −0,5: en contra del hielo": "−1 to −0.5: against ice",
  "≤ 75 % (refugio fuerte)": "≤ 75 % (strong shelter)",
  "≥ 20 µSv/h (base de Gale: 26,7)": "≥ 20 µSv/h (Gale baseline: 26.7)"
};

/** Frases con números o nombres adentro. El orden importa: gana el primero que calza. */
export const PATTERNS: readonly (readonly [RegExp, Fn])[] = [
  // ---- Resumen del veredicto (api/safety.py summary + api/planner.py "Cuidado:" / "Ojo:")
  [/^(No va|Va con cuidado|Va): (.+)$/s, (m, tr) => summaryEn(m[0]!, tr)],
  // ---- api/safety.py: notas de los límites
  [/^(\d+) min seguidos sin vista al hábitat \(máximo (\d+)\), del minuto (\d+) al (\d+)\. Mirá la capa «Contacto con el hábitat»\.$/, (m) => `${m[1]} consecutive min without view of the habitat (max ${m[2]}), from minute ${m[3]} to ${m[4]}. Check the “Contact with the habitat” layer.`],
  [/^La racha más larga sin vista al hábitat es de (\d+) min, (.+)\.$/s, (m) => `The longest stretch without view of the habitat is ${m[1]} min, ${whereEn(m[2]!)}.`],
  [/^Son (\d+) min seguidos sin línea de vista al hábitat \(el máximo es (\d+)\), (.+): el terreno tapa la antena\. Mirá la capa «Contacto con el hábitat» y elegí un destino o un hábitat con vista entre sí, o paradas que vuelvan a tener vista antes de los (\d+) min\.$/s, (m) => `That's ${m[1]} consecutive min without line of sight to the habitat (the max is ${m[2]}), ${whereEn(m[3]!)}: the terrain blocks the antenna. Check the “Contact with the habitat” layer and pick a destination or habitat that can see each other, or stops that regain view before ${m[4]} min.`],
  [/^No hay paso con pendiente menor a (\d+)° en el tramo (.+)\.$/, (m) => `No passage with slope under ${m[1]}° on leg ${m[2]}.`],
  [/^No hay paso con pendiente menor a (\d+)° dentro de la zona evaluada\.$/, (m) => `No passage with slope under ${m[1]}° inside the evaluated area.`],
  [/^(\d+) de (\d+) pasos sin pendiente del DTM\.$/, (m) => `${m[1]} of ${m[2]} steps without DTM slope.`],
  [/^(El O2|La batería) se agota antes de terminar la travesía\.$/, (m) => `${m[1] === "El O2" ? "O2" : "The battery"} runs out before the traverse ends.`],
  [/^(El O2|La batería) no deja la reserva mínima del (\d+) % al llegar\.$/, (m) => `${m[1] === "El O2" ? "O2" : "The battery"} doesn't leave the minimum ${m[2]} % reserve on arrival.`],
  [/^(\d+) min sin dato de visibilidad: se contaron como sin contacto y aun así no pasa el límite\.$/, (m) => `${m[1]} min without visibility data: counted as no contact and it still doesn't exceed the limit.`],
  [/^(\d+) min sin dato de visibilidad: contándolos como sin contacto, la racha llegaría a (\d+) min\. No se sabe si se rompe el límite\.$/, (m) => `${m[1]} min without visibility data: counting them as no contact, the stretch would reach ${m[2]} min. It's unknown whether the limit is broken.`],
  // ---- api/consumables.py
  [/^Tramo (\d+): pendiente de (\d+) %, fuera del rango validado de Pandolf \(±(\d+) %\)\.$/, (m) => `Leg ${m[1]}: grade of ${m[2]} %, outside Pandolf's validated range (±${m[3]} %).`],
  [/^El O2 primario se agota en el tramo (\d+)\.$/, (m) => `Primary O2 runs out on leg ${m[1]}.`],
  [/^La batería se agota en el tramo (\d+)\.$/, (m) => `The battery runs out on leg ${m[1]}.`],
  // ---- api/directions.py: procedencia de las indicaciones
  [/^Distancia sobre la ruta del planificador \(esfera R = (\d+) m\)$/, (m) => `Distance along the planner's route (sphere R = ${m[1]} m)`],
  [/^Azimut y elevación del Sol de la pila (\S+) \(pipeline\/illumination\.py\), interpolados entre horas$/, (m) => `Sun azimuth and elevation from stack ${m[1]} (pipeline/illumination.py), interpolated between hours`],
  [/^Línea de vista sobre (.+), cada (.+) m del trecho \(api\/directions\.py\)$/, (m, tr) => `Line of sight over ${tr(m[1]!)}, every ${n(m[2]!)} m of the stretch (api/directions.py)`],
  [/^(\S+(?: \+ \S+)?) promediado a (.+) m$/, (m) => `${m[1]} averaged to ${n(m[2]!)} m`],
  [/^Ojos a (.+) m del suelo; se mira la parte más alta del rasgo \(borde o cima\)$/, (m) => `Eyes ${n(m[1]!)} m above the ground; the highest part of the feature is used (rim or summit)`],
  [/^Cuenta como visible si asoma al menos (.+)° sobre la línea de vista$/, (m) => `Counts as visible if it rises at least ${n(m[1]!)}° above the line of sight`],
  [/^Un candidato con parecidos a ±(.+)° pierde puntaje y se nombra frente a ellos$/, (m) => `A candidate with look-alikes within ±${n(m[1]!)}° loses score and is named relative to them`],
  // ---- api/contact.py, api/viewshed.py
  [/^Antena del hábitat a (.+) m y del traje a (.+) m sobre el suelo$/, (m) => `Habitat antenna at ${n(m[1]!)} m and suit antenna at ${n(m[2]!)} m above the ground`],
  [/^DTM promediado a (.+) m$/, (m) => `DTM averaged to ${n(m[1]!)} m`],
  [/^celdas de (\d+) m sobre el (.+)$/, (m, tr) => `${m[1]} m cells over the ${tr(m[2]!)}`],
  [/^Se evalúa hasta (.+) km del hábitat$/, (m) => `Evaluated up to ${n(m[1]!)} km from the habitat`],
  // ---- api/illumination.py
  [/^Sombras del sol (\S+) \(Ls (.+?)°\) usadas para la fecha pedida \(Ls (.+?)°, ΔLs (.+?)°, tope ±(.+?)°\): misma estación y misma hora solar local, de cualquier año marciano$/, (m) => `Shadows from sol ${m[1]} (Ls ${n(m[2]!)}°) used for the requested date (Ls ${n(m[3]!)}°, ΔLs ${n(m[4]!)}°, cap ±${n(m[5]!)}°): same season and same local solar time, from any Martian year`],
  [/^A la misma hora solar local solo cambia la declinación del Sol: (.+?)° de diferencia \(Mars24\)\. Las sombras con el Sol bajo son las que más se apartan$/, (m) => `At the same local solar time only the Sun's declination changes: ${n(m[1]!)}° of difference (Mars24). Shadows with a low Sun are the ones that drift the most`],
  [/^pipeline\/illumination\.py · sol (\S+), reutilizado por estación · (.+)$/, (m) => `pipeline/illumination.py · sol ${m[1]}, reused by season · ${m[2]}`],
  [/^Ventana remuestreada: 1 de cada (\d+) píxeles por lado \(vecino más cercano\)$/, (m) => `Resampled window: 1 of every ${m[1]} pixels per side (nearest neighbor)`],
  [/^La pila de este sol tiene una banda cada (\d+) min LTST; pedí una hora múltiplo de ese paso$/, (m) => `This sol's stack has a band every ${m[1]} min LTST; ask for a time that's a multiple of that step`],
  [/^El horario (.+) no está en la pila de este sol$/, (m) => `Time ${m[1]} isn't in this sol's stack`],
  [/^La pila de sombras de (.+?)( para el sol (.+))? todavía no está: la genera pipeline\/illumination\.py\.$/, (m) => `The shadow stack for ${m[1]}${m[3] ? ` for sol ${m[3]}` : ""} isn't there yet: pipeline/illumination.py generates it.`],
  // ---- api/main.py
  [/^Diferencias finitas sobre el DTM a ±(.+) m$/, (m) => `Finite differences over the DTM at ±${n(m[1]!)} m`],
  [/^El DTM de (.+) no está disponible$/, (m) => `The DTM for ${m[1]} isn't available`],
  [/^No conozco el sitio '(.+)'\.$/, (m) => `Unknown site '${m[1]}'.`],
  [/^No se pudo leer (el DTM|un raster del sitio|la pila de sombras): (.+)$/s, (m) => `Couldn't read ${{ "el DTM": "the DTM", "un raster del sitio": "a site raster", "la pila de sombras": "the shadow stack" }[m[1]!]}: ${m[2]}`],
  [/^La ruta necesita más de (\d+) muestras: subí sample_step_m$/, (m) => `The route needs more than ${m[1]} samples: raise sample_step_m`],
  // ---- api/planner.py
  [/^Geometría esférica \(R = (\d+) m\)$/, (m) => `Spherical geometry (R = ${m[1]} m)`],
  [/^Caminata a (.+) m\/s sobre el terreno$/, (m) => `Walking at ${n(m[1]!)} m/s over the terrain`],
  [/^Carga de (.+) kg además del traje: entra a Pandolf y sube el O2\. A velocidad fija no cambia los tiempos, y la batería no depende del esfuerzo$/, (m) => `Load of ${n(m[1]!)} kg on top of the suit: it goes into Pandolf and raises O2. At fixed speed it doesn't change the times, and the battery doesn't depend on effort`],
  [/^celdas de (\d+) × (\d+) m$/, (m) => `${m[1]} × ${m[2]} m cells`],
  [/^(\d+) de (\d+) puntos sin cota del DTM: ahí se tomó el terreno plano$/, (m) => `${m[1]} of ${m[2]} points without DTM elevation: flat terrain was assumed there`],
  [/^Tasa medida en Gale \((.+) mSv\/día\), igual en todo el recorrido$/, (m) => `Rate measured at Gale (${n(m[1]!)} mSv/day), the same along the whole route`],
  [/^Reserva del (\d+) % fijada por el equipo, sin fuente citable todavía \(docs\/seguridad\.md\)$/, (m) => `${m[1]} % reserve set by the team, with no citable source yet (docs/seguridad.md)`],
  [/^Margen de (\d+) min antes del atardecer fijado por el equipo, sin fuente citable todavía \(docs\/seguridad\.md\)$/, (m) => `${m[1]} min margin before sunset set by the team, with no citable source yet (docs/seguridad.md)`],
  [/^Atardecer − margen − salida · (.+)$/s, (m, tr) => `Sunset − margin − departure · ${tr(m[1]!)}`],
  [/^Tramo de (.+) km: muy largo para evaluarlo de una vez; sumá una estación intermedia\.$/, (m) => `${n(m[1]!)} km leg: too long to evaluate at once; add an intermediate station.`],
  [/^Pendiente que no se puede esquivar en cada celda \((.+?)\): la f-ésima más alta de sus f × f píxeles\. Una franja que la cruza no se diluye; una roca suelta no la bloquea$/, (m, tr) => `Unavoidable slope in each cell (${tr(m[1]!)}): the f-th highest of its f × f pixels. A band crossing it isn't diluted; a loose rock doesn't block it`],
  // ---- api/terrain.py
  [/^El punto \((.+), (.+)\) cae fuera del DTM\.$/, (m) => `The point (${m[1]}, ${m[2]}) falls outside the DTM.`],
  [/^El punto \((.+), (.+)\) cae en una zona sin datos del DTM\.$/, (m) => `The point (${m[1]}, ${m[2]}) falls in an area with no DTM data.`],
  // ---- pipeline/places.py (detalle y procedencia de los lugares)
  [/^Cráter de (.+) km \(catálogo de Robbins\)$/, (m) => `${n(m[1]!)} km crater (Robbins catalog)`],
  [/^Waypoints de (.+) \(MMGIS\)$/, (m) => `${m[1]} waypoints (MMGIS)`],
  [/^Cerros sin nombre del DTM \(relieve ≥ (.+) m\)$/, (m) => `Unnamed hills from the DTM (relief ≥ ${n(m[1]!)} m)`],
  [/^Hondonadas del DTM \(≥ (.+) m, posibles cráteres\)$/, (m) => `Hollows from the DTM (≥ ${n(m[1]!)} m, possible craters)`],
  [/^Objetivos científicos con nombre \((.+)\)$/, (m) => `Named science targets (${m[1]})`],
  [/^Waypoint del rover, site (\S+) drive (\S+)$/, (m) => `Rover waypoint, site ${m[1]} drive ${m[2]}`],
  [/^Aeródromo de Ingenuity · (.+)$/, (m) => `Ingenuity airfield · ${landingsEn(m[1]!)}`],
  [/^Posición del último aterrizaje en el aeródromo \(sol (\d+)\)\.$/, (m) => `Position of the last landing at the airfield (sol ${m[1]}).`],
  [/^Tubo de muestra ?(.*), soltado el sol (\d+)$/, (m) => `Sample tube ${m[1]}, dropped on sol ${m[2]}`.replace("tube ,", "tube,")],
  [/^Posición del rover al medir\. (.+) va en el brazo: el objetivo queda al alcance del brazo, no exactamente acá\. La distancia no se publica\.$/, (m) => `Rover position when measuring. ${m[1]} is on the arm: the target is within arm's reach, not exactly here. The distance isn't published.`],
  [/^Posición del rover al medir, con el objetivo a (.+) m: el objetivo está a esa distancia, no exactamente acá\.$/, (m) => `Rover position when measuring, with the target at ${n(m[1]!)} m: the target is that far away, not exactly here.`],
  [/^Es el punto desde donde se observó, no el objetivo: el objetivo queda (.+?) en una dirección que este índice no calcula\.$/, (m) => `It's the point it was observed from, not the target: the target is ${farEn(m[1]!)} in a direction this index doesn't compute.`],
  [/^observado desde acá (a .+? m|a distancia desconocida)$/, (m) => `observed from here ${farEn(m[1]!)}`],
  [/^soles (\d+)–(\d+)$/, (m) => `sols ${m[1]}–${m[2]}`],
  [/^Se eleva (\d+) m sobre su entorno \(radio (\d+) m\)$/, (m) => `Rises ${m[1]} m above its surroundings (radius ${m[2]} m)`],
  [/^Fondo (\d+) m por debajo de su borde \(radio (\d+) m\); posible cráter$/, (m) => `Floor ${m[1]} m below its rim (radius ${m[2]} m); possible crater`],
  [/^DTM de 1 m leído a (\d+) m$/, (m) => `1 m DTM read at ${m[1]} m`],
  [/^Relieve = altura sobre lo más bajo en un radio de (\d+) m: no es la prominencia topográfica formal$/, (m) => `Relief = height above the lowest point within a ${m[1]} m radius: not formal topographic prominence`],
  [/^(\S+ [≥=] [\d,]+), lo más fuerte de (\S+)(?: · objetivo de MRO: (.+))?$/, (m) => `${n(m[1]!)}, strongest in ${m[2]}${m[3] ? ` · MRO target: ${m[3]}` : ""}`],
  [/^(.+) m\/px, mediana de (\d+) × (\d+) px$/, (m) => `${n(m[1]!)} m/px, median of ${m[2]} × ${m[3]} px`],
  [/^Indicio desde órbita de (.+): no es una identificación mineral, hay que confirmarla con los espectros$/, (m, tr) => `Orbital hint of ${tr(m[1]!)}: not a mineral identification, it has to be confirmed with the spectra`],
  [/^Umbral nuestro, conservador \(no lo publica la fuente\): (.+)$/, (m) => `Our own conservative threshold (the source doesn't publish one): ${n(m[1]!)}`],
  [/^(Primera posición registrada del rover en el sitio|Última posición conocida del rover|Donde quedó Ingenuity) · (.+)$/s, (m, tr) => `${{ "Primera posición registrada del rover en el sitio": "First recorded rover position at the site", "Última posición conocida del rover": "Last known rover position", "Donde quedó Ingenuity": "Where Ingenuity ended up" }[m[1]!]} · ${tr(m[2]!)}`],
  [/^(\d+) observaciones de (.+) sin posición del rover$/, (m) => `${m[1]} ${m[2]} observations without rover position`],
  [/^posición del rover para (.+)$/, (m) => `rover position for ${m[1]}`],
  [/^falta (.+)$/, (m, tr) => { const x = tr(m[1]!); return x === m[1] ? null : `missing ${x}`; }],
  [/^Las listas de objetivos todavía no están descargadas: (.+)$/, (m, tr) => `The target lists aren't downloaded yet: ${m[1]!.split(", ").map(tr).join(", ")}`],
  // ---- pipeline: metadatos de las capas
  [/^(.+) m \(E-O\) x (.+) m \(N-S\) por píxel$/, (m) => `${n(m[1]!)} m (E-W) x ${n(m[2]!)} m (N-S) per pixel`],
  [/^Horn 3x3 con el tamaño de píxel real sobre el suelo, fila por fila \(esfera de (\d+) m\)\.$/, (m) => `Horn 3x3 with the real on-ground pixel size, row by row (sphere of ${m[1]} m).`],
  [/^celdas de (\d+) x (\d+) píxeles del DTM$/, (m) => `cells of ${m[1]} x ${m[2]} DTM pixels`],
  [/^Tiles estirados entre el p(\d+) \((.+) DN\) y el p(\d+) \((.+) DN\) del sitio, solo para que se vea el contraste\. themis_night\.tif guarda los DN originales\.$/, (m) => `Tiles stretched between the site's p${m[1]} (${m[2]} DN) and p${m[3]} (${m[4]} DN), only so the contrast shows. themis_night.tif keeps the original DN.`],
  [/^brillo nocturno en el (\d+) % más frío del sitio \(percentiles sobre los píxeles de THEMIS que tocan DTM; con empates puede marcar algo más\), solo si ese percentil queda a ≥ (\d+) DN de la mediana( Con THEMIS: 'bajo' con suelo suelto probable pasa a 'medio'\.)?$/, (m) => `night-time brightness in the coldest ${m[1]} % of the site (percentiles over THEMIS pixels touching the DTM; ties may mark a bit more), only if that percentile is ≥ ${m[2]} DN from the median`],
  [/^(.+) Con THEMIS: 'bajo' con suelo suelto probable pasa a 'medio'\.$/s, (m, tr) => { const x = tr(m[1]!); return x === m[1] ? null : `${x} With THEMIS: 'low' with probable loose soil becomes 'medium'.`; }],
  [/^desvío estándar en (.+) m del residuo del DTM tras restar el promedio en (.+) m$/, (m) => `standard deviation over ${n(m[1]!)} m of the DTM residual after subtracting the ${n(m[2]!)} m average`],
  [/^(.+) \((.+)\), modulada por sky-view del terreno$/, (m) => `${m[1]} (${m[2]}), modulated by terrain sky-view`],
  [/^H0 × sky_view \/ sky_view\(Bradbury Landing\); sky_view = 1 − promedio\(sin γ\) en (\d+) azimuts hasta (\d+) km$/, (m) => `H0 × sky_view / sky_view(Bradbury Landing); sky_view = 1 − mean(sin γ) over ${m[1]} azimuths up to ${m[2]} km`],
  [/^Base medida por RAD en Gale: (.+) ± (.+) mSv\/día \(dosis equivalente\); varía con el ciclo solar, la presión estacional y eventos solares\.$/, (m) => `Baseline measured by RAD at Gale: ${n(m[1]!)} ± ${n(m[2]!)} mSv/day (dose equivalent); varies with the solar cycle, seasonal pressure and solar events.`],
  [/^~(.+) m por píxel en el zoom máximo \(DTM remuestreado para dibujar\)$/, (m) => `~${n(m[1]!)} m per pixel at max zoom (DTM resampled for drawing)`],
  [/^Huecos del DTM de hasta ~(\d+) m rellenados por interpolación para no dibujar pozos; fuera de la huella del DTM, plano\.$/, (m) => `DTM gaps up to ~${m[1]} m filled by interpolation so no pits are drawn; outside the DTM footprint, flat.`],
  [/^200 m por píxel \(DEM global\), teselado a ~(\d+) m$/, (m) => `200 m per pixel (global DEM), tiled at ~${m[1]} m`],
  [/^Huecos de hasta ~(\d+) km rellenados por interpolación\.$/, (m) => `Gaps up to ~${m[1]} km filled by interpolation.`],
  [/^derivada, (.+) m\/px$/, (m) => `derived, ${n(m[1]!)} m/px`],
  [/^El tamaño del píxel este-oeste cambia (.+) a lo ancho del DTM; la pendiente usa el del centro de cada fila\.$/, (m) => `The east-west pixel size changes ${n(m[1]!)} across the DTM; the slope uses the one at the center of each row.`],
  [/^El píxel mide (.+) x (.+) m sobre el suelo\. La pendiente lo corrige; el sombreado \(gdaldem\) no, pero es solo visual\.$/, (m) => `The pixel measures ${n(m[1]!)} x ${n(m[2]!)} m on the ground. The slope corrects for it; the hillshade (gdaldem) doesn't, but it's only visual.`],
  [/^Velocidad de Tobler \(1993\) escalada a (.+) m\/s en plano\.$/, (m) => `Tobler (1993) speed scaled to ${n(m[1]!)} m/s on flat ground.`],
  [/^Una celda no se pisa si cruzarla obliga a pisar (.+)° o más \(la (\d+)\.ª pendiente más alta de sus (\d+) celdas de (.+) m, como el planificador\)\.$/, (m) => `A cell isn't stepped on if crossing it forces a slope of ${n(m[1]!)}° or more (the ${m[2]}th highest slope of its ${m[3]} cells of ${n(m[4]!)} m, like the planner).`],
  [/^Camino calculado a (.+) m: un refugio de pocos metros cuenta desde el borde de su celda\.$/, (m) => `Path computed at ${n(m[1]!)} m: a shelter of a few meters counts from the edge of its cell.`],
  [/^SVF = 1 − Σ sin γ \/ n \(Zakšek et al\. 2011\), (\d+) azimuts, horizonte hasta (.+) m\.$/, (m) => `SVF = 1 − Σ sin γ / n (Zakšek et al. 2011), ${m[1]} azimuths, horizon up to ${n(m[2]!)} m.`],
  [/^Solo cuenta el terreno a menos de (.+) m\.$/, (m) => `Only terrain within ${n(m[1]!)} m counts.`],
  [/^Sin dato a menos de (.+) m del borde del DTM y de sus huecos\.$/, (m) => `No data within ${n(m[1]!)} m of the DTM edge and its gaps.`],
  [/^Pendiente < (.+)° y mancha de al menos (.+) m² \(dos o tres personas\)\.$/, (m) => `Slope < ${n(m[1]!)}° and a patch of at least ${n(m[2]!)} m² (two or three people).`],
  [/^Primera \(amanecer\) y última \(atardecer\) muestra con sol; el instante real está dentro de los (\d+) min previos \(amanecer\) o siguientes \(atardecer\)\.$/, (m) => `First (sunrise) and last (sunset) sample with sun; the real instant is within the previous (sunrise) or following (sunset) ${m[1]} min.`],
  [/^(.+) \(DTM del sitio\)$/, (m) => `${m[1]} (site DTM)`],
  [/^Terreno cercano a la resolución del DTM; terreno fuera del DTM con el DEM lejano \(horizonte por observador cada (.+) m, hasta (.+) km\)\.$/, (m) => `Nearby terrain at DTM resolution; terrain outside the DTM with the far DEM (horizon per observer every ${n(m[1]!)} m, up to ${n(m[2]!)} km).`],
  [/^SWIM: el indicio de hielo somero en el sitio es débil \(máximo (.+) en una escala de -1 a \+1\)\.$/, (m) => `SWIM: the shallow-ice hint at the site is weak (max ${n(m[1]!)} on a -1 to +1 scale).`],
  [/^THEMIS nocturno sin contraste en el sitio \(percentil (.+) a (.+) DN de la mediana\): no se marca suelo suelto\.$/, (m) => `Night-time THEMIS without contrast at the site (percentile ${m[1]} at ${m[2]} DN from the median): no loose soil is marked.`],
  // ---- Genéricos y del frontend
  [/^Esfera IAU Mars 2000 de radio ([\d.,]+) km, la misma de los DTM y de la API$/, (m) => `IAU Mars 2000 sphere of radius ${m[1]} km, the same as the DTMs and the API`],
  // "Nombre: mensaje conocido" (avisos del planificador). Va al final: solo si la parte de la derecha se conoce.
  [/^([^:]{1,80}): (.+)$/, (m, tr) => {
    const right = tr(m[2]!);
    return right === m[2] ? null : `${m[1]}: ${right}`;
  }],
  // Errores del cliente HTTP (api/client.ts)
  [/^(.+?) respondió (\d+)(.*)$/s, (m, tr) => `${m[1]} responded ${m[2]}${m[3] ? tr(m[3]) : ""}`],
  [/^(.+?) no cumple el contrato: (.+)$/s, (m) => `${m[1]} does not match the contract: ${m[2]!.replace(/ \(y (\d+) más\)$/, " (and $1 more)")}`],
  [/^(fotos|contacto|sombras): el server respondió (\d+)(.*)$/s, (m) => `${{ fotos: "photos", contacto: "contact", sombras: "shadows" }[m[1]!]}: the server responded ${m[2]}${m[3]}`],
  [/^el server no tiene la pila de sombras(.*)$/s, (m) => `the server does not have the shadow stack${m[1]}`],
  [/^la pila de sombras no cubre este punto(.*)$/s, (m) => `the shadow stack does not cover this point${m[1]}`],
  // Planificador de ejemplo (api/routeFixture.ts)
  [/^Caminata a ([\d.,]+) km\/h constante$/, (m) => `Walking at a constant ${m[1]} km/h`],
  [/^Autonomía de ([\d.,]+) h de O2 y ([\d.,]+) h de batería, consumo lineal$/, (m) => `${m[1]} h of O2 and ${m[2]} h of battery endurance, linear consumption`],
  [/^Tasa de base medida en Gale \(([\d.,]+) mSv\/día\), igual en todo el recorrido$/, (m) => `Baseline rate measured at Gale (${m[1]} mSv/day), the same along the whole route`],
  [/^Ejemplo sin landmarks evaluados: mantené el rumbo (.+) durante unos (.+) \((.+)\)\.$/, (m) => `Sample without evaluated landmarks: keep a bearing of ${m[1]} for about ${m[2]} (${m[3]}).`],
  [/^Fuera de la ventana de luz \((\d+):00–(\d+):00 hora solar local\)\.$/, (m) => `Outside the daylight window (${m[1]}:00–${m[2]}:00 local solar time).`],
  [/^El O2 no deja la reserva mínima de (\d+) min al llegar\.$/, (m) => `O2 does not leave the minimum ${m[1]} min reserve on arrival.`],
  [/^La batería no deja la reserva mínima de (\d+) min al llegar\.$/, (m) => `The battery does not leave the minimum ${m[1]} min reserve on arrival.`],
  // Partes de equipo: "Pala grande ajustable: 590 g"
  [/^(.+): (\d+) g$/, (m, tr) => {
    const n = tr(m[1]!);
    return n === m[1] ? null : `${n}: ${m[2]} g`;
  }],
  // Fuentes encadenadas con " · ": se traduce cada una; alcanza con que cambie una
  [/^(.+?) · (.+)$/s, (m, tr) => {
    const a = tr(m[1]!);
    const b = tr(m[2]!);
    return a === m[1] && b === m[2] ? null : `${a} · ${b}`;
  }],
];
