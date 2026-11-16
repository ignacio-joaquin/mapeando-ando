# Capas de terreno · pendiente, peligro, térmico y agua

Método, parámetros y limitaciones de las capas de terreno que salen de `pipeline/precompute.py`. El resumen para quien evalúa el proyecto está en el [README](../README.es.md#supuestos-de-los-modelos); acá está el detalle. Si cambia un parámetro en el código, se actualiza acá en el mismo PR.

## Pendiente (`pipeline/precompute.py`)

La pendiente no sale de `gdaldem slope`: los DTM de USGS están en equirectangular con paralelo estándar en el ecuador, y en Jezero un "metro" de la proyección mide 0,948 m hacia el este. gdaldem da 28,7° donde hay 30°. El script usa el tamaño de píxel real sobre la esfera de 3396190 m, fila por fila.

## Peligro de terreno: pendiente + rugosidad (`pipeline/terrain_layers.py`)

Responde "¿piso caminable, pendiente fuerte, bloques o arena?". Es un paso más de `precompute.py`: queda registrado en `terrain.json` como `survival-hazard` y se tesela en `hazard/`. También se puede correr suelto sobre una carpeta que ya tenga `dtm.tif` y `slope.tif`: `python pipeline/terrain_layers.py --dir /data/prueba/jezero`.

| Archivo | Unidad | Qué es |
|---|---|---|
| `hazard.tif` (+ tiles `hazard/`) | clase | 0 bajo · 1 medio · 2 alto · 3 no transitable · 255 sin dato |
| `roughness.tif` | m | Rugosidad σ: desvío estándar, en 5 m, del residuo del DTM tras restar el promedio en 15 m |
| `terrain_factor.tif` | η | Factor de terreno de Pandolf, **solo por rugosidad** (para el modelo de consumibles) |

**Clase = la peor entre la de pendiente y la de rugosidad.** Los cortes usan "≥", como `api/planner.py`: una celda de 25° justos es no transitable en el mapa y en el planificador. **Con THEMIS** (sección siguiente), el terreno "bajo" con suelo suelto probable pasa a "medio"; nunca más que eso.

| Clase | Pendiente | Rugosidad σ | ≈ escalones de |
|---|---|---|---|
| 0 bajo | < 10° | < 0,15 m | < 0,3 m |
| 1 medio | 10–20° | 0,15–0,25 m | 0,3–0,5 m |
| 2 alto | 20–25° | 0,25–0,40 m | 0,5–0,8 m |
| 3 no transitable | ≥ 25° | ≥ 0,40 m | ~1 m o más |

Los cortes de pendiente son los mismos que `SLOPE_CLASSES` (`web/src/map/layers.ts`), `RAMPAS["pendiente"]` (`pipeline/tiles.py`) y `SLOPE_CUTS` (`api/planner.py`); el último es el límite duro `max_slope_deg` de `api/safety.py`.

**Solo geometría:** no incluye gravedad, traje ni carga (se aplican en otra etapa).

### Por qué rugosidad "sin la tendencia"

La diferencia entre vecinos (`gdaldem roughness`) crece en cualquier ladera, aunque sea lisa, y repite la pendiente. Si primero se resta el promedio local en 15 m, en una ladera lisa el residuo da ~0 y solo quedan bloques y escalones. Es el mismo criterio de "detrended terrain ruggedness" usado para analizar las travesías de Apollo 15 y 16 (Jacob et al., LPSC, NASA NTRS 20250011301). La ventana de 5 m coincide con la resolución horizontal real de un DTM HiRISE, que no es mejor que 3–5 píxeles (Kirk, MSL Landing Site Workshop).

### σ no es la altura del escalón

σ es un desvío estándar. En un campo de bloques de altura *h* que cubren una fracción *p* del suelo, σ = h·√(p(1−p)), que vale como mucho **h/2** (con p = 0,5), y al restar la tendencia da un poco menos. En simulación, un campo denso de bloques de 1 m da una σ mediana de 0,46–0,48 m. Por eso el corte de no transitable es **σ ≥ 0,40 m**, que corresponde a bloques o escalones de ~1 m. Lo verifica `pipeline/tests/test_terrain_layers.py` ("bloques de 1 m → no transitable", "bloques de 30 cm → nunca no transitable").

### Pendiente máxima

Los astronautas de Apollo caminaron en pendientes de menos de 15° (Iqbal et al., 2024, *Acta Astronautica*), y la planificación de caminatas en el polo sur lunar limita las travesías a menos de 20°. **El límite de 25° para "no transitable" es una decisión del equipo** (`api/safety.py`, ver `docs/seguridad.md`), no un número de esa bibliografía: esta capa lo toma tal cual para que el mapa y el planificador digan lo mismo.

### η de Pandolf

Interpolación lineal de σ entre anclas, saturada en los extremos: σ ≤ 0,05 m → 1,1 (camino de tierra; el regolito nunca es asfalto), 0,15 m → 1,2 (matorral liviano), 0,25 m → 1,5 (matorral denso), ≥ 0,40 m → 1,8 (pantano). Los valores de η de referencia son de Soule & Goldman (1972), usados en Pandolf et al. (1977). En Pandolf la pendiente entra aparte, como el grado **G**, y depende de la dirección de marcha: la calcula el planificador sobre la ruta con `dtm.tif` (`G = 100 · Δz / Δd`). Todavía no está conectado a `api/consumables.py`, donde `terrain_factor` es la constante 1.1.

### Limitaciones

- Precisión vertical de un DTM HiRISE de 1 m: decenas de cm (Sutton et al., 2022, *Remote Sensing* 14:2403). El corte más bajo (σ 0,15 m) queda cerca de ese ruido. En un recorte de 2×2 km del piso de Jezero, el 99 % del terreno tiene σ < 0,16 m.
- Un DTM de 1 m no ve rocas sueltas de menos de ~3–5 m: la rugosidad marca zonas con bloques, no rocas individuales.
- Roca firme vs. arena suelta (η 2,1 en Pandolf): solo con THEMIS, a 100 m y con un criterio relativo. Sin THEMIS no lo distingue.
- En Gale, la parte del DEM rellenada sin detalle da rugosidad 0: ahí la clase sale solo de la pendiente.
- Cerca de los huecos del DTM, las ventanas usan solo las celdas válidas.

## Capa térmica y suelo suelto (`pipeline/thermal.py`) · Mars Odyssey THEMIS · OBSERVED

Responde "¿esto es roca o arena?". Paso de `precompute.py`, antes del peligro de terreno. Lee el recorte del IR nocturno de THEMIS que deja `pipeline/fetch_science.sh` en `raw/<sitio>/themis/*_nir_crop.tif`. Suelto: `python pipeline/thermal.py --site jezero --dir /data/prueba/jezero` (después, `terrain_layers.py --dir` en la misma carpeta lo usa solo).

| Archivo | Procedencia | Qué es |
|---|---|---|
| `themis_night.tif` (+ tiles `thermal/`) | OBSERVED | IR nocturno de THEMIS recortado al DTM, **sin remuestrear** (100 m, DN 0–255, 0 sin dato). Capa `survival-thermal` del mapa, en gris |
| `themis_display.tif` (intermedio, no se publica) | — | El mismo recorte con el brillo estirado entre el p2 y el p98 del sitio, para teselar: sin estirar, Jezero se ve todo gris medio. Los tiles van con vecino más cercano: se ven los cuadros de 100 m |
| `loose_soil.tif` | MODELED | 1 suelto probable · 0 no · 255 sin dato. `terrain-loose-soil` en `terrain.json`; no se dibuja, entra en el peligro |

**Por qué de noche.** De día manda el sol: las laderas que lo miran se calientan más. De noche cada material devuelve el calor que juntó, a su ritmo: la roca y el suelo compacto (inercia térmica alta) se enfrían despacio y se ven tibios; la arena, el polvo y el grano fino (inercia térmica baja) se enfrían rápido y se ven fríos. Es el dato clásico para separar arena suelta de roca (Fergason et al., 2006, *JGR* 111:E12004).

**Qué es y qué no es el dato.** Los mosaicos controlados de USGS son productos **cualitativos de 8 bits**: los valores se estiraron y mezclaron entre imágenes para que no haya costuras. El brillo es relativo dentro del sitio, no una temperatura ni una inercia térmica en unidades. Por eso: el badge del mapa es OBSERVED (es la imagen de THEMIS, sin tocar) y todo lo que se deduce de ella es MODELED.

**Criterio de suelo suelto.** El 20 % más frío del sitio (`LOOSE_PERCENTILE`; con DN enteros, los empates en el umbral pueden marcar algo más). Los percentiles salen solo de los píxeles de THEMIS que tocan DTM válido: el recorte es un rectángulo y el DTM no (en Gale es una franja diagonal). Se marca solo si ese percentil queda a ≥ 5 DN de la mediana (`MIN_CONTRAST_DN`): un percentil siempre encuentra "el 20 % más frío", aunque el sitio sea parejo, y en ese caso no se marca nada y se avisa. Los dos números son del equipo.

**Cómo refuerza el peligro.** Cada píxel de 1 m toma el valor del píxel de THEMIS que lo contiene (vecino más cercano: no se promedia ni se inventa). Donde la clase geométrica es "bajo" y el suelo es suelto probable, pasa a "medio": arena en un llano no te frena en seco, pero hunde el paso y cansa. **Nunca sube a "alto" ni a "no transitable"**: un dato de 100 m con registro de ±150–275 m alcanza para avisar, no para bloquear. `summary.pct_raised_by_loose_soil` dice cuánto subió. Si falta THEMIS, la capa térmica queda en `error`, el peligro sale solo con la geometría y la corrida no falla.

### Limitaciones

- 100 m por píxel y registro absoluto de ~150–275 m (1,5 a 2,75 píxeles): los megaripples chicos no se ven, y en el mapa el refuerzo aparece en cuadros de 100 m.
- Criterio relativo: en un sitio todo arenoso marca solo lo más arenoso.
- Polvo fino y arena se ven igual de fríos; para caminar, los dos son "suelo blando".
- Una alternativa con unidades (J m⁻² K⁻¹ s⁻½) es el mosaico **cuantitativo** de inercia térmica de THEMIS (Fergason, USGS); no está bajado.
- El A\* todavía no usa `loose_soil.tif` (factor `loose_soil`, inactivo en `docs/seguridad.md`).

## Capa de agua (`pipeline/swim.py`) · SWIM 2.0 · MODELED

Responde "¿hay hielo a mano?". Paso de `precompute.py`. Lee el composite de consistencia de hielo de **0–1 m** de SWIM 2.0 (Subsurface Water Ice Mapping, PSI) que deja `pipeline/fetch_extras.py` en `raw/common/swim2/SWIM2_c0_1.tif`, lo recorta al DTM **sin remuestrear** y lo escribe como `ice_consistency.tif` (float32, ~3 km/px, −100 sin dato), con tiles en `water/`. Suelto: `python pipeline/swim.py --dir /data/prueba/jezero`.

**Qué es el dato.** Un índice de −1 a +1 que combina neutrones (Mars Odyssey), térmico (MGS TES, THEMIS), geomorfología (MRO) y radar (SHARAD): +1 = los datos son consistentes con hielo, 0 = sin indicio, −1 = van en contra. No dice cuánto hielo hay: es MODELED. La leyenda es divergente con el 0 casi blanco, para que un indicio débil no parezca "acá hay hielo".

**Qué da en nuestros sitios** (bbox de `sites/*.json`, 2026-11-15):

| Profundidad | Jezero (64 píxeles) | Gale (240 píxeles) | Decisión |
|---|---|---|---|
| 0–1 m | −0,37 a −0,19 (0 % > 0) | −0,01 a +0,17, media 0,07 (83 % > 0) | **capa** `survival-water` |
| 1–5 m | −0,5 a +0,5, media −0,03 | −0,5 a +0,5, media −0,06 | descartada: salta entre ±0,5 y se cancela |
| > 5 m | 0 en todo | 0 en todo | descartada: sin información |

En el mapa la capa va **oculta** (`hidden: true` en `web/src/map/layers.ts`): con píxeles de ~3 km cada sitio se ve de un solo color y no cambia ninguna decisión. El dato sigue en `terrain.json`.

### Limitaciones

- Píxel de ~3 km: en el recorte de prueba (2 km) la capa es un solo cuadrado. Tiles hasta z10 (`FIXED_MAX_ZOOM`) para que el borde de cada cuadrado no quede corrido.
- El índice sube también con el hidrógeno de minerales hidratados: el +0,17 de Gale es un indicio débil, no hielo confirmado.
- El portal de SWIM (swim.psi.edu) estuvo caído el 2026-11-15 (error 523 de Cloudflare): se usó la copia ya bajada en el server.
