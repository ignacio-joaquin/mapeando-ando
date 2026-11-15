# Mapeando Ando · Mapa Marciano

Mapa de supervivencia para una EVA en la superficie de Marte (NASA Space Apps 2026, challenge *Interplanetary Survival Guide: Martian Map*): planificador 4D, capas de supervivencia a 1 m y navegación por landmarks.

Plan y tareas: proyecto **Mapa Marciano — Space Apps 2026** en Linear (equipo Mapeando Ando).

Contexto, decisiones, datos y estado del proyecto: [BITACORA.md](BITACORA.md).

## Estructura

| Carpeta | Qué hay |
|---|---|
| `sites/` | Un JSON por sitio (Jezero, Gale) + `common.json`. Sumar un sitio = sumar un archivo. |
| `pipeline/` | Python que descarga y precomputa (rasterio, numpy, spiceypy, GDAL). |
| `api/` | FastAPI: estado, inventario de datos, point query, `/api/route` (planificador 4D, `api/planner.py`) y `/api/route/consumables` (consumibles del traje). |
| `web/` | Frontend React + MapLibre (Vite). El server lo compila solo en cada deploy (`deploy/build-web.sh`). |
| `docs/` | Documentación del proyecto. `context.md` es la fuente única de contexto para el equipo y para la IA. |
| `deploy/` | Bootstrap del servidor, nginx, systemd y auto-deploy. |

## Servidor

- AWS EC2 en **us-east-2 (Ohio)**, Ubuntu 24.04. La IP pública está en Linear.
- `http://<IP>/` sirve el build de `web/`, `/api/*` va a FastAPI y `/tiles/*` sirve `/data/output/`.
- Datos crudos en `/data/raw/<sitio>/`, salidas en `/data/output/<sitio>/`, inventario en `/data/manifest.json`.
- Copia de los datos crudos en S3: `s3://<bucket>/raw/` (nombre en `/etc/mapeando.env`).

## Deploy automático

Cada push a `main` se despliega solo en menos de un minuto: un timer de systemd en el servidor hace `git fetch`, y si hay commits nuevos actualiza el código y reinicia la API. Si cambia algo en `deploy/`, vuelve a correr el bootstrap. Log: `/var/log/mapeando-deploy.log`. Para verificar qué versión corre: `GET /api/health` devuelve el commit.

No hay que guardar claves en GitHub: el repo es público y el servidor solo lee.

## Datos

`pipeline/download.py` baja todo lo de `sites/*.json`, recorta el DEM global de 200 m por sitio sin bajarlo entero, verifica que cada raster abra y escribe el inventario. Se reanuda si se corta.

```
sudo systemctl start mapeando-download        # volver a correr la descarga
journalctl -u mapeando-download -f             # ver el progreso
```

## Relieve: DTM, pendiente, sombreado y curvas

`pipeline/precompute.py --site <id>` toma el DTM del sitio (del manifest, o de S3 si no está en disco) y deja en `/data/output/<id>/` el DTM en COG, la pendiente en grados (misma grilla que el DTM), el sombreado, las curvas de nivel cada 10 m en GeoJSON y un `terrain.json` con la procedencia, los parámetros y el estado de cada capa. También tesela la pendiente y el sombreado en PNG para el mapa (`slope/`, `hillshade/`, con `pipeline/tiles.py`) y anota en `terrain.json` el zoom y los límites de esos tiles: el frontend lee ese archivo para saber qué capa puede prender. `--prueba` procesa un recorte de 2×2 km en `/data/prueba/`, fuera de lo que sirve nginx; `--no-tiles` saltea el teselado.

`precompute.py` también escribe `coverage.geojson`, la huella del DTM de 1 m que usa el planificador para rechazar destinos sin terreno. `pipeline/places.py --site <id>` arma `/data/output/<id>/places.json` (el índice del buscador de destinos) con el nomenclátor IAU, los cráteres de Robbins, los waypoints del rover y del helicóptero, el depósito Three Forks y los objetivos con nombre de ChemCam, SuperCam, PIXL y APXS (PDS); correlo después de `download.py`, `fetch_extras.py` y `fetch_targets.py` (que saca los nombres de PIXL de las etiquetas PDS, unos 20 minutos por el Crawl-delay). No hace pedidos HTTP: lee lo que ya está en `/data/raw/`.

```
cd /opt/mapeando-ando && sudo .venv-pipeline/bin/python pipeline/precompute.py --site jezero   # y después --site gale
```

La pendiente no sale de `gdaldem slope`: los DTM de USGS están en equirectangular con paralelo estándar en el ecuador, y en Jezero un "metro" de la proyección mide 0,948 m hacia el este. gdaldem da 28,7° donde hay 30°. El script usa el tamaño de píxel real sobre la esfera de 3396190 m, fila por fila.

## Sol y sombra con terreno

`pipeline/illumination.py` precomputa, por sol, una pila de máscaras de sol/sombra por hora LTST y el amanecer/atardecer de cada píxel con el terreno (DTM 1 m + DEM 200 m para el borde del cráter + efemérides SPICE). Funciona con cualquier DTM. Uso, formato de salida, método y límites: [docs/illumination.md](docs/illumination.md). `pipeline/shadow_tiles.py` tesela esas máscaras por hora para el deslizador de tiempo del sol del mapa.

## Consumibles del traje (`/api/route`) · MODELED

`POST /api/route/consumables` recibe una ruta ya armada y devuelve, por tramo, el gasto metabólico, el O2 y la batería, con los valores acumulados desde la salida. No hace pathfinding: eso lo hace `POST /api/route` (planificador 4D), que usa estas mismas funciones de consumo sobre la ruta que encuentra. Todo lo que devuelve lleva el badge **MODELED**.

```jsonc
// Pedido
{
  "site_id": "jezero",                       // obligatorio si los puntos no traen elev_m
  "points": [{"lat": 18.444, "lon": 77.450}, {"lat": 18.460, "lon": 77.420}],
                                              // un punto intermedio puede traer "dwell_min" (0–600):
                                              // minutos de trabajo parado en esa estación
  "speed_m_s": 0.8,                           // default 0.8 (~2.9 km/h)
  "cargo_kg": 0,                              // carga extra transportada (feature de carga del equipo, M2)
  "sample_step_m": 10,                        // paso de muestreo del DTM
  "suit": {"suit_kg": 127}                    // opcional: pisa cualquier supuesto de la tabla de abajo
}
// Respuesta (resumida)
{
  "badge": "MODELED",
  "elevation_source": "dtm:jezero",           // o "request" si los puntos traían elev_m
  "segments": [{"index": 0, "distance_m": 1935, "elev_gain_m": 60, "duration_s": 2425,
                "metabolic_w": 674, "o2_kg": 0.116, "o2_cum_kg": 0.116, "o2_remaining_pct": 78.9,
                "battery_wh": 41.2, "battery_cum_wh": 41.2, "battery_remaining_pct": 90.8,
                "dwell_s": 0, "dwell_o2_kg": 0, "dwell_battery_wh": 0, "dwell_energy_kj": 0, ...}],
  "totals": {..., "o2_exhausted_at_segment": null, "battery_exhausted_at_segment": null},
  "assumptions": {...},                       // los valores efectivamente usados
  "warnings": [...], "model_notes": [...]
}
```

**Permanencia.** La permanencia en un punto intermedio se suma al tramo que llega a ese punto: los `dwell_*` de ese tramo dicen cuánto se gastó parado (gasto de reposo de Pandolf más el consumo fijo del PLSS), y sus acumulados (`elapsed_s`, `*_cum_*`, `*_remaining_pct`) ya la incluyen. Si un recurso se agota durante la permanencia, `*_exhausted_at_segment` y `warnings` marcan ese tramo. En la salida y en la llegada final no cuenta, igual que en `POST /api/route`, que usa la misma función (`dwell_consumption`).

**Elevación.** Si todos los puntos traen `elev_m`, se usan esas cotas y cada tramo es una recta. Si no trae ninguno, la API densifica cada tramo cada `sample_step_m` y lee el DTM de 1 m del sitio (el que figura como `dtm` en el manifest). Mezclar puntos con y sin `elev_m` da 422, igual que un punto fuera del DTM o sobre nodata.

**Modelo y supuestos.** Pandolf (1977) con la corrección de bajada de Santee (2001), ajustado a 0.38 g. Los defaults son del EMU de la ISS: astronauta de 80 kg, traje de 127 kg, 0.55 kg de O2 primario y batería de 446.9 Wh. La fórmula, la tabla completa de supuestos con su origen y estado, los límites del modelo y cómo corregir un valor están en [docs/consumibles del traje.md](docs/consumibles%20del%20traje.md). Ese archivo es la fuente: si cambia un default en `SuitParams`, se actualiza ahí.

## Acceso al servidor

**SSH (equipo).** Cada integrante tiene su propio usuario, con sudo. El admin pasa usuario y contraseña por privado. Hay fail2ban: 8 intentos fallidos en 10 minutos bloquean la IP por 30 minutos.

- Entrar: `ssh <usuario>@<IP del server>`. La IP la pasa el admin; no se publica acá.
- Recomendado: subir tu clave pública con `ssh-copy-id <usuario>@<IP>`, para no depender de la contraseña.
- Alta de alguien nuevo por clave: `sudo mapeando-add-member <usuario> "<clave pública>"`

Para dar de baja a alguien: `sudo mapeando-remove-member <usuario>`.

Dentro del server, los datos están en `/data` y el repo en `/opt/mapeando-ando`. El bucket S3 se usa con `aws s3 ...` sin credenciales propias: el server tiene un rol IAM.

**Session Manager (admin).** También se puede entrar sin SSH desde la consola de AWS: EC2 → la instancia → Connect → Session Manager.


## Contexto y skills de IA (equipo)

Todo el equipo trabaja con el mismo contexto y las mismas skills, versionados en el repo. No hay que instalar nada: al clonar ya están.

| Archivo | Qué es |
|---|---|
| `docs/context.md` | **Fuente única de contexto**: core value, arquitectura, stack, reglas duras, cómo trabajamos, decisiones abiertas. Si cambia una decisión del proyecto, se edita acá en el mismo PR. |
| `CLAUDE.md` | Lo que lee Claude Code en cada sesión: carga `docs/context.md` y dice qué skill usar en cada área. |
| `.claude/skills/` | Skills propias (`mapeando-*`, `linear-task`) + skills curated de [Gentleman-Skills](https://github.com/Gentleman-Programming/Gentleman-Skills) copiadas. |
| `.claude/settings.json` | Permisos del proyecto (incluye no pushear a `main`). |
| `.claude/update-skills.sh` | Vuelve a traer las skills externas desde upstream. Se revisa el diff y va por PR. |

Si usás otro asistente (Cursor, Copilot, Gemini CLI), apuntalo a `docs/context.md`: es el mismo contenido.

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

### Pendiente
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

## Dosis de radiación por celda (`pipeline/radiation.py`) · MSL RAD · MODELED

Paso de `precompute.py`. Escribe `dose_rate.tif` (dosis equivalente, µSv/h, grilla de 100 m) y `skyview.tif`, y los registra en `terrain.json` como `survival-dose` y `survival-skyview`, con tiles en `dose/`.

`dosis = H0 × sky_view / sky_view(Bradbury Landing)`, con H0 = 0,64 ± 0,12 mSv/día medida por RAD en Gale. La dosis cambia con el lugar menos que la incertidumbre de RAD: **se muestra como presupuesto de dosis de la travesía** (el planificador promedia la dosis por celda sobre la ruta) y el raster queda como capa secundaria con escala fija. Modelo, decisión y limitaciones: [`docs/radiation.md`](docs/radiation.md).

## Capa de agua (`pipeline/swim.py`) · SWIM 2.0 · MODELED

Responde "¿hay hielo a mano?". Paso de `precompute.py`. Lee el composite de consistencia de hielo de **0–1 m** de SWIM 2.0 (Subsurface Water Ice Mapping, PSI) que deja `pipeline/fetch_extras.py` en `raw/common/swim2/SWIM2_c0_1.tif`, lo recorta al DTM **sin remuestrear** y lo escribe como `ice_consistency.tif` (float32, ~3 km/px, −100 sin dato), con tiles en `water/`. Suelto: `python pipeline/swim.py --dir /data/prueba/jezero`.

**Qué es el dato.** Un índice de −1 a +1 que combina neutrones (Mars Odyssey), térmico (MGS TES, THEMIS), geomorfología (MRO) y radar (SHARAD): +1 = los datos son consistentes con hielo, 0 = sin indicio, −1 = van en contra. No dice cuánto hielo hay: es MODELED. La leyenda es divergente con el 0 casi blanco, para que un indicio débil no parezca "acá hay hielo".

**Qué da en nuestros sitios** (bbox de `sites/*.json`, 2026-11-15):

| Profundidad | Jezero (64 píxeles) | Gale (240 píxeles) | Decisión |
|---|---|---|---|
| 0–1 m | −0,37 a −0,19 (0 % > 0) | −0,01 a +0,17, media 0,07 (83 % > 0) | **capa** `survival-water` |
| 1–5 m | −0,5 a +0,5, media −0,03 | −0,5 a +0,5, media −0,06 | descartada: salta entre ±0,5 y se cancela |
| > 5 m | 0 en todo | 0 en todo | descartada: sin información |

### Limitaciones
- Píxel de ~3 km: en el recorte de prueba (2 km) la capa es un solo cuadrado. Tiles hasta z10 (`FIXED_MAX_ZOOM`) para que el borde de cada cuadrado no quede corrido.
- El índice sube también con el hidrógeno de minerales hidratados: el +0,17 de Gale es un indicio débil, no hielo confirmado.
- El portal de SWIM (swim.psi.edu) estuvo caído el 2026-11-15 (error 523 de Cloudflare): se usó la copia ya bajada en el server.

---
Prototipo educativo, no software de vuelo.
