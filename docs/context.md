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
api/        FastAPI: estado, inventario, consumibles (/api/route/consumables) y (en camino) point query + /api/route
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

- `provenance`: `OBSERVED` (medido por un instrumento), `DERIVED` (calculado de forma determinista desde un dato observado) o `MODELED` (sale de un modelo con supuestos; debería traer `assumptions`).
- `value: null` = el dato falta. Nunca se rellena.
- `mission` / `instrument` en `null` solo para cálculos locales sin fuente de misión.
- `resolution`, `source` y `assumptions` son opcionales y van al tooltip del badge.
- Lo valida `MeasuredValueSchema` en `web/src/api/schemas.ts`.

**`POST /api/route` (propuesta, la consume el planificador de `web/`).** Es el endpoint del planificador 4D. El modelo de costo sigue siendo decisión abierta (§5); esto fija solo qué entra y qué sale. Lo valida `RouteResponseSchema` en `web/src/api/schemas.ts`. Hasta que el 4D exista, la API responde **501**. Los consumibles del traje sobre una ruta ya armada (Pandolf, PR #2) se mudaron a `POST /api/route/consumables`, con su contrato de siempre (ver README).

- Entra: `{ site, depart_utc, waypoints: [{ lat, lon, task, dwell_min }] }`. El primero es la salida, el último la llegada, el resto estaciones en orden. Salida y llegada pueden ser puntos distintos.
- Sale: `{ site, depart_utc, legs, stops, verdict }`.
  - `legs[]`: `from`, `to`, `coordinates` (`[lon, lat]`), `class` (`ok` | `caution` | `limit` | `blocked` | `unknown`) y `distance`, `duration`, `bearing`, `max_slope` como valor con procedencia. `unknown` = no se pudo evaluar el terreno; se dibuja punteado, nunca como `ok`.
  - `stops[]`: `index`, `lat`, `lon`, `task`, `arrive_utc`, `depart_utc` (null en la salida y en la llegada final, respectivamente) y `o2_remaining`, `battery_remaining`, `dose_accumulated`, `margin` (min) como valor con procedencia.
  - `verdict`: `status` (`GO` | `NO_GO`), `limiting_factor` (`o2` | `battery` | `dose` | `daylight` | `terrain` | null), `summary` (una frase en español) y `margin` (min).
- Mientras el server responda 404/405/501, el frontend usa un planificador de ejemplo (`web/src/api/routeFixture.ts`) y lo avisa en pantalla.

**`GET /tiles/{site}/terrain.json` (lo escribe `pipeline/precompute.py`, lo lee `web/`).** Índice de las capas de relieve de un sitio; el frontend prende una capa solo si este archivo dice que está lista. Lo valida `TerrainIndexSchema` en `web/src/api/schemas.ts`.

- `{ site, generated_at, mode, source, radius_m, gdal, grid, layers, warnings }`. `layers` va indexado por id de capa (`relief-slope`, `relief-hillshade`, `relief-contours`, más `dtm`).
- Por capa: `file`, `status` (`ok` | `error`), `error?`, `resolution?` (píxel real sobre el suelo), `provenance`, `assumptions?` y, si va teselada, `tiles`: `{ status: "ok", template, minzoom, maxzoom, bounds: [oeste, sur, este, norte] }` o `{ status: "error", error }`.
- El nombre de la carpeta de tiles (`slope/`, `hillshade/`) es el último segmento de la plantilla `tiles` de `web/src/map/layers.ts`.
- Sin `terrain.json` (404), las capas de relieve quedan en "esperando el pipeline".

**`GET /api/sites/{site}/photos?lat=&lon=` (propuesta, MAP-33).** Fotos reales del rover más cercanas a un punto, para la ficha de cada estación. El cruce (punto → waypoint MMGIS → sol → fotos crudas de mars.nasa.gov, prefiriendo Navcam / Mastcam / Mastcam-Z) es del backend; el frontend solo dibuja. Lo valida `RoverPhotosSchema` en `web/src/api/schemas.ts`.

- Sale: `{ photos: [...], note? }`, ordenadas de la más cercana a la más lejana. Por foto: `url`, `url_full?`, `mission`, `rover`, `camera`, `sol`, `taken_utc?`, `credit`, `lat`/`lon` del waypoint y `distance` (valor con procedencia, m) entre el punto pedido y ese waypoint.
- `credit` es obligatorio: NASA/JPL-Caltech; Mastcam-Z: NASA/JPL-Caltech/ASU; Mastcam: NASA/JPL-Caltech/MSSS.
- Sin fotos cerca: `photos: []` y una `note`. Nunca una foto de ejemplo.
- Mientras el server responda 404/405/501, la ficha dice que falta el endpoint.

### Idioma

Código, ids, endpoints y nombres de archivo en **inglés**. Comentarios, docs, commits, PRs y UI en **español**.

---

## 5. Decisiones abiertas

Cosas que hay que resolver en equipo; quien las resuelva, lo escribe acá.

- **Formato de tiles de salida**: resuelto para el relieve (2026-11-14): raster pre-teselado. El COG es la fuente de valores (point query, perfil) y lo que se dibuja son tiles XYZ PNG en `/data/output/<sitio>/<capa>/{z}/{x}/{y}.png`, que genera `pipeline/tiles.py` (lat/lon de Marte etiquetado como EPSG:4326 + `gdal2tiles --xyz`). `precompute.py` lo corre para pendiente y sombreado y anota zoom y límites en `terrain.json`. Las capas por clases (pendiente) se remuestrean con vecino más cercano en el pipeline y en el mapa, para no inventar colores fuera de la leyenda. Sigue abierto para sol y sombra: hoy son COG + `index.json` en `illumination/`, sin teselar.
- **Alcance del planificador 4D**: qué paso temporal y qué rango de soles se precomputa. Parcial (2026-11-14): sol y sombra se precomputan por sol, con fecha y cantidad de soles como parámetros (`--start`, `--sols`) y paso de 1 h LTST. Falta decidir qué soles usa la demo. Ver `docs/illumination.md`.
- **Modelo de rutas**: qué pesa en el costo (pendiente, rugosidad, dosis, luz) y con qué datos se valida.

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
