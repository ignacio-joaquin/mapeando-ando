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
api/        FastAPI: estado, inventario y (en camino) point query + /api/route
web/        Frontend. Hoy: página de estado en HTML plano. Va: React 19 + MapLibre
deploy/     bootstrap, nginx, systemd, auto-deploy
reference/  tablas de referencia versionadas (ej. dosis en superficie)
docs/       documentación del proyecto (este archivo)
```

**El flujo de datos, en una línea:** `sites/*.json` declara qué bajar → `pipeline/` baja a `/data/raw/` y precomputa a `/data/output/` → nginx sirve eso en `/tiles/` → la API lee `/data/manifest.json` y responde consultas puntuales → `web/` dibuja.

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

**`POST /api/route` (propuesta, la consume el planificador de `web/`).** El modelo de costo sigue siendo decisión abierta (§5); esto fija solo qué entra y qué sale. Lo valida `RouteResponseSchema` en `web/src/api/schemas.ts`.

- Entra: `{ site, depart_utc, waypoints: [{ lat, lon, task, dwell_min }] }`. El primero es la salida, el último la llegada, el resto estaciones en orden. Salida y llegada pueden ser puntos distintos.
- Sale: `{ site, depart_utc, legs, stops, verdict }`.
  - `legs[]`: `from`, `to`, `coordinates` (`[lon, lat]`), `class` (`ok` | `caution` | `limit` | `blocked` | `unknown`) y `distance`, `duration`, `bearing`, `max_slope` como valor con procedencia. `unknown` = no se pudo evaluar el terreno; se dibuja punteado, nunca como `ok`.
  - `stops[]`: `index`, `lat`, `lon`, `task`, `arrive_utc`, `depart_utc` (null en la salida y en la llegada final, respectivamente) y `o2_remaining`, `battery_remaining`, `dose_accumulated`, `margin` (min) como valor con procedencia.
  - `verdict`: `status` (`GO` | `NO_GO`), `limiting_factor` (`o2` | `battery` | `dose` | `daylight` | `terrain` | null), `summary` (una frase en español) y `margin` (min).
- Mientras el server responda 404/405/501, el frontend usa un planificador de ejemplo (`web/src/api/routeFixture.ts`) y lo avisa en pantalla.

### Idioma

Código, ids, endpoints y nombres de archivo en **inglés**. Comentarios, docs, commits, PRs y UI en **español**.

---

## 5. Decisiones abiertas

Cosas que hay que resolver en equipo; quien las resuelva, lo escribe acá.

- **Build del frontend y deploy.** nginx sirve `/opt/mapeando-ando/web` directo y `deploy/update.sh` **no corre `npm build`**. Al pasar a React hay que decidir: build en CI y commitear `web/dist` (hoy está en `.gitignore`), o agregar el build al auto-deploy en `deploy/update.sh` y apuntar nginx a `web/dist`. Hoy no está resuelto: si se mergea React a `main` sin esto, el sitio se rompe.
- **Formato de tiles de salida**: COG + PMTiles vs raster pre-teselado.
- **Alcance del planificador 4D**: qué paso temporal y qué rango de soles se precomputa.
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
