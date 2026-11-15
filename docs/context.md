# docs/context.md · Mapa Marciano

> Contexto compartido del proyecto para todo el equipo y para cualquier asistente de IA.
> `CLAUDE.md` lo carga en cada sesión. Si cambia una decisión del proyecto, **se cambia acá** y en el mismo PR; no en la cabeza de una persona ni en un chat.

---

## 1. Core value

**Que alguien parado en la superficie de Marte pueda tomar una mejor decisión de supervivencia, con datos reales de la NASA.**

Todo lo demás es secundario. Tres consecuencias prácticas:

1. **Decisión, no decoración.** Cada capa, número y pixel tiene que responder una pregunta operativa: ¿puedo pisar acá? ¿por dónde voy? ¿cuánta radiación acumulo? ¿cuánto me queda de luz? Si una pantalla es linda pero no cambia una decisión, no va todavía.
2. **Honestidad del dato por sobre la completitud.** Un dato real con hueco es mejor que un hueco rellenado. Nunca presentar un valor inventado, interpolado o estimado como medido: se declara la fuente, la misión y la resolución, y se dice "estimado" cuando lo es. Es nuestra ventaja en el challenge y es lo único que haría usable esto de verdad.
3. **Honestidad del alcance.** Prototipo educativo, **no software de vuelo**. Ese disclaimer va visible en la interfaz y no se saca.

**Qué estamos construyendo:** mapa de supervivencia para una EVA en Marte — NASA Space Apps 2026, challenge *Interplanetary Survival Guide: Martian Map*. Tres piezas: planificador 4D (espacio + tiempo), capas de supervivencia a 1 m de resolución, navegación por landmarks visibles desde el suelo.

**Para quién escribimos la UI:** alguien con el casco puesto, apurado, con guantes y poca banda. Legible, alto contraste, nada crítico comunicado solo por color.

**Restricción dura:** es un hackathon con deadline. Ante la duda entre hacerlo bien y hacerlo general, hacerlo bien y simple para los dos sitios que ya tenemos.

---

## 2. Estado y arquitectura

```
sites/      1 JSON por sitio (jezero, gale) + common.json   → sumar un sitio = sumar un archivo
pipeline/   Python: descarga + precómputo (rasterio, numpy, spiceypy, GDAL)
api/        FastAPI: estado, inventario, point query (/api/sites/{site}/point), /api/route y consumibles (/api/route/consumables)
web/        Frontend: React 19 + MapLibre (Vite). En el server se compila con deploy/build-web.sh
deploy/     bootstrap, nginx, systemd, auto-deploy
reference/  tablas de referencia versionadas (ej. dosis en superficie)
docs/       documentación del proyecto (este archivo)
```

**El flujo de datos, en una línea:** `sites/*.json` declara qué bajar → `pipeline/` baja a `/data/raw/` y precomputa a `/data/output/` → nginx sirve eso en `/tiles/` → la API lee `/data/manifest.json` y responde consultas puntuales → `web/` dibuja.

**Build y deploy del frontend** (resuelto 2026-11-14): el auto-deploy compila `web/` en el server cuando cambia (`deploy/build-web.sh`, Node 22). Compila fuera del repo (`/var/lib/mapeando-web`), publica cada build en `/var/www/mapeando/releases/<sha>` y nginx sirve el symlink `/var/www/mapeando/current`. Si el build falla, sigue la versión anterior y el error queda en `/var/log/mapeando-deploy.log`. El CI corre `npm run build` en cada PR para que no llegue a `main` algo que no compila.

**La regla de reparto:** lo pesado se precomputa en el pipeline; la API solo lee e indexa; el frontend solo dibuja. Si algo tarda más de ~1 s en un request, va al pipeline.

### Stack acordado

| Capa | Qué | Nota |
|---|---|---|
| Datos | Python 3.12, rasterio 1.4, numpy **1.26** (1.x a propósito), spiceypy, GDAL del sistema | versiones pineadas |
| API | FastAPI + uvicorn, stdlib siempre que alcance | corre en una EC2 chica |
| Web | React 19 (con React Compiler) + TypeScript strict + Tailwind 4 + MapLibre GL | Zustand para estado, Zod para validar lo que entra de la API |
| Tests | pytest (Python), Playwright (E2E del mapa) | |
| Infra | AWS EC2 us-east-2, Ubuntu 24.04, nginx + systemd, S3 para copia de crudos | |
| Plan | Linear, proyecto *Mapa Marciano — Space Apps 2026* | |

Nada que requiera API key o token en el cliente: **el repo es público**. Sin Mapbox, sin basemaps terrestres.

---

## 3. Reglas que no se negocian

1. **Ser educado con los servidores de la NASA.** Respetar `Crawl-delay` (PDS: 10 s), un pedido a la vez por host, `User-Agent` identificable, backoff ante 429/503, descarga dirigida. Un pipeline agresivo nos bloquea la IP y termina el proyecto.
2. **Cero secretos en el repo.** Ni claves, ni tokens, ni la IP del server, ni el nombre del bucket. Van en `/etc/mapeando.env` o en el rol IAM.
3. **Nunca escribir dentro del repo en runtime.** El auto-deploy hace `git reset --hard`. Todo dato va bajo `/data`.
4. **`main` es producción.** Cada push a `main` se despliega solo en menos de un minuto.
5. **Citar procedencia siempre.** Toda salida declara misión, instrumento y resolución.
6. **Unidades y marco únicos.** Grados decimales planetocéntricos, este positivo; metros; radio marciano `3396190` m.
7. **Degradar, no romper.** Los datos tardan horas en bajar: todo tiene que responder algo útil con datos a medias.

---

## 4. Cómo trabajamos

### Ramas

- Se commitea y pushea a **`Dana`**. Nadie commitea directo a `main`.
- `main` se actualiza **solo por PR aprobado**, y ese merge dispara el deploy. Mergear es desplegar: se hace con alguien mirando `/api/health` y los logs.
- PRs con conventional commits (`feat(web): ...`, `fix(pipeline): ...`). Ver skill `github-pr`.

### Definition of done

- [ ] CI verde: sintaxis Python, `sites/*.json` válidos, `bash -n deploy/*.sh`.
- [ ] Si toca datos: la procedencia y la resolución quedan visibles para el usuario final.
- [ ] Si toca un contrato (id de capa, `files[].key`, forma de una respuesta): frontend y API actualizados en el mismo PR.
- [ ] Si toca `api/` o `pipeline/`: tests de pytest, incluyendo el caso "datos todavía no están".
- [ ] Nada escribe en el repo, cero secretos en el diff.
- [ ] `docs/context.md` actualizado si cambió una decisión del proyecto.

### Nombres y contratos compartidos

`files[].key` en `sites/*.json`, los ids de capa del mapa (`survival-slope`, `landmarks-points`, `route-line`) y las rutas `/api/*` son **contratos**: los consume más de una pieza. Renombrarlos es breaking change y se hace en un PR que toca todas las puntas.

**Valor con procedencia.** Todo número que la API le manda al frontend (point query, `/api/route`, veredicto, fichas) viaja en este formato, y la UI lo dibuja con `<Measure>` y su badge:

```json
{
  "value": 0.64, "unit": "mSv/día",
  "provenance": "MODELED",
  "mission": "MSL", "instrument": "RAD",
  "resolution": "derivada, 200 m/px",
  "source": "Hassler et al. 2014",
  "assumptions": ["Base medida en Gale, extrapolada al terreno"]
}
```

- `provenance`: `OBSERVED` (medido por un instrumento), `DERIVED` (calculado de forma determinista desde un dato observado), `MODELED` (sale de un modelo con supuestos; debería traer `assumptions`) o `ASSUMED` (valor elegido por el equipo, sin fuente citable todavía; hoy, los límites duros del veredicto).
- `value: null` = el dato falta. Nunca se rellena.
- `mission` / `instrument` en `null` solo para cálculos locales sin fuente de misión.
- `resolution`, `source` y `assumptions` son opcionales y van al tooltip del badge.
- Lo valida `MeasuredValueSchema` en `web/src/api/schemas.ts`.

**`POST /api/route` (la consume el planificador de `web/`).** Es el endpoint del planificador 4D (`api/planner.py`; el modelo de costo está en §5). Lo valida `RouteResponseSchema` en `web/src/api/schemas.ts`. Los consumibles del traje sobre una ruta ya armada (Pandolf, PR #2) se mudaron a `POST /api/route/consumables`, con su contrato de siempre (ver README).

- Entra: `{ site, depart_utc, waypoints: [{ lat, lon, task, dwell_min }] }`. El primero es la salida, el último la llegada, el resto estaciones en orden. Salida y llegada pueden ser puntos distintos.
- Sale: `{ site, depart_utc, legs, stops, verdict }`.
  - `legs[]`: `from`, `to`, `coordinates` (`[lon, lat]`), `class` (`ok` | `caution` | `limit` | `blocked` | `unknown`) y `distance`, `duration`, `bearing`, `max_slope` como valor con procedencia. `unknown` = no se pudo evaluar el terreno; se dibuja punteado, nunca como `ok`. Opcional: `shadow_fraction` (% de la ruta en sombra a la hora de paso), solo si hay pila de sombras para ese sol o para uno de la misma estación (ver "Sol de la hora de salida" más abajo); en ese caso va `MODELED`.
    - `directions[]` (opcional): indicaciones para seguir el tramo mirando el paisaje, una por *trecho* (el tramo se parte donde el rumbo gira más de 30°). Las calcula `api/directions.py` con los cráteres, los rasgos con nombre y los cerros sin nombre (`kind: landmark`) de `places.json`, más el mástil del hábitat (punto A, con la línea de vista de `api/contact.py`), y línea de vista desde 1,7 m sobre el DTM (cerca) y el DEM de 200 m (lejos). Por indicación: `kind` (`toward` | `keep_left` | `keep_right` | `away` | `turn` | `fallback_sun` | `fallback_bearing`), `text` (la frase en español: duración y distancia, posición de reloj, y si hay parecidos, cuál es: "el de más a la izquierda de los dos"), `landmark` (`{ id, name, source: IAU | Robbins | DEM | habitat, lat, lon, target? }`, donde `target` es el punto que se mira cuando no es el centro, como el borde de un cráter visto desde adentro), `clock` (1–12, 12 = al frente; null en los respaldos), `relative_bearing_deg` (0 = al frente, + = derecha), y `distance`, `duration` (min, del modelo del traje) y `visible_fraction` (0–1) como valor con procedencia. Además:
      - `checks[]` ("vas bien si…", hasta 3): `{ kind: sun | habitat | landmark, text }` más la procedencia. `sun` = el Sol respecto del cuerpo y hacia dónde cae la sombra en reloj, o que a esa hora está muy alto (> 65°) y no sirve (se dice una vez por tramo); `habitat` = se ve el mástil; `landmark` = cómo se ve la referencia (distancia y altura en dedos y puños con el brazo estirado).
      - `until` ("pará cuando…"): `{ text, landmark }` con lo que queda al costado (60–120°) al final del trecho, o null si no hay nada.
      - `sun` (opcional): `{ azimuth_deg, elevation_deg }` a la hora de paso, más la procedencia: SPICE de la pila de sombras del sol (interpolado entre horas) o, sin pila, Mars24 (`MODELED`). El mapa lo dibuja en el paso resaltado.
      - `turn` es el trecho que empieza con un giro, definido por el landmark ("girá a la izquierda hasta tener X a las 12"). Los `fallback_*` son el respaldo: `fallback_sun` si el Sol sirve a esa hora (3–65° de elevación), si no `fallback_bearing`; van con `landmark: null`, `clock: null` y `visible_fraction.value: null`, y el `text` dice por qué (nada visible, falta `places.json`, falta terreno). Cualquier otro `kind` exige `landmark` (el schema lo rechaza si falta: nunca se inventa un landmark). Puntaje del candidato: fracción visible × tamaño aparente (tope 20°) × estabilidad × al frente 1 / al costado 0,7 / atrás 0,4, dividido por 1 + cantidad de parecidos (±15°, tamaño entre la mitad y el doble).
      - La procedencia de la posición del landmark la arma el frontend según `source`, igual que en `places.json` (todo `DERIVED`: Nomenclátor IAU; Robbins sobre THEMIS; `DEM` = cerro sin nombre que `places.py` saca del DTM de HiRISE; `habitat` = el punto A). Si el cálculo falla, el tramo sale sin `directions`. El planificador de ejemplo manda solo `fallback_bearing`, sin Sol ni confirmaciones.
  - `profile` (opcional): perfil de elevación, con la forma de `/api/route/consumables` más `straight_legs`. Solo viene si todos los puntos tienen cota del DTM. Un tramo sin camino (`blocked`, el A\* no encontró paso) igual entra: se mide la línea recta A→B sobre el DTM a la resolución de la grilla del tramo, y su índice va en `straight_legs`. Esa parte no es una ruta: el mapa la dibuja punteada y avisa; sirve para ver dónde está lo que bloquea. No entra en consumibles, duración ni costo. Sin DTM, no hay perfil. Diferencia con consumibles: acá `slope_deg` es la pendiente que juzga el veredicto (la máxima de la celda, `grid.peak`), no el desnivel entre muestras; así el perfil pinta en rojo el tramo que bloquea en vez de contradecir al NO-GO. En `/api/route/consumables` sigue siendo el desnivel entre muestras.
  - `stops[]`: `index`, `lat`, `lon`, `task`, `arrive_utc`, `depart_utc` (null en la salida y en la llegada final, respectivamente) y `o2_remaining`, `battery_remaining`, `dose_accumulated`, `margin` (min) como valor con procedencia.
  - `verdict`: `status` (`GO` | `CAUTION` | `NO_GO`), `limiting_factor` (`o2` | `battery` | `dose` | `daylight` | `terrain` | `contact` | `calories` | null), `summary` (una frase en español) y `margin` (min). Además, opcionales (el planificador de ejemplo no los manda):
    - `score`: valor con procedencia, 0–100 pts.
    - `limits[]`: por límite duro, `id`, `label`, `status` (`ok` | `broken` | `not_evaluated` | `undefined`), `complete`, `note`, `margin` (1 − usado/límite, recortado a −1), y `used` y `limit` como valores con procedencia. `limit` va `ASSUMED` cuando el número entero es del equipo; O2, batería y luz van `MODELED` (capacidad del traje, atardecer) con la parte del equipo en `assumptions`.
    - `robustness`: `{ passed, evaluated, scenarios: [{ id, label, status: pass | fail | not_evaluated, limiting_factor, score, note }] }`.
  - `cost` (opcional): `{ formula, unit, base_minutes, total_minutes, factors: [{ id, label, weight, active, minutes, note }] }`, el desglose del costo del A\* por factor.
  - `data_quality`: `{ terrain_status, terrain_evaluated, terrain_source, light_status, light_evaluated, light_source, contact_evaluated }`. `terrain_status` y `light_status` toman `complete` / `partial` / `missing`, y se calculan a partir de los tramos, no solo por la existencia de `slope.tif` o de la pila de sombras. Terreno: `complete` si todos los tramos pasaron por el A\*, `partial` si algunos, `missing` si ninguno. Luz: `missing` sin pila de sombras (ni propia ni de la misma estación); con pila, el atardecer siempre se evalúa, y es `complete` si todos los tramos midieron sombra (`shadow_fraction`) y `partial` si alguno no (en línea recta o sin dato). `terrain_evaluated` y `light_evaluated` son booleanos del estado completo, `terrain_source` vale `processed` si hubo pendiente y `missing` si no, `light_source` vale `exact`, `reused` o `missing`, y `contact_evaluated` marca si hubo DTM para la línea de vista al hábitat. La UI lee esto para la tarjeta del veredicto y nunca contradice los `caveats` del `summary`.
  - Modelo, valores y pesos: `docs/seguridad.md`.
- Sitio desconocido o sin manifest: **404**, y el frontend usa el planificador de ejemplo (`web/src/api/routeFixture.ts`) y lo avisa en pantalla (también ante 405/501). Con datos a medias responde 200: los tramos que no se pudieron evaluar van en línea recta como `unknown` y el `summary` dice qué faltó ("Ojo: …").

**`POST /api/illumination/window` (lo lee quien depura la pila de sombras; hoy no lo consume `web/`).** Sol/sombra precomputados en el rectángulo entre dos puntos, para una hora. Entra `{ site_id, sol_tag?, ltst | band, p1: {lat, lon}, p2: {lat, lon} }`; `sol_tag` es la carpeta del sol (`AAAAMMDDTHHMMZ`, default: el último). Sale `values[fila][col]` con `true` (sol), `false` (sombra) o `null` (sin dato), `cell_ground_m` real, `decimation` si se remuestreó y la procedencia. Sin pila precomputada responde 503: la API nunca corre el pipeline.

**Sombras por hora para el mapa (las consume el deslizador del sol de `web/`).** Las escribe `pipeline/shadow_tiles.py` a partir de la pila de `illumination.py`; nginx las sirve en `/tiles/<sitio>/illumination/`. Las plantillas son relativas a `/tiles/<sitio>/`, como en `terrain.json`. Las validan `IlluminationCatalogSchema` y `SolTilesSchema` en `web/src/api/schemas.ts`.

- `illumination/catalog.json`: `sols[]` con `tag`, `start_utc`, `end_utc`, `ls_deg`, `flat_sunrise`/`flat_sunset` (`{ utc, ltst }`), `step_min` y `tiles` (ruta del `tiles.json` del sol, o `null` si está calculado pero sin teselar).
- `illumination/<sol>/tiles.json`: `sol_tag`, `step_min`, `max_zoom` (el `--max-zoom` de la corrida), `sol`, `provenance` (DERIVED), `warnings` y `bands[]`: por hora con el Sol sobre el horizonte, `band`, `ltst`, `utc`, `sun_az_deg`, `sun_el_deg`, `lit_fraction` y `status`; si `ok`, `template` (`illumination/<sol>/tiles/<HHMM>/{z}/{x}/{y}.png`), `minzoom`, `maxzoom` y `bounds`.
- Colores de los PNG: sombra `RGBA 12 10 9 175`, sol transparente, sin dato `RGBA 120 130 150 110`, fuera del DTM transparente. Si cambian, cambia la leyenda de `survival-shadows` en `web/src/map/layers.ts`.
- El deslizador recorre el sol entero (medianoche a medianoche LTST) y "reproducir" va de amanecer a atardecer; los dos se marcan con horizonte plano y la UI lo dice. Las horas de noche no se teselan: con el Sol bajo el horizonte plano, el mapa pone un velo sobre el sitio, arriba de todo raster. No se interpola entre horas: el mapa muestra la máscara más cercana y dice de qué hora es.

**Sol de la hora de salida (lo eligen igual el veredicto y el deslizador).** `stack_for_time` en `api/illumination.py` y `pickSol` en `web/src/map/sun.ts`, con el mismo criterio:

1. El sol cuyo `[start_utc, end_utc)` contiene la salida.
2. Si no se precomputó, el de la **misma estación** más cercano: |ΔLs| ≤ 2° (`SOL_REUSE_MAX_DLS_DEG` en los dos lados; si cambia uno, cambia el otro), de cualquier año marciano. Se compara el Ls de la medianoche local de cada sol (Mars24 en `api/mars_time.py` y `web/src/mars/mars24.ts`, el mismo algoritmo). La pila se usa con todos sus instantes corridos a la medianoche local de la fecha pedida: misma hora solar local, mismas bandas y mismos tiles. Necesita `ls_deg` y `site_center.lon` en el `index.json` (las pilas viejas sin ellos solo sirven para su sol).
3. Si tampoco hay, la luz queda sin evaluar y el veredicto lo dice. Nunca se rellena.

Una pila reutilizada viaja como `MODELED`, con el sol de origen, ΔLs y la diferencia de declinación en `assumptions`; el `summary` del veredicto lo dice ("la luz se estimó con las sombras del sol …") y el deslizador muestra un aviso de "Estimado" con texto, no solo con color.

**`GET /tiles/{site}/terrain.json` (lo escribe `pipeline/precompute.py`, lo lee `web/`).** Índice de las capas de relieve de un sitio; el frontend prende una capa solo si este archivo dice que está lista. Lo valida `TerrainIndexSchema` en `web/src/api/schemas.ts`.

- `{ site, generated_at, mode, source, radius_m, gdal, grid, layers, warnings }`. `layers` va indexado por id de capa (`relief-slope`, `relief-hillshade`, `relief-contours`, `survival-thermal`, `survival-hazard`, `survival-dose`, `survival-water`, `relief-dem`, más `relief-far` (relieve lejano del horizonte en primera persona), `dtm`, `terrain-roughness`, `terrain-factor`, `terrain-loose-soil` y `survival-skyview`, que no se dibujan en el mapa, y `coverage`, que el planificador dibuja como contorno).
- `coverage` apunta a `coverage.geojson`: la huella del DTM de 1 m (polígonos en lon/lat, celdas de 10 × 10 px donde **todos** los píxeles tienen dato). El planificador rechaza un punto que cae afuera; sin esta capa acepta el punto y avisa que no lo pudo verificar.
- Por capa: `file`, `status` (`ok` | `error`), `error?`, `resolution?` (píxel real sobre el suelo), `provenance`, `assumptions?` y, si va teselada, `tiles`: `{ status: "ok", template, minzoom, maxzoom, bounds: [oeste, sur, este, norte], layer? }` o `{ status: "error", error }`. Las raster van en PNG; `relief-contours` va en tiles vectoriales MVT (`contours/{z}/{x}/{y}.pbf`; `layer` es el `source-layer` del mapa, `contours`, y el mapa lo lee de acá, con el de `layers.ts` solo de respaldo). Qué dibuja el mapa lo dice `file`: con `contours.gpkg` usa los tiles; con `contours.geojson` (corrida de antes de los tiles, `--no-tiles`, o un teselado que falló y dejó el GeoJSON de la corrida anterior) baja ese GeoJSON entero recién al prender la capa. El pipeline borra el GeoJSON viejo solo cuando los tiles salieron bien. Debajo del `minzoom` de los tiles la capa no dibuja nada y el panel de capas avisa que hay que acercarse.
- `survival-thermal` (lo escribe `pipeline/thermal.py`, como paso de `precompute.py`): `themis_night.tif` uint8, el IR nocturno de THEMIS (Mars Odyssey, 100 m) recortado al DTM **sin remuestrear**, 0 sin dato. OBSERVED, pero cualitativo: brillo relativo dentro del sitio (más tibio = roca, más frío = arena o polvo), no temperatura. `summary` trae `night_dn` (p5/p50/p95, sobre los píxeles que tocan DTM), `loose_threshold_dn`, `loose_pct`, `display_dn` y `warnings`. Tiles en `thermal/`, en gris, sin rampa, con vecino más cercano (cuadros de 100 m) y el brillo estirado entre el p2 y el p98 del sitio (`display.stretch_dn`): solo visual, el COG guarda los DN originales. De ahí sale `terrain-loose-soil` (`loose_soil.tif`, misma grilla, 1 suelto probable, 0 no, 255 sin dato, MODELED: el 20 % más frío del sitio si hay contraste, con percentiles sobre la huella del DTM y algo más si hay empates en el umbral; criterio en `params`), que no se dibuja. Si falta el recorte de THEMIS, `survival-thermal` va con `status: "error"` y la corrida no falla.
- `survival-hazard` (lo escribe `pipeline/terrain_layers.py`): `hazard.tif` uint8 con clases 0 bajo, 1 medio, 2 alto, 3 no transitable y 255 sin dato (`classes`, `nodata`); los cortes van en `params`, y los de pendiente son los de `SLOPE_CUTS` de `api/planner.py`. Con `terrain-loose-soil` en `ok`, el terreno "bajo" con suelo suelto probable pasa a "medio" (nunca más: THEMIS avisa, no bloquea); entonces `instrument` es `HiRISE DTM + THEMIS` y `summary.pct_raised_by_loose_soil` dice cuánto subió. DERIVED (`terrain-loose-soil` va MODELED). Tiles en `hazard/`.
- `survival-dose` (lo escribe `pipeline/radiation.py`, como paso de `precompute.py`): `dose_rate.tif` float32 con la dosis equivalente en µSv/h (`unit`), en una grilla propia de 100 m (no la del DTM), NaN sin dato. `display: "budget"`: se muestra como presupuesto de dosis de la travesía y el raster es una capa secundaria (§5). `method` describe el modelo y `summary` trae el rango real (`h0_usv_h`, `skyview_reference`, `skyview_median`, `dose_usv_h` con p1/p50/p99, `spread_vs_uncertainty`, `warnings`). `api/planner.py` (`_route_dose_rate`) la lee solo con `status: "ok"`; si no, usa la tasa de base de RAD. Tiles en `dose/`, con la escala fija de `RAMPAS["dosis"]` de `pipeline/tiles.py`, que es la leyenda de `survival-dose` en `web/src/map/layers.ts`: si cambia una, cambia la otra. `survival-skyview` (`skyview.tif`, fracción de cielo 0–1, misma grilla, DERIVED) no se dibuja. Es el sky-view **de la dosis** (hasta 60 km, a 100 m); el de refugios es otro, `survival-shelter-skyview` en `shelter.json`, y no comparten archivo.
- `survival-water` (lo escribe `pipeline/swim.py`, como paso de `precompute.py`): `ice_consistency.tif` float32, el composite de consistencia de hielo de 0–1 m de SWIM 2.0 (−1 a +1) recortado al DTM **sin remuestrear** (~3 km), −100 sin dato. MODELED, `mission` `Odyssey + MGS + MRO`, `instrument` `SWIM 2.0`. `summary` trae `consistency` (min/mean/max), `pct_positive` y `warnings`. Tiles en `water/` hasta z10, con `RAMPAS["agua"]` de `pipeline/tiles.py` = leyenda de `survival-water` en `web/src/map/layers.ts`. Si falta el composite, va con `status: "error"` y la corrida no falla.
- El nombre de la carpeta de tiles (`slope/`, `hillshade/`, `thermal/`, `hazard/`, `dose/`, `water/`, `contours/`) es el último segmento de la plantilla `tiles` de `web/src/map/layers.ts`.
- `relief-dem` es el relieve 3D del mapa (fuente `raster-dem` de MapLibre, no una capa de la lista). Tiles PNG en `dem/{z}/{x}/{y}.png`, hasta z15 (~2,5 m/px), con la altura codificada como `h = R·256 + G + B/256` sobre `datum_m` (el punto más bajo del DTM): así RGB 0 y lo que queda fuera de los tiles caen al piso del sitio y no a 0 m absolutos. La capa trae `datum_m` y `encoding` (`red_factor`, `green_factor`, `blue_factor`, `base_shift`), que el mapa le pasa tal cual a MapLibre. Huecos chicos del DTM rellenados para no dibujar pozos; fuera de la huella, plano. Solo para dibujar: ninguna medida sale de ahí.
- `relief-far` es el DEM global de 200 m (MOLA + HRSC) recortado al sitio con su `horizon_pad_deg` (`dem200_crop` de `download.py`), en los mismos tiles raster-dem que `relief-dem`: `far/{z}/{x}/{y}.png`, z7–z9 (~160 m/px), con su propio `datum_m` y `encoding`. No es una capa del mapa: la usa el horizonte en primera persona para dibujar lo que queda fuera del DTM (el borde del cráter, a decenas de km). En los dos, RGB 0 = sin dato: el horizonte no lo dibuja. Sin el recorte la capa queda en `error` y el horizonte se arma solo con el DTM, avisando. Solo para dibujar.
- El 3D se dibuja a escala vertical real: como MapLibre mide con el radio de la Tierra, el terreno sale estirado ×1,876 en horizontal y la altura se exagera lo mismo (`TERRAIN_TRUE_SCALE` en `web/src/mars/constants.ts`). En 3D no hay barra de escala (con la cámara inclinada no vale en toda la pantalla).
- Sin `terrain.json` (404), las capas de relieve quedan en "esperando el pipeline".

**`GET /tiles/{site}/shelter.json` (lo escribe `pipeline/shelter.py`, lo leen `web/` y el point query).** Índice de las capas de refugio: "¿dónde me cubro y a cuántos minutos?". Tiene la misma forma que `terrain.json` y también lo valida `TerrainIndexSchema`. Detalle del método en `docs/refugios.md`.

- `fetchTerrain` (`web/src/api/client.ts`) junta `terrain.json` y `shelter.json` en un solo índice. Por eso **los ids de capa no se repiten entre los dos archivos**: si se repitieran, uno taparía al otro. Si uno de los dos falla (500, JSON roto o no pasa el schema), las capas del otro siguen andando y el error va a `warnings`.
- `{ site, generated_at, mode, source, grid, layers, warnings }`; `grid` suma `walk_shape` y `walk_res` (la grilla de los minutos). Por capa, lo mismo que en `terrain.json` más `mission` (MRO HiRISE), `instrument` (HiRISE DTM), `unit`, `nodata`, `method`, `params` y `assumptions`.
- `survival-shelter-skyview`: `shelter_skyview.tif` float32, fracción de cielo visible 0–1 a 2 m, nodata −9999 (sin horizonte completo no hay número). DERIVED. Tiles en `shelter-skyview/`, rampa `cielo`.
- `survival-shelter`: `shelter.tif` uint8, 0 no, 1 refugio (cielo ≤ 85 %), 2 refugio fuerte (≤ 75 %), 255 sin dato, a 2 m (`values`; umbrales en `params`). DERIVED. Tiles en `shelter/`, rampa `refugio`.
- `survival-shelter-minutes` y `survival-shelter-strong-minutes`: `shelter_minutes.tif` y `shelter_strong_minutes.tif` float32, minutos caminando al refugio más cercano (cualquiera o solo los fuertes), a 10 m, nodata −9999 donde no se llega. **MODELED**: Tobler escalado a 0,8 m/s en plano (§5). Traen `median_min` y `p90_min`. Tiles en `shelter-minutes/` y `shelter-strong-minutes/`, rampa `minutos`.
- El corte de pendiente es el único del mapa (`terrain_layers.SLOPE_CUTS_DEG[-1]`, 25°): desde ese valor, inclusive, una celda no sirve de refugio ni se pisa, igual que en el A\*.
- Las rampas `cielo`, `refugio` y `minutos` de `pipeline/tiles.py` son las leyendas de esas capas en `web/src/map/layers.ts`, y los umbrales de `cielo` son los de `shelter.py`: si cambia una, cambian las otras. Las carpetas siguen la misma regla que en `terrain.json` (último segmento de la plantilla `tiles`). En `layers.ts`, estas capas llevan `script: "shelter.py"`, que es lo que la UI pide volver a correr si fallan.
- Sin `shelter.json` (404), las capas de refugio quedan en "esperando el pipeline" y el relieve sigue andando.

**`GET /api/sites/{site}/point?lat=&lon=` (lo consume el inspector de `web/`).** Qué hay en un punto. Lo valida `PointSchema` en `web/src/api/schemas.ts`.

- Sale: `{ site, lat, lon, elevation, slope, layers, note? }`. `elevation` (OBSERVED) y `slope` (DERIVED) salen del DTM, como valor con procedencia.
- `layers[]`: valores con procedencia, cada uno con `id` (el id de capa de `web/src/map/layers.ts`) y `label`. Hoy: `survival-shelter-minutes`, `survival-shelter-strong-minutes` y `survival-shelter-skyview`, muestreados de los COG de `shelter.json` (`SHELTER_POINT_LAYERS` en `api/main.py`). Una capa que no está `ok` no aparece; si el punto cae en su nodata, va con `value: null`. Sin `shelter.json`, `layers: []`.
- Sitio desconocido: 404. Sin DTM o con el punto afuera: 200 con `value: null` y una `note` que dice por qué. DTM ilegible: 503.

**`GET /tiles/{site}/places.json` (lo escribe `pipeline/places.py`, lo lee el buscador de destinos de `web/`).** Lugares del sitio para buscar y para los chips de sugeridos. Lo valida `PlacesIndexSchema` en `web/src/api/schemas.ts`.

- `{ site, generated_at, bbox, sources, places }`. `sources` dice por fuente (`iau`, `robbins`, `rover`, `landmarks`, `depressions`, `crism` y, si el sitio las declara, `heli`, `samples` y `targets`) si está `ok`, `missing` o `error`, con una `note` opcional (ej. cuántas observaciones no se pudieron ubicar).
- Por lugar: `id`, `name`, `kind` (`iau` | `sample` | `target` | `heli` | `rover` | `crater` | `landmark` | `depression` | `orbital`), `detail`, `lat`, `lon`, `suggested` y la procedencia (`provenance`, `mission`, `instrument`, `resolution?`, `source`, `assumptions?`), más `link?` a la ficha IAU.
- Fuentes: nomenclátor IAU (`common.json`), cráteres de Robbins (`fetch_extras.py`), cerros y hondonadas del DTM, señales de CRISM y, por `files[].key` del sitio, `rover_waypoints`, `heli_waypoints` (aeródromos de Ingenuity, en su último aterrizaje) y `sample_depot_locations` (CSV de PDS con un tubo por fila; `files[].name` le da el nombre al depósito). Un sitio que no declara un `key` no tiene esa fuente.
- Del DTM del sitio (`/data/output/<sitio>/dtm.tif`, DERIVED, necesita `precompute.py`; se lee una sola vez a 10 m): cerros sin nombre (`landmark`: máximos que se elevan ≥ 30 m sobre lo más bajo en 500 m, buscados a 30 m) y hondonadas (`depression`: ≥ 8 m bajo lo más alto en 150 m, posibles cráteres, sin afirmar que lo sean). El id va por posición (`landmark-<lat>-<lon>`, `depression-<lat>-<lon>`, 4 decimales): otra corrida no lo pasa a otro lugar.
- Señales minerales de CRISM (`orbital`, DERIVED), de los browse MTRDR de `raw/<sitio>/crism/` (`fetch_science.sh`): en cada observación, el punto donde un parámetro de resumen (D2300, D2200, BD1900R2, OLINDEX3, MIN2295_2480; Viviano-Beck et al. 2014) es más fuerte, mediana de 5 × 5 px lejos del borde de la escena. Entra solo si pasa un umbral nuestro, que se declara en `assumptions`; el valor real va en el `detail`, con el motivo con el que MRO apuntó la observación si `index.json` lo trae. Es un indicio desde órbita, no una identificación mineral, y así se dice. Id `crism-<observación>-<parámetro>`; nombre "Señal de <mineral> (<parámetro>)", con un número de la más fuerte a la más débil cuando hay varias del mismo parámetro. Si dos observaciones marcan el mismo parámetro a menos de 200 m, queda la más fuerte. El motivo sale de `comment` en `index.json`, que `fetch_science.sh` guarda desde que le pide a ODE `results=mf`: un `index.json` bajado antes no lo trae y el lugar sale igual, sin motivo.
- Objetivos científicos (`kind: target`), de PDS Geosciences: `chemcam_obs` (Gale), `supercam_obs` y `pixl_inventory` (Jezero) y `apxs_targets*` (Gale). PIXL no publica lista: `pipeline/fetch_targets.py` baja una etiqueta por observación (~110, con el Crawl-delay) y saca el nombre. Un objetivo medido por varios instrumentos es un solo lugar (se agrupa por id normalizado: `John_Klein` y `John Klein` son el mismo). Posición: la que mide APXS si la hay; si no, la del rover al medir (cruce por site/drive con los waypoints de MMGIS). PIXL va en el brazo: su objetivo queda al alcance del brazo, pero la distancia no se publica y no se inventa (lo dice `assumptions`). Si la observación más cercana fue a más de 10 m, el lugar es el punto desde donde se observó y el `detail` lo dice ("observado desde acá a N m"). Se descartan cielo, blancos de calibración y atmósfera. `files[].instrument` nombra el instrumento.
- No entran: SHERLOC (sus etiquetas no traen el nombre del objetivo) y el dossier de muestras de Mars 2020 (solo PDF). La mayoría de sus objetivos también los midieron SuperCam o PIXL.
- Solo lugares con el punto dentro del bbox del sitio. Los sugeridos salen de las fuentes (rasgos IAU más chicos, primera y última posición del rover, primer tubo de cada depósito, primer y último aeródromo, los 2 cerros de más relieve y hasta 3 objetivos científicos con posición confiable —de APXS o a ≤ 10 m— y más instrumentos encima), no se eligen a mano. Los tubos de Three Forks van en la posición del rover al soltarlos (lo declara `assumptions`). Lo que no publica ninguna fuente (ej. el boxwork de Gale) no se agrega con coordenadas inventadas.
- Sin `places.json` (404), el buscador avisa y el destino se elige con un clic en el mapa.

**Horizonte en primera persona (MAP-43).** Desde la ficha de cada estación se abre el terreno visto desde los ojos (1,7 m) con Three.js, en el navegador y sin endpoint: lo cercano sale de los tiles de `relief-dem` y lo lejano de `relief-far`, en una malla polar sobre la esfera de Marte (incluye la caída por curvatura). El Sol sale de Mars24 en el cliente (`web/src/mars/sunPosition.ts`), a la hora de llegada a la estación; si el relieve lo tapa, la vista lo dice. Colores, cielo y bruma son ilustrativos y la UI lo declara. Es la base del modo HUD, la Postal y la comparación con la foto del rover.

**Travesía en la URL.** `?site=jezero&depart=<ISO UTC>&pts=lat,lon,min[,id de lugar];…`, en orden: hábitat, paradas, destino. `ret=0` = solo ida; sin `ret`, la travesía incluye la vuelta al hábitat. El hábitat no es un punto fijo del sitio: lo marca el usuario cada vez. El planificador devuelve una sola ruta, la más segura; no hay alternativas. Los puntos de un enlace pasan por el mismo chequeo que un clic: cuando llega `coverage.geojson`, los que caen afuera se sacan y el aviso dice cuáles; si el que cae afuera es el hábitat, se borra la travesía y se pide marcarlo de nuevo. Un `site` que no existe abre el primer sitio y descarta los puntos. Los ids de lugar llevan letras y números de cualquier idioma, `_`, `.` y `-` (nunca `,` ni `;`).

**Ida y vuelta.** Por defecto el planificador calcula también la vuelta del destino al hábitat (se apaga en el panel): un GO que solo alcanza para ir no sirve para decidir. No cambia el contrato de `POST /api/route`: el frontend agrega el hábitat otra vez como último waypoint (`task: "Vuelta al hábitat"`, `dwell_min: 0`), y la respuesta trae un tramo y una parada más. Con vuelta, los minutos en el destino cuentan como en cualquier parada.

**`GET /api/sites/{site}/photos?lat=&lon=` (propuesta, MAP-33).** Fotos reales del rover más cercanas a un punto, para la ficha de cada estación. El cruce (punto → waypoint MMGIS → sol → fotos crudas de mars.nasa.gov, prefiriendo Navcam / Mastcam / Mastcam-Z) es del backend; el frontend solo dibuja. Lo valida `RoverPhotosSchema` en `web/src/api/schemas.ts`.

- Sale: `{ photos: [...], note? }`, ordenadas de la más cercana a la más lejana. Por foto: `url`, `url_full?`, `mission`, `rover`, `camera`, `sol`, `taken_utc?`, `credit`, `lat`/`lon` del waypoint y `distance` (valor con procedencia, m) entre el punto pedido y ese waypoint.
- `credit` es obligatorio: NASA/JPL-Caltech; Mastcam-Z: NASA/JPL-Caltech/ASU; Mastcam: NASA/JPL-Caltech/MSSS.
- `composition` (opcional, MAP-53): composición elemental medida por el rover cerca de ese waypoint. `{ summary?, elements: [...], note? }`; cada elemento es un valor con procedencia más `element` (ej. `"SiO2"`, unidad `"% en peso"`) y `note?`. La ficha de la estación usa la de la foto más cercana que la traiga y dice de qué sol es y a qué distancia está. Sin dato, no viene el campo y la ficha dice que falta. La valida `RoverCompositionSchema`.
- Subsuelo (RIMFAX en Jezero, campo magnético grueso en Gale) todavía no tiene contrato: la ficha dice que falta el dato.
- Sin fotos cerca: `photos: []` y una `note`. Nunca una foto de ejemplo.
- Mientras el server responda 404/405/501, la ficha dice que falta el endpoint.

### Idioma

Código, ids, endpoints y nombres de archivo en **inglés**. Comentarios, docs, commits, PRs y UI en **español**.

---

## 5. Decisiones abiertas

Cosas que hay que resolver en equipo; quien las resuelva, lo escribe acá.

- **Formato de tiles de salida**: resuelto para el relieve (2026-11-14): raster pre-teselado. El COG es la fuente de valores (point query, perfil) y lo que se dibuja son tiles XYZ PNG en `/data/output/<sitio>/<capa>/{z}/{x}/{y}.png`, que genera `pipeline/tiles.py` (lat/lon de Marte etiquetado como EPSG:4326 + `gdal2tiles --xyz`). `precompute.py` lo corre para pendiente, sombreado y peligro y anota zoom y límites en `terrain.json`. Las capas por clases (pendiente, peligro) se remuestrean con vecino más cercano en el pipeline y en el mapa, para no inventar colores fuera de la leyenda. Todas las rampas se pintan con `gdaldem color-relief -nearest_color_entry` (2026-11-15): cortes netos, sin colores mezclados entre tramos; cada rampa dice de qué lado queda el corte (`RAMPAS_CERRADAS_ARRIBA` en `pipeline/tiles.py`) y `pipeline/tests/test_tiles.py` lo verifica. Sol y sombra, resuelto (2026-11-14): tiles PNG por hora en `illumination/<sol>/tiles/<HHMM>/`, que genera `pipeline/shadow_tiles.py` (vecino más cercano, hasta z15 por defecto), con `catalog.json` y `tiles.json` como índices (contrato en §4). Vectores grandes, resuelto (2026-11-15): las curvas de nivel salen en tiles MVT `{z}/{x}/{y}.pbf` (`ogr2ogr -f MVT`, mismo truco de EPSG:4326, sin comprimir: los gzipea nginx), porque el GeoJSON de Gale pesaba cientos de MB y se bajaba entero aunque la capa estuviera apagada. De lejos (zoom 10–12) solo van las curvas cada 50 m; las de 10 m entran desde el zoom 13. `precompute.py --solo-tiles-curvas` los genera sobre una corrida ya hecha, sin rehacer el resto. Gale abre en zoom ~9 (menos en el celular), debajo del 10: ahí el panel de capas pide acercarse en vez de bajar el zoom mínimo sin saber cuánto pesan los tiles de Gale a z9.
- **Alcance del planificador 4D**: qué paso temporal y qué rango de soles se precomputa. Parcial (2026-11-14): sol y sombra se precomputan por sol, con fecha y cantidad de soles como parámetros (`--start`, `--sols`) y paso de 1 h LTST. El mapa muestra el sol que contiene la hora de salida del planificador (2026-11-14). **Reutilización por estación** (2026-11-15): si ese sol no se precomputó, el veredicto y el mapa usan la pila de otro sol con |ΔLs| ≤ 2° (≈ 4 soles, ≤ 0,9° de declinación), de cualquier año marciano, como `MODELED` (contrato en §4). No vale "el mismo día del año terrestre": un año terrestre después Marte está en otra estación (~190° de Ls). Falta decidir qué soles se precomputan para la demo y correrlos con `illumination.py` + `shadow_tiles.py`; cada sol calculado cubre ~±4 soles de su estación en cualquier año. Ver `docs/illumination.md`.
- **Dosis de radiación** (2026-11-14): resuelto. Se muestra como **presupuesto de dosis de la travesía**, no como mapa de zonas: la dosis por celda (`survival-dose`, `pipeline/radiation.py`) varía menos que la incertidumbre de RAD (±19 %). El planificador la promedia sobre la ruta; el raster es una capa secundaria con escala fija de 0 a la base. Unidad: dosis equivalente (mSv, µSv/h). Detalle en `docs/radiation.md`.
- **Capa de agua (SWIM)** (2026-11-15): resuelto. Se midió el composite de SWIM 2.0 en el bbox de cada sitio. **0–1 m: capa** `survival-water` (Jezero −0,37 a −0,19, sin indicio de hielo; Gale −0,01 a +0,17, indicio débil). **1–5 m y > 5 m: descartadas**: el de 1–5 m salta entre −0,5 y +0,5 con media ~0 en los dos sitios y el de > 5 m es 0 en todo. Números y limitaciones en el README. **En el mapa va oculta** (`hidden: true` en `web/src/map/layers.ts`, 2026-11-15): con píxeles de ~3 km, cada sitio se ve de un solo color y no cambia ninguna decisión; el dato sigue en `terrain.json`.
- **Modelo de rutas**: resuelto en una segunda versión (2026-11-14), falta validarlo con datos reales. El detalle está en `docs/seguridad.md`.
  - **A\*** (`api/planner.py`) sobre `slope.tif`, con costo = Σ Δt · (1 + Σ w_k · r_k(celda, hora de llegada)).
  - **Factores activos:** pendiente (w = 2), sombra según la banda de `shadow_hourly.tif` más cercana a la hora de llegada (w = 1) y sin línea de vista al hábitat (w = 1).
  - **Factores con peso pero inactivos:** rugosidad y suelo suelto ya tienen capa (`roughness.tif`, σ en m, y `loose_soil.tif`, de THEMIS, los dos de `precompute.py`), pero el A\* todavía no las lee. La radiación por terreno va al presupuesto de dosis, no al costo.
  - **Celdas que no se pisan:** las que superan la pendiente máxima (límite duro, 25°). Se mide con la **f-ésima pendiente más alta** de los f × f píxeles de `slope.tif` de la celda: una franja que la cruza bloquea, una roca suelta no.
  - **Corte único de 25°** (2026-11-14): el A\*, la clase `blocked` del tramo, la leyenda del mapa y los tiles de pendiente cortan en 25° (antes 30°). Los tiles ya generados hay que regenerarlos con `precompute.py`.
  - **Ventana:** cada tramo se resuelve con margen (≥ 300 m), promediado a ≤ 300 × 300 celdas.
  - **Veredicto** (`api/safety.py`): límites duros sin compensación (pendiente, reserva de O2 y batería, regreso antes del atardecer, minutos sin contacto, dosis, calorías), puntaje = 100 · el margen más chico y robustez en escenarios de estrés. GO / CAUTION / NO-GO.
  - **Minutos al refugio** (`pipeline/shelter.py`, aparte del A\*): Tobler escalado a 0,8 m/s en plano y el mismo corte de 25°, como costo provisorio. Ver `docs/refugios.md`.
  - **Pendiente de decidir:** los valores de los límites son `ASSUMED` hasta tener fuente; el equipo tiene que confirmarlos o cambiarlos, incluido el tope de calorías, que hoy está sin definir.

---

## 6. Glosario

| Término | Qué es |
|---|---|
| EVA | Extra-Vehicular Activity: salida a la superficie con traje |
| DEM / DTM | Modelo de elevación. Global 200 m (MOLA+HRSC); por sitio 1 m (HiRISE) |
| Ortho | Ortomosaico de imagen, 25 cm en Jezero |
| PDS | Planetary Data System: archivo público de datos de la NASA |
| SPICE | Toolkit del JPL para efemérides, tiempos y geometría |
| MMGIS | Visor de la NASA de donde salen los waypoints de los rovers |
| Manifest | `/data/manifest.json`: inventario de qué se bajó y qué falló |
| Sol | Día marciano (~24 h 39 m) |
