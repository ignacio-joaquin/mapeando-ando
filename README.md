# Mapa Marciano

Mapa de supervivencia para una caminata (EVA) en la superficie de Marte, armado con datos reales de la NASA. Lo hizo el equipo **Mapeando Ando** para el NASA Space Apps Challenge 2026, challenge *Interplanetary Survival Guide: Martian Map*.

**Demo y proyecto en Space Apps:** link pendiente, se completa al publicar el proyecto.

> **Prototipo educativo, no software de vuelo.** Los números sirven para entender qué limita una EVA, no para planear una de verdad. La app también lo dice en pantalla.

## Índice

- [Qué hace](#qué-hace)
- [Cómo leer cada número](#cómo-leer-cada-número)
- [Datos de la NASA que usamos](#datos-de-la-nasa-que-usamos)
- [Supuestos de los modelos](#supuestos-de-los-modelos)
- [Cómo correrlo](#cómo-correrlo)
- [Estructura del repo](#estructura-del-repo)
- [Uso de IA](#uso-de-ia)
- [Créditos](#créditos)

## Qué hace

Responde las preguntas de alguien parado en Marte, con el casco puesto y poco tiempo:

| Pregunta | Qué muestra la app |
|---|---|
| ¿Puedo pisar acá? | Pendiente y peligro de terreno a 1 m (pendiente + rugosidad + suelo suelto de THEMIS). El corte de "no transitable" es el mismo en el mapa y en el planificador: 25°. |
| ¿Por dónde voy, y cómo vuelvo? | Planificador 4D: marcás el hábitat, las paradas, el destino y la hora de salida. La API busca la ruta **más segura**, no la más corta: A\* sobre la pendiente, la sombra a la hora en que pasás y la línea de vista al hábitat. Por defecto incluye la vuelta. |
| ¿Me alcanzan el O2 y la batería? | Consumo del traje tramo por tramo (Pandolf ajustado a 0,38 g), con la carga que elegís llevar. |
| ¿Cuánta radiación acumulo? | Presupuesto de dosis de la travesía, a partir de la dosis medida por RAD de Curiosity. |
| ¿Cuánta luz me queda? | Sombras hora por hora calculadas con el terreno y las efemérides SPICE, con un deslizador del Sol en el mapa. |
| ¿Me escuchan desde el hábitat? | Desde dónde hay línea de vista por radio con el hábitat, y cuántos minutos seguidos se camina sin ella. |
| ¿Dónde me cubro? | Refugios (lugares con poco cielo visible) y minutos caminando hasta el más cercano. |
| ¿Cómo me oriento sin GPS? | Indicaciones por trecho mirando el paisaje ("andá hacia el cerro que tenés a las 12, unos 8 min"), con cráteres y cerros que se ven desde 1,7 m de altura, y el Sol y la sombra para confirmar el rumbo. |

Todo termina en un veredicto **GO / CAUTION / NO-GO** que dice qué límite manda ("Limita: regreso antes del atardecer") y en cuántos escenarios de estrés la ruta sigue en pie. Además: el horizonte en primera persona desde cada parada (Three.js sobre el relieve real) y un modo entrenamiento con lecciones que se corrigen con la respuesta real del planificador.

Dos sitios: **Jezero** (Perseverance) y **Gale** (Curiosity). Sumar otro es sumar un JSON en `sites/`.

## Cómo leer cada número

Cada número que muestra la app lleva un badge con su procedencia, la misión y el instrumento (por ejemplo `MRO HiRISE · DERIVED` o `MSL RAD · MODELED`). En el tooltip van la resolución, la fuente y los supuestos.

| Badge | Qué quiere decir | Ejemplo |
|---|---|---|
| **OBSERVED** | Lo midió un instrumento. | Elevación del DTM de HiRISE, masa de una herramienta de Apollo |
| **DERIVED** | Cálculo determinista sobre un dato observado. | Pendiente, sombra a una hora dada, posición de un cráter |
| **MODELED** | Sale de un modelo con supuestos, y los supuestos van a la vista. | O2 consumido, dosis acumulada, minutos al refugio |
| **ASSUMED** | Valor elegido por el equipo, todavía sin fuente citable. | Pendiente máxima de 25°, 10 min seguidos sin contacto |

Si un dato falta, la app dice que falta (`value: null`): nunca lo rellena con un estimado. Con datos a medias responde igual, avisa qué no pudo evaluar ("Ojo: …") y el veredicto pasa a CAUTION.

## Datos de la NASA que usamos

Qué se baja está declarado en [`sites/*.json`](sites/) y en los scripts de `pipeline/fetch_*`. Todo se baja con pedidos dirigidos, un pedido a la vez por servidor y respetando el `Crawl-delay` de PDS (10 s).

| Dato | Fuente | Misión · instrumento | Resolución | Badge en la app | Para qué |
|---|---|---|---|---|---|
| Topografía de Jezero | [DTM HiRISE del TRN de Mars 2020](https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif) (USGS), ~21 × 21 km | MRO · HiRISE | 1 m | OBSERVED (elevación) → DERIVED (pendiente, sombreado, curvas, peligro) | La base de casi todo: ruta, sombras, refugios, contacto, relieve 3D |
| Topografía de Gale | [DEM fusionado de Gale v3](https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif) (USGS) | MRO · HiRISE; CTX, HRSC y MOLA donde no hay estéreo HiRISE | grilla de 1 m (menos detalle real en las zonas rellenadas) | ídem | ídem |
| Topografía global | [DEM MOLA + HRSC v2](https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif) (USGS), recortado por sitio | MGS · MOLA + Mars Express · HRSC | 200 m | OBSERVED → DERIVED | Horizonte lejano: la sombra del borde del cráter, el cielo visible para la dosis y el relieve lejano del horizonte en primera persona |
| Imagen de Jezero | [Ortomosaico HiRISE](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif) (USGS) | MRO · HiRISE | 25 cm (teselado hasta ~0,64 m/px) | OBSERVED | Fondo del mapa |
| Imagen de Gale | [Mosaico color HiRISE LRGB](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif) (USGS) | MRO · HiRISE | — | OBSERVED | Fondo del mapa |
| Efemérides | [Kernels genéricos de NAIF SPICE](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/): `naif0012.tls`, `pck00011.tpc`, `de440s.bsp` y el último `mar*.bsp` | NASA/JPL · NAIF | — | DERIVED | Posición del Sol para las sombras, el amanecer y el atardecer |
| Térmico | Mosaicos controlados de THEMIS IR de noche (USGS): [Syrtis Major](https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc13_syrtis_major_nir/mc13_syrtis_major_nir.tif) y [Aeolis](https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc23_aeolis_nir/mc23_aeolis_nir.tif) | Mars Odyssey · THEMIS | 100 m | OBSERVED (brillo relativo de 8 bits, no temperatura) → MODELED (suelo suelto) | ¿Roca o arena? Sube el peligro de "bajo" a "medio" donde el suelo es probablemente suelto |
| Radiación | [Dosis en superficie de RAD](https://doi.org/10.1126/science.1244797): 0,64 ± 0,12 mSv/día (Hassler et al. 2014; [`reference/rad_surface_dose.json`](reference/rad_surface_dose.json)) | MSL Curiosity · RAD | una medición en Gale; la capa va a 100 m | MODELED | Presupuesto de dosis de la travesía |
| Hielo subsuperficial | [SWIM 2.0](https://swim.psi.edu/), composite de consistencia de hielo de 0–1 m | Odyssey (neutrones), MGS TES y THEMIS (térmico), MRO (geomorfología y radar SHARAD) | ~3 km | MODELED | ¿Hay hielo a mano? En los dos sitios no cambia ninguna decisión: la capa está oculta en el mapa |
| Espectral | CRISM MTRDR (browse de parámetros de resumen) vía el [Orbital Data Explorer](https://ode.rsl.wustl.edu/mars/) de PDS Geosciences | MRO · CRISM | la del producto MTRDR | DERIVED | Señales minerales como destinos posibles: un indicio desde órbita, no una identificación |
| Nombres de lugares | [Nomenclátor planetario IAU/USGS](https://planetarynames.wr.usgs.gov/) | IAU · USGS | — | DERIVED | Landmarks con nombre para las indicaciones y el buscador |
| Cráteres | [Base de cráteres de Robbins & Hynek 2012](https://astrogeology.usgs.gov/pygeoapi/collections/mars/robbinsv1) (API OGC de USGS) | Mars Odyssey · THEMIS (mosaico de día con el que se armó la base) | cráteres ≥ 1 km | DERIVED | Landmarks sin nombre para orientarse |
| Recorrido del rover | Waypoints de MMGIS: [Perseverance](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json), [Ingenuity](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/m20_heli_waypoints.json) y [Curiosity](https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json) | Mars 2020 · MSL | — | DERIVED | Lugares conocidos para buscar y planear (posiciones del rover, aeródromos de Ingenuity) |
| Muestras | [Ubicación de los tubos de Three Forks](https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_sample_depot_three_forks/miscellaneous/sample_metadata/sample_tube_locations.csv) (PDS Geosciences) | Mars 2020 | posición del rover al soltar cada tubo | DERIVED | El depósito de muestras como destino |
| Objetivos científicos | Listas de observaciones en PDS Geosciences: [SuperCam](https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_supercam/data_observation_log/m2020_scam_masterlist.csv) y [PIXL](https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_pixl/data_oxides_pmc/collection_data_oxides_pmc_inventory.csv) en Jezero; [ChemCam](https://pds-geosciences.wustl.edu/msl/msl-m-chemcam-libs-4_5-rdr-v1/mslccm_1xxx/document/msl_ccam_obs.csv) y APXS ([soles 0–3076](https://pds-geosciences.wustl.edu/msl/urn-nasa-pds-msl_apxs_supplement_sols_0_3076/data/ds01_2021je007171r.csv), [3054–3712](https://pds-geosciences.wustl.edu/msl/urn-nasa-pds-msl_apxs_supplement_sols_3054_3712/data/ds01_2024.csv)) en Gale | Mars 2020 · SuperCam, PIXL; MSL · ChemCam, APXS | posición medida por APXS, o la del rover al medir (si quedó a más de 10 m, se avisa) | DERIVED | Destinos con nombre donde el rover midió algo |
| Masas de herramientas | Herramientas de Apollo 16 y 17 (Allton 1989, JSC-23454; *Apollo Lunar Surface Journal*) | Apollo | — | OBSERVED (masa medida), con el supuesto de que un kit marciano pesaría lo mismo | ¿Cuánto O2 me cuesta llevar el taladro? |

La Hora Solar Local y la estación (Ls) del lado del cliente salen del algoritmo [Mars24](https://www.giss.nasa.gov/tools/mars24/) de NASA GISS (Allison & McEwen 2000), el mismo en la API y en el navegador. El chequeo contra SPICE (`pipeline/check_mars24.py`) está armado, pero su referencia todavía no está en el repo.

**Bajados pero todavía sin usar.** Están en el server pero ningún paso del pipeline los procesa aún, así que la app muestra "falta el dato" donde irían: MEDA (Mars 2020) y REMS (MSL) para las condiciones del día, alertas de clima espacial de DONKI (WSA-Enlil), radargramas de RIMFAX, el campo magnético cortical de Langlais et al. 2019, la composición química de SuperCam, ChemCam y PIXL, y THEMIS de día. Las fotos del rover por parada tienen el contrato definido pero el endpoint no está implementado. Detalle en [`docs/infra y setup.md`](docs/infra%20y%20setup.md#4-datos).

## Supuestos de los modelos

Acá está todo número que no sale de una medición. Los **ASSUMED** los eligió el equipo y están para discutirse: cambiar uno es editar una línea de código y la fila del doc que lo explica. Desde la pestaña "Ajustes" del planificador se pueden mover los límites y los pesos de una ruta (salvo la pendiente máxima), y el veredicto avisa que se calculó con ajustes del usuario.

### Límites del veredicto (`api/safety.py`)

Si se rompe uno, es NO-GO. No se compensan entre sí. Detalle en [`docs/seguridad.md`](docs/seguridad.md).

| Límite | Valor | Badge del valor | Cómo se mide en la ruta |
|---|---|---|---|
| Pendiente máxima | **25°** | ASSUMED | La pendiente que no se puede esquivar en cada celda del A\* (la f-ésima más alta de sus f × f píxeles): una franja empinada que cruza la celda bloquea, una roca suelta no |
| Reserva de O2 al volver | **20 %** de la capacidad | MODELED (capacidad del traje; el 20 % es nuestro) | O2 consumido según Pandolf |
| Reserva de batería al volver | **20 %** | MODELED (ídem) | Consumo eléctrico fijo del traje |
| Volver antes del atardecer | **30 min** de margen | MODELED (atardecer de la pila de sombras; el margen es nuestro). ASSUMED sin pila | Duración de la travesía contra el atardecer con terreno |
| Minutos seguidos sin contacto | **10 min** (default del briefing) | ASSUMED | Racha más larga sin línea de vista al hábitat, contando las esperas |
| Dosis por EVA | **0,5 mSv** (a revisar) | ASSUMED | Tasa de dosis promedio de la ruta × tiempo afuera |
| Calorías | sin definir | — | Se calculan y se muestran, pero no cuentan en el veredicto |

- **Puntaje** = 100 × el margen más chico entre los límites (margen = 1 − usado / límite). El límite que da ese mínimo es el factor limitante que muestra la UI.
- **CAUTION** si el puntaje es menor a 20, si la ruta falla en algún escenario de estrés o si un límite no se pudo evaluar del todo. **GO** en otro caso.
- **Robustez:** la misma ruta, sin cambiar el camino, evaluada otra vez saliendo 30 min tarde, caminando un 20 % más lento y con un 10 % más de carga. "Tormenta de polvo" y "sin el refugio más cercano" figuran como **no evaluables**: no tenemos un modelo que los calcule y no inventamos su efecto.

### Elegir la ruta: costo del A\* (`api/planner.py`)

```text
costo = Σ celdas Δt · (1 + Σ_k w_k · r_k(celda, hora de llegada))
```

`Δt` es el tiempo de caminata y cada `r_k` va de 0 a 1 en la celda, **a la hora en que llegás**: eso hace al planificador 4D. Pesos activos: pendiente (w = 2), sombra a esa hora (w = 1) y sin línea de vista al hábitat (w = 1). Rugosidad, suelo suelto y radiación por terreno tienen peso, pero el A\* todavía no las lee. Los pesos son del equipo.

### Terreno: peligro (`pipeline/terrain_layers.py`)

La clase es la peor entre la de pendiente y la de rugosidad (σ del DTM sin la tendencia, en 5 m). Detalle y justificación de cada corte en [`docs/terreno.md`](docs/terreno.md).

| Clase | Pendiente | Rugosidad σ | ≈ escalones de |
|---|---|---|---|
| bajo | < 10° | < 0,15 m | < 0,3 m |
| medio | 10–20° | 0,15–0,25 m | 0,3–0,5 m |
| alto | 20–25° | 0,25–0,40 m | 0,5–0,8 m |
| no transitable | ≥ 25° | ≥ 0,40 m | ~1 m o más |

- El 25° es una decisión del equipo, no sale de la bibliografía. Como referencia, los astronautas de Apollo caminaron en pendientes de menos de 15° (Iqbal et al. 2024).
- **Suelo suelto (THEMIS, MODELED):** el 20 % más frío de noche dentro del sitio, solo si ese percentil queda a ≥ 5 DN de la mediana. Sube "bajo" a "medio", nunca más: un dato de 100 m alcanza para avisar, no para bloquear. Los dos números son nuestros.
- La pendiente se calcula con el tamaño real del píxel sobre la esfera (radio 3396190 m): en Jezero, `gdaldem` daba 28,7° donde hay 30°.
- Un DTM de 1 m no ve rocas de menos de ~3–5 m, y su precisión vertical es de decenas de cm.

### Traje y consumibles (`api/consumables.py`)

Pandolf et al. (1977) con la corrección de bajadas de Santee et al. (2001), integrado cada 10 m sobre el DTM y ajustado a 0,38 g: los términos de carga y caminata se escalan con la gravedad y el de estar parado no (hipótesis nuestra). Los valores por defecto son los del EMU de la ISS. Fórmula, contrato del endpoint y fuentes en [`docs/consumibles del traje.md`](docs/consumibles%20del%20traje.md).

| Parámetro | Valor | Estado |
|---|---|---|
| Masa del astronauta | 80 kg | a verificar |
| Masa del traje con soporte vital | 127 kg (EMU, ~280 lb) | a verificar |
| Gravedad | 0,38 g | confirmado |
| Factor de terreno (η de Pandolf) | 1,1 (regolito compacto ≈ camino de tierra) | supuesto propio |
| Velocidad de caminata | 0,8 m/s (~2,9 km/h), fija | supuesto propio |
| Energía por litro de O2 | 20,1 kJ/L | confirmado |
| O2 disponible | 0,55 kg (O2 primario del PLSS, sin la reserva de emergencia) | a verificar |
| Batería | 446,9 Wh (16,8 V × 26,6 Ah), 90 % aprovechable | capacidad a verificar; eficiencia, supuesto propio |
| Consumo eléctrico fijo | 55 W | supuesto propio |

Con esto, caminar en plano gasta ~600 W, el O2 alcanza para ~3,6 h y la batería para ~7,3 h: **el O2 es el que limita**. Límites del modelo: Pandolf se validó hasta ±25 % de grado (~14°) y con cargas más livianas que un traje (por eso probablemente sobreestima), no modela la rigidez del traje presurizado y la velocidad no cambia con la pendiente ni con la carga. La carga del equipo usa masas de herramientas de Apollo (OBSERVED); la carga a mano es ASSUMED.

### Radiación (`pipeline/radiation.py`)

```text
dosis(celda) = H0 × cielo_visible(celda) / cielo_visible(Bradbury Landing)
```

H0 = 0,64 ± 0,12 mSv/día (26,7 µSv/h), la dosis equivalente que midió RAD en Gale entre agosto de 2012 y junio de 2013. El cielo visible sale del horizonte hasta 60 km (DTM cerca, DEM de 200 m lejos) y se normaliza en el lugar donde midió RAD. Como la dosis cambia de un lugar a otro **menos que la incertidumbre de RAD** (±19 %), se muestra como presupuesto de la travesía y no entra al costo del A\*. Límites: el modelo isótropo sobreestima el blindaje del terreno (es una cota), y H0 no cambia con el ciclo solar, la estación ni las tormentas solares. Detalle en [`docs/radiation.md`](docs/radiation.md).

### Luz y sombra (`pipeline/illumination.py`)

Posición del Sol con SPICE en el centro del sitio y trazado de sombras sobre el DTM de 1 m más el DEM de 200 m hasta 100 km (borde del cráter), con la curvatura de Marte. Pila de máscaras cada 1 h de hora solar local. Supuestos: Sol puntual (sin penumbra), sin refracción ni polvo, sin luz difusa, y un mismo Sol para todo el sitio (error < ±0,2° en Jezero, ±0,5° en Gale). Si la fecha pedida no se precomputó, se usa la pila de otro sol de la **misma estación** (|ΔLs| ≤ 2°, ≤ 0,9° de declinación) y pasa a MODELED; si no hay ninguna, la luz queda sin evaluar y el veredicto lo dice. Detalle en [`docs/illumination.md`](docs/illumination.md).

### Contacto con el hábitat (`api/contact.py`, `api/viewshed.py`)

Radio solo en línea de vista directa, sin repetidores ni difracción. Antena del hábitat a 3 m del suelo y la del traje a 2 m, descontando la curvatura de Marte. El DTM se promedia para el cálculo, así que los obstáculos más chicos que la celda no se ven. Un tramo sin dato de visibilidad no cuenta como "sin contacto": si podría romper el límite, queda en CAUTION.

### Refugios (`pipeline/shelter.py`)

Refugio de emergencia para 2–3 personas: lugares con **≤ 85 %** de cielo visible (refugio fuerte: **≤ 75 %**), pendiente < 25° y al menos 10 m², calculado a 2 m. Es reparo geométrico, no una dosis calculada, y los dos umbrales son nuestros. Los minutos hasta el refugio usan la función de Tobler (1993) escalada a 0,8 m/s en plano (MODELED). Detalle en [`docs/refugios.md`](docs/refugios.md).

### Navegación por landmarks (`api/directions.py`)

Cada tramo se parte en trechos donde el rumbo gira más de 30°. Para cada trecho se elige el landmark que mejor se ve desde 1,7 m de altura (línea de vista sobre el DTM cerca y el DEM de 200 m lejos), priorizando lo que está al frente, lo grande y lo que no se confunde con otro parecido. El Sol se usa para confirmar el rumbo solo entre 3° y 65° de elevación. Si no se ve nada, la indicación cae a "seguí con el Sol" o a un rumbo y dice por qué: **nunca se inventa un landmark**.

## Cómo correrlo

**Requisitos:** Python 3.12, GDAL del sistema (en Ubuntu 24.04: `gdal-bin` y `python3-gdal`; el pipeline usa `gdaldem`, `gdal2tiles` y `ogr2ogr`) y Node 22. Con los datos completos son decenas de GB y horas de descarga: solo el ortomosaico de Jezero pesa 7,4 GB.

### Solo el frontend

```bash
cd web
npm install
npm run dev            # http://localhost:5173
```

Sin backend arranca en **modo ejemplo**: datos de prueba locales y un cartel rojo que avisa que ningún valor es una medición. Para usar un backend real, copiá `web/.env.example` a `web/.env.local` y poné en `VITE_API_TARGET` la dirección del server: Vite le reenvía `/api` y `/tiles`.

### La API

```bash
python3.12 -m venv .venv-api
.venv-api/bin/pip install -r api/requirements.txt
DATA_DIR=/data .venv-api/bin/uvicorn api.main:app --port 8000     # desde la raíz del repo
```

Sin datos, la API responde igual: `/api/health` anda y las consultas de un sitio sin datos devuelven 404 o `value: null` con una nota (el frontend lo maneja). La API no sirve `/tiles/`: en el server eso lo hace nginx con [`deploy/nginx.conf`](deploy/nginx.conf), que también pone `/api/` en el mismo origen.

### El pipeline de datos

```bash
python3.12 -m venv --system-site-packages .venv-pipeline     # usa el GDAL del sistema
.venv-pipeline/bin/pip install -r pipeline/requirements.txt -r pipeline/requirements-dev.txt
export DATA_DIR=/data                                           # cualquier carpeta con espacio

# 1. Bajar (horas; se reanuda si se corta)
.venv-pipeline/bin/python pipeline/download.py         # lo de sites/*.json → raw/ + manifest.json
.venv-pipeline/bin/python pipeline/fetch_extras.py     # Robbins, SWIM, DONKI, Langlais (NASA_API_KEY opcional)
bash pipeline/fetch_science.sh                         # THEMIS y CRISM
.venv-pipeline/bin/python pipeline/fetch_targets.py    # nombres de los objetivos de PIXL (~20 min por el Crawl-delay)

# 2. Precomputar, por sitio (jezero, gale)
.venv-pipeline/bin/python pipeline/precompute.py --site jezero --prueba   # recorte de 2 × 2 km para probar rápido
.venv-pipeline/bin/python pipeline/precompute.py --site jezero            # relieve, peligro, térmico, dosis, agua y tiles
.venv-pipeline/bin/python pipeline/shelter.py --site jezero               # refugios
.venv-pipeline/bin/python pipeline/illumination.py --site jezero --start 2026-11-15T00:00:00 --sols 1
.venv-pipeline/bin/python pipeline/shadow_tiles.py --site jezero          # tiles de sombra por hora
.venv-pipeline/bin/python pipeline/places.py --site jezero                # lugares para el buscador y los landmarks
```

`precompute.py --ortho` suma la ortoimagen (la más cara: horas). Las salidas van a `$DATA_DIR/output/<sitio>/`, cada capa con un índice (`terrain.json`, `shelter.json`) que dice su procedencia, su resolución y si salió bien; el mapa prende solo las capas que el índice marca como listas. Nada escribe dentro del repo.

### Tests

```bash
.venv-pipeline/bin/python -m pytest pipeline/tests     # con MAPEANDO_KERNELS=<carpeta de kernels> corre también lo de SPICE
.venv-api/bin/pip install pytest httpx && .venv-api/bin/python -m pytest api/tests
cd web && npm run build                                 # typecheck + build, lo mismo que corre el CI
```

El server, el auto-deploy y el acceso del equipo están en [`docs/infra y setup.md`](docs/infra%20y%20setup.md).

## Estructura del repo

| Carpeta | Qué hay |
|---|---|
| `sites/` | Un JSON por sitio (Jezero, Gale) + `common.json`: qué se baja y de dónde. |
| `pipeline/` | Python que descarga y precomputa (rasterio, numpy, spiceypy, GDAL). Lo pesado se hace acá, no en un request. |
| `api/` | FastAPI: inventario, consulta por punto, planificador 4D (`/api/route`), consumibles, contacto y sombras. Solo lee lo precomputado. |
| `web/` | React 19 + MapLibre GL + Three.js (Vite). Solo dibuja. |
| `reference/` | Tablas de referencia versionadas (dosis de RAD en superficie). |
| `docs/` | Métodos, supuestos y contratos. Empezá por [`context.md`](docs/context.md). |
| `deploy/` | Bootstrap del server, nginx, systemd y auto-deploy. |

Documentación por tema: [`seguridad.md`](docs/seguridad.md) (veredicto y ruta), [`consumibles del traje.md`](docs/consumibles%20del%20traje.md), [`terreno.md`](docs/terreno.md), [`radiation.md`](docs/radiation.md), [`illumination.md`](docs/illumination.md), [`refugios.md`](docs/refugios.md), [`educacion.md`](docs/educacion.md) (modo entrenamiento) y [`frontend y backend.md`](docs/frontend%20y%20backend.md).

## Uso de IA

Space Apps permite usar herramientas de IA y pide decir dónde y cómo. Esto es lo que hicimos:

- **En el desarrollo, sí.** Programamos con **Claude Code** (Anthropic) como asistente: escribió y revisó buena parte del código, los tests y la documentación, siempre a pedido de una persona del equipo que revisa lo que hace. Al 15/11/2026, unos dos de cada tres commits lo llevan como coautor (`Co-Authored-By`). Las instrucciones que le dimos están en el repo, a la vista: [`CLAUDE.md`](CLAUDE.md), [`docs/context.md`](docs/context.md) y las skills de [`.claude/skills/`](.claude/skills/), entre ellas "no inventes datos" y "respetá el Crawl-delay de PDS".
- **En los datos, no.** Ningún número científico lo generó una IA: cada valor sale de un dataset de la tabla de arriba, de un modelo publicado (Pandolf, Tobler, SPICE, Mars24) o de un supuesto del equipo marcado ASSUMED. Los límites y umbrales los decidió el equipo.
- **En la app, no.** No hay IA en tiempo de ejecución: ni la API ni el frontend llaman a un modelo de lenguaje. La ruta sale de un A\* determinista y el veredicto, de reglas fijas que están en [`docs/seguridad.md`](docs/seguridad.md).

## Créditos

### Datos

- **NASA/JPL-Caltech:** Mars Reconnaissance Orbiter, Mars 2020 (Perseverance e Ingenuity), Mars Science Laboratory (Curiosity), Mars Odyssey, MMGIS y NAIF SPICE.
- **HiRISE:** NASA/JPL-Caltech/University of Arizona. **CRISM:** NASA/JPL-Caltech/JHUAPL. **THEMIS:** NASA/JPL-Caltech/Arizona State University. **MOLA:** NASA/GSFC (Mars Global Surveyor). **RAD:** NASA/JPL-Caltech/SwRI.
- **HRSC:** ESA/DLR/FU Berlin (Mars Express).
- **USGS Astrogeology Science Center:** mosaicos de DTM e imagen de Jezero y Gale, DEM MOLA + HRSC, mosaicos controlados de THEMIS, nomenclátor planetario (con el Grupo de Trabajo de Nomenclatura de la IAU) y el servicio de la base de cráteres de Robbins.
- **PDS Geosciences Node** (Washington University in St. Louis): Orbital Data Explorer y los productos de Mars 2020 y MSL.
- **SWIM:** Subsurface Water Ice Mapping, Planetary Science Institute.
- **Mars24:** NASA Goddard Institute for Space Studies.
- **Apollo:** catálogo de herramientas de NASA JSC (Allton 1989) y *Apollo Lunar Surface Journal*.

Usar datos públicos de la NASA no implica que la NASA respalde este proyecto.

### Software

MapLibre GL JS, React, Three.js, Zod, Zustand, Tailwind CSS y Vite en el frontend (con las fuentes de rótulos de OpenMapTiles); FastAPI y uvicorn en la API; GDAL, rasterio, NumPy, SciPy, scikit-image y SpiceyPy en el pipeline.

### Referencias

- Hassler, D. M. et al. (2014). Mars' surface radiation environment measured with the Mars Science Laboratory's Curiosity rover. *Science* 343(6169), 1244797.
- Pandolf, K. B. et al. (1977). Predicting energy expenditure with loads while standing or walking very slowly. *Journal of Applied Physiology* 43(4).
- Santee, W. R. et al. (2001). A proposed model for load carriage on sloped terrain. *Aviation, Space, and Environmental Medicine* 72(6).
- Soule, R. G. & Goldman, R. F. (1972). Terrain coefficients for energy cost prediction. *Journal of Applied Physiology* 32(5).
- Tobler, W. (1993). *Three presentations on geographical analysis and modeling*. NCGIA Technical Report 93-1.
- Zakšek, K., Oštir, K. & Kokalj, Ž. (2011). Sky-view factor as a relief visualization technique. *Remote Sensing* 3(2).
- Robbins, S. J. & Hynek, B. M. (2012). A new global database of Mars impact craters ≥1 km: 1. Database creation, properties, and parameters. *Journal of Geophysical Research: Planets* 117.
- Fergason, R. L. et al. (2006). High-resolution thermal inertia derived from the Thermal Emission Imaging System (THEMIS): Thermal model and applications. *Journal of Geophysical Research* 111, E12004.
- Viviano-Beck, C. E. et al. (2014). Revised CRISM spectral parameters and summary products based on the currently detected mineral diversity on Mars. *Journal of Geophysical Research: Planets* 119.
- Allison, M. & McEwen, M. (2000). A post-Pathfinder evaluation of areocentric solar coordinates with improved timing recipes for Mars seasonal/diurnal climate studies. *Planetary and Space Science* 48.
- Allton, J. H. (1989). *Catalog of Apollo Lunar Surface Geological Sampling Tools and Containers*. JSC-23454, NASA Johnson Space Center.
- Iqbal et al. (2024). *Acta Astronautica* (pendientes caminadas en Apollo).
- Sutton, S. S. et al. (2022). *Remote Sensing* 14, 2403 (precisión de los DTM HiRISE).

### Equipo

**Mapeando Ando** · NASA Space Apps Challenge 2026

- Castro Maria del Pilar
- Cejas Dana
- Joaquin Ignacio
- Guido Pacienzia
- Mariano Perrone
- Lucas Ruberto Ruiz

---

*Prototipo educativo, no software de vuelo.*
