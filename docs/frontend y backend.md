# Frontend y backend · cómo se conectan y qué falta

> Qué está hecho en el mapa, cómo enchufarlo al server y qué hay que correr para que cada capa se encienda.
> Si algo de acá cambia, se edita este archivo en el mismo PR.

---

## 1. Cómo se conectan

El frontend **nunca** pide una URL absoluta. Siempre `/api/...` y `/tiles/...`, relativas. Eso es lo que hace que el mismo build funcione en tu máquina y en el server sin configurar nada.

| Dónde | Quién resuelve `/api` y `/tiles` |
|---|---|
| Tu máquina (`npm run dev`) | El proxy de Vite, con `VITE_API_TARGET` de `web/.env.local` |
| El server | nginx: `/api/` va a FastAPI y `/tiles/` sirve `/data/output/` |

### Conectar tu frontend al server real

```bash
cp web/.env.example web/.env.local
# editar: VITE_API_TARGET=http://<ip-del-server>     (la IP está en Linear, no en el repo)
cd web && npm install && npm run dev                 # http://localhost:5173
```

`web/.env.local` está en el `.gitignore`: **la IP del server no se commitea**, el repo es público.

Sin `.env.local`, el frontend arranca en **modo ejemplo**: fixtures locales y un cartel rojo avisando que ningún valor es una medición. Sirve para trabajar en la UI, no para decidir nada.

### Cómo sabés que quedó conectado

- Se cae el cartel rojo de "Datos de ejemplo".
- El encabezado muestra el commit que corre en el server y si los datos están listos.
- `GET /api/health` responde desde el server, no desde los fixtures.

---

## 2. Los tres canales entre las dos puntas

**`/api/*` — consultas puntuales.** FastAPI lee `/data/manifest.json` y los COG.

| Endpoint | Qué devuelve | Estado |
|---|---|---|
| `GET /api/health` | commit desplegado y si hay datos | anda |
| `GET /api/sites`, `GET /api/sites/{id}` | inventario del sitio | anda |
| `GET /api/sites/{id}/point?lat=&lon=` | elevación y pendiente en un punto | anda, necesita el DTM bajado |
| `POST /api/route/consumables` | consumibles por tramo + perfil de elevación | anda, necesita el DTM bajado |
| `POST /api/route` | planificador 4D: ruta por el terreno, horarios, consumibles, veredicto GO / CAUTION / NO-GO con puntaje, límites, robustez y costo por factor (`docs/seguridad.md`) | anda, necesita `slope.tif` (si no, tramos en línea recta como `unknown`); la sombra, la pila de `illumination.py` |
| `POST /api/illumination/window` | sol/sombra precomputados entre dos puntos | anda, necesita la pila de `illumination.py` (si no, 503) |

**`/tiles/*` — lo que se dibuja.** nginx sirve `/data/output/` tal cual. Ahí viven los tiles PNG, las curvas en GeoJSON y el índice `terrain.json`.

**`terrain.json` — el contrato de las capas.** `pipeline/precompute.py` escribe `/data/output/<sitio>/terrain.json` con una entrada por capa, usando como clave el **id de `web/src/map/layers.ts`**. El frontend lo lee y prende solo las capas que dicen `status: ok` y tienen sus tiles listos. Una capa que el índice no menciona queda en "esperando pipeline".

> Si agregás una capa, el id tiene que ser el mismo en `layers.ts` y en el `terrain.json` que escribe el pipeline. Es breaking change: se toca en un PR que cambia las dos puntas.

---

## 3. Qué está hecho

| Pieza | Estado |
|---|---|
| Mapa, conmutador de sitio, recuadro del sitio | listo |
| Stack de capas: toggle, opacidad, leyenda, unidad, badge de procedencia | listo |
| Reloj marciano (LTST, LMST, sol, Ls) | listo; falta validarlo contra efemérides |
| Barra de escala y distancias con radio marciano (3396190 m) | listo |
| Inspector: lat/lon, punto fijado, elevación y pendiente | listo; falta la elevación al pasar el cursor |
| Perfil de elevación debajo del mapa, coloreado por pendiente | listo; necesita que la ruta traiga `profile` |
| Pipeline: DTM a COG, pendiente, sombreado, curvas | listo |
| Pipeline: teselado a XYZ PNG y ortoimagen | listo; falta correrlo |
| Planificador de travesía, fichas, tira imprimible | listo, contra el planificador de ejemplo |
| Capas de peligro, refugio, dosis y sombras | no empezadas |

---

## 4. Qué hay que correr para que se encienda cada cosa

Todo esto va en el server, con el venv del pipeline. Nada se puede hacer desde una máquina sin los datos.

**1. Bajar los datos** (son horas; se reanuda si se corta):

```bash
sudo systemctl start mapeando-download
journalctl -u mapeando-download -f
```

**2. Precomputar el relieve.** Primero el recorte de prueba, que tarda poco:

```bash
.venv-pipeline/bin/python pipeline/precompute.py --site jezero --prueba
```

Si eso anda, el sitio completo:

```bash
.venv-pipeline/bin/python pipeline/precompute.py --site jezero
```

Enciende **hillshade, pendiente y curvas de nivel**. Deja `terrain.json` y, con él, el frontend se entera solo: no hay que tocar una línea de código ni redeployar.

**3. La ortoimagen**, aparte porque es la más cara (7,4 GB a 25 cm/px en Jezero, horas de proceso):

```bash
.venv-pipeline/bin/python pipeline/precompute.py --site jezero --ortho
```

La tesela hasta z17 (~0,64 m/px) y la recorta sola al bbox del sitio. Con `--ortho-max-zoom 18` llega a ~0,32 m/px, cerca de los 25 cm nativos, pero son ~4 veces más tiles. No le pases `--max-zoom`: ese tope es del relieve, y `--ortho` vuelve a generar también la pendiente y el sombreado.

**4. Validar el reloj** (cierra su ticket):

```bash
.venv-pipeline/bin/python pipeline/check_mars24.py --site jezero   # genera la referencia con SPICE
cd web && npm run check:mars24                                      # compara el mars24.ts real
```

La referencia se commitea, así el chequeo después corre en cualquier máquina sin kernels.

**5. Verificar desde afuera:**

```bash
curl -s http://<server>/api/health | jq
curl -s http://<server>/tiles/jezero/terrain.json | jq '.layers | map_values(.status)'
curl -I http://<server>/tiles/jezero/hillshade/14/<x>/<y>.png
curl -s "http://<server>/api/sites/jezero/point?lat=18.488&lon=77.403" | jq
```

---

## 5. Lo que todavía bloquea

- **El frontend no se despliega.** nginx sirve `/opt/mapeando-ando/web` directo, `deploy/update.sh` no corre `npm build` y el server no tiene Node. Mientras no se resuelva, el mapa solo se ve en local aunque esté mergeado en `main`. Es la decisión abierta de `context.md` y **no depende de los datos**.
- **Las capas de supervivencia** (peligro, refugio, dosis) no las genera nadie todavía. Sol y sombra sí: `pipeline/illumination.py` calcula la pila por hora y `pipeline/shadow_tiles.py` la tesela para el deslizador del sol (ver `docs/illumination.md`).
- **El valor por capa en el inspector** viene vacío hasta que esas capas existan.
