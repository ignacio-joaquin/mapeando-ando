# Bitácora del proyecto · Mapa Marciano

Equipo **Mapeando Ando** — NASA Space Apps Challenge 2026 (14 y 15 de noviembre).
Desafío: *Interplanetary Survival Guide: Martian Map*.

Este documento resume las decisiones, la infraestructura, los datos y el estado del trabajo previo a la hackathon. Para usar el repo, ver el [README](README.md).

> Este repo es público. Acá no van IPs, contraseñas, IDs de cuenta ni mails. Esos datos se pasan por el canal privado del equipo.

---

## 1. Qué estamos construyendo

Un mapa de supervivencia para caminatas de astronautas (EVA) en Marte, a escala de caminata. Tiene tres partes:

- **Planificador 4D.** El terreno no cambia, pero el Sol, las sombras, la temperatura y las comunicaciones sí. Por eso la ruta y el veredicto GO / NO-GO dependen de la hora de salida.
- **Capas de supervivencia a 1 m.** Peligro de terreno, refugio, dosis de radiación y sombra, sobre el terreno HiRISE real del sitio. No usamos rasters globales de kilómetros por píxel.
- **Navegación por landmarks.** No hay GPS en Marte. Las indicaciones salen del horizonte real del DEM, por ejemplo: "mantené el borde del cráter a tu izquierda durante 1.2 km".

Regla transversal: cada número muestra un badge de procedencia y misión (por ejemplo `MRO HiRISE · DERIVED` o `MSL RAD · MODELED`). Nunca presentamos un modelo como si fuera una medición.

El briefing completo con el plan de trabajo está en Google Docs (versión 2). El link está en Linear.

## 2. Decisiones tomadas

| Decisión | Detalle |
|---|---|
| **Dos sitios** | Jezero (Perseverance) y Gale (Curiosity). El pipeline no depende del sitio: agregar uno es agregar un `sites/<id>.json`. |
| **El objetivo científico lo elige el usuario** | La app no fija coordenadas de objetivos. El usuario elige el objetivo por ruta y el mapa propone estaciones. |
| **Ruta de ejemplo de la demo** | La arma el equipo dentro de la app (MAP-35), usando el mapa de cobertura de terreno 1 m real (MAP-12). |
| **Video** | Máximo 30 segundos (MAP-59). |
| **Todo pesado se precomputa** | En la nube. En runtime no se llama a APIs externas: se sirven tiles y JSON ya generados. |

## 3. Infraestructura

```
GitHub (main) ──auto-deploy cada 60 s──▶ EC2 (Ubuntu 24.04, us-east-2)
                                          ├─ nginx :80  →  web/         (frontend)
                                          │            →  /api → uvicorn :8000 (FastAPI)
                                          │            →  /tiles/ → /data/output/
                                          ├─ /data/raw     datos crudos
                                          ├─ /data/output  productos procesados
                                          └─ rol IAM → bucket S3 del proyecto (raw/ sincronizado)
```

- **Cuenta AWS:** plan gratuito. La organización administrada por AWS fija la región en **us-east-2** y solo permite tipos de instancia del free tier. Usamos `m7i-flex.large` (2 vCPU, 8 GB); los créditos cubren el uso.
- **Auto-deploy:** un timer de systemd (`mapeando-autodeploy.timer`) hace `git fetch` cada 60 s. Si `main` cambió, resetea, reinicia la API y, si cambió `deploy/`, vuelve a correr `bootstrap.sh`. El log queda en `/var/log/mapeando-deploy.log`. No usa secretos porque el repo es público.
- **Variables del server:** están en `/etc/mapeando.env` (`DATA_DIR`, `BUCKET`, región y, opcionalmente, `NASA_API_KEY`). Este archivo no está en el repo.
- **API:** `/api/health` devuelve el commit desplegado y si hay datos. `/api/sites` y `/api/sites/{id}` leen `/data/manifest.json`.
- **CI:** `.github/workflows/ci.yml` chequea la sintaxis de Python, JSON y bash.

### Acceso

- **SSH:** cada integrante tiene su usuario con sudo (`nasho`, `dana`, `pilx`, `guido`, `maro`, `lucas`). La contraseña y la IP se pasan por privado.
- **fail2ban:** 8 intentos fallidos en 10 min bloquean la IP 30 min. La IP desde donde trabaja el equipo está exceptuada. Si alguien recibe `Connection refused` desde otra red, es ese bloqueo.
- **Altas y bajas:** `sudo mapeando-add-member <usuario> "<clave pública>"` y `sudo mapeando-remove-member <usuario>`.
- **Session Manager:** sigue disponible desde la consola de AWS como entrada de respaldo.

## 4. Datos

Todo lo crudo está en `/data/raw/` en el server y en `raw/` del bucket S3, con la misma estructura. `/data/manifest.json` lista los rasters, el SPICE y los waypoints con su origen. Los datos científicos bajados después (THEMIS, CRISM, química, clima) todavía no figuran ahí: hay que mirar las carpetas.

### Sitios

| | Jezero | Gale |
|---|---|---|
| Rover | Perseverance (Mars 2020) | Curiosity (MSL) |
| Terreno 1 m | DTM HiRISE del TRN de Mars 2020, ~21 × 21 km. Cubre el piso del cráter, el frente del delta y Three Forks. | Mosaico DEM 1 m, ~33 × 57 km, incluido el boxwork. |
| Cobertura real 1 m | 303 km² reales, sin relleno. | 862 km² reales, 688 km² de relleno (rugosidad 0) y 303 km² sin datos. |
| Ortoimagen | HiRISE 25 cm (7.4 GB) | HiRISE color LRGB |

El mapa de cobertura (`/data/output/<sitio>/coverage.geojson`, que escribe `precompute.py`; capa `coverage` de `terrain.json`) muestra dónde hay terreno 1 m real, y el planificador lo dibuja como contorno. Las rutas de la demo tienen que ir por ahí.

### Los ocho tipos de datos del brief

| Tipo | Dataset | Jezero | Gale | Dónde |
|---|---|---|---|---|
| Óptico | Ortoimagen HiRISE | ✅ | ✅ | `raw/<sitio>/*ortho*` |
| Topográfico | DTM HiRISE 1 m + recorte MOLA-HRSC 200 m (horizonte) | ✅ | ✅ | `raw/<sitio>/` |
| Radiación | MSL RAD: 0.21 mGy/día, 0.64 mSv/día (Hassler 2014) | ✅ | ✅ | `reference/rad_surface_dose.json` |
| Atmosférico | MEDA (Jezero) / REMS (Gale) | ✅ 17 GB | ✅ 7.4 GB | `raw/jezero/meda/`, `raw/gale/rems/` |
| Térmico | THEMIS IR día/noche, 100 m, recortado (DN 8 bits, cualitativo, no calibrado). El nocturno lo procesa `pipeline/thermal.py`: capa `survival-thermal` (OBSERVED) y suelo suelto probable (MODELED) | ✅ | ✅ | `raw/<sitio>/themis/` |
| Espectral | CRISM MTRDR browse (resúmenes minerales) | ✅ 8 obs. | ✅ 29 obs. | `raw/<sitio>/crism/` + `index.json` |
| Químico | SuperCam MOC + PIXL óxidos / ChemCam MOC + APXS | ✅ | ✅ (APXS: solo inventario) | `raw/jezero/{supercam,pixl}/`, `raw/gale/{chemcam,apxs}/` |
| Geofísico | RIMFAX (Jezero) / campo magnético Langlais 2019 (Gale) | ✅ 1393 archivos, 1.1 GB | ✅ (coeficientes) | `raw/jezero/rimfax/`, `raw/common/magnetic_langlais2019/` |

### Datos de apoyo

| Dataset | Para qué | Estado |
|---|---|---|
| NAIF SPICE: `naif0012.tls`, `pck00011.tpc`, `de440s.bsp`, `mar099s.bsp` | Sol, Tierra, Fobos y Deimos; amanecer y atardecer | ✅ `raw/common/` |
| IAU Gazetteer | Nombres de lugares y landmarks | ✅ `raw/common/` |
| Cráteres de Robbins & Hynek 2012 (≥1 km, sitio ±1°) | Landmarks: 45 en Jezero, 55 en Gale | ✅ `raw/<sitio>/landmarks/` |
| Waypoints MMGIS | Tracks del rover (e Ingenuity en Jezero) | ✅ |
| Mars 2020 rover places | Posición del rover por sol, para cruzar con la química | ✅ `raw/jezero/rover_places/` |
| NASA DONKI WSA-Enlil | Clima espacial, impactos en Marte | ✅ 1230 simulaciones de nov 2025 a hoy; 191 llegan a Marte. `raw/common/donki/` |
| SWIM 2.0 | Capa de agua `survival-water` (`pipeline/swim.py`): solo el composite de 0–1 m. Jezero −0,37 a −0,19, Gale −0,01 a +0,17; 1–5 m y > 5 m descartados (`docs/context.md` §5). | ✅ `raw/common/swim2/` |
| Fotos del rover por estación | Foto real en cada estación | Se buscan por posición cuando el usuario arma la ruta (MAP-14). No se descargan de antemano. |
| Mars Trek WMTS | Mapa base | Se consume en vivo; es geográfico (EPSG:104905), no Web Mercator. |

## 5. Pipeline

| Script | Qué hace |
|---|---|
| `pipeline/download.py` | Descarga lo definido en `sites/*.json` y `sites/common.json`. Reanuda descargas, descubre archivos por patrón, recorta el DEM 200 m remotamente (`/vsicurl/`), verifica con `gdalinfo` y escribe el manifest. `--sync` sube a S3. |
| `pipeline/fetch_science.sh` | THEMIS (recorte remoto) y CRISM (API REST de ODE) de ambos sitios, SuperCam e inventario de APXS. |
| `pipeline/fetch_pds.py` | Descarga dirigida desde PDS Geosciences: PIXL, ChemCam, RIMFAX y rover places. Respeta el `Crawl-delay` de 10 s del servidor, así que es lenta. |
| `pipeline/fetch_extras.py` | Cráteres de Robbins, DONKI, Langlais 2019 y SWIM. |

En el server se corren como unidades de systemd en segundo plano, y la generación de tiles del mapa se dispara con `mapeando-download.service`, que hace en una sola pasada: descarga, precompute, illumination y teselado de sombras por sol. Por ejemplo:

```
sudo systemctl start mapeando-download
journalctl -u mapeando-download -f
```

También se puede lanzar a mano con `systemd-run`:

```
sudo systemd-run --unit=mapeando-x --property=EnvironmentFile=/etc/mapeando.env \
     /usr/bin/python3 /opt/mapeando-ando/pipeline/fetch_extras.py --sync
journalctl -u mapeando-x -f
```

### Lecciones y trampas conocidas

- **NumPy:** el `python3-gdal` de Ubuntu está compilado contra NumPy 1.x, así que `numpy==1.26.4` está fijado. Con NumPy 2 aparece `_ARRAY_API not found`.
- **Grados vs. metros:** el DEM global de 200 m está en grados. `download.py` detecta si el raster está en grados o en metros. Para Marte, radio 3396190 m.
- **Proyecciones:** GDAL/PROJ no transforman EPSG:4326 (Tierra) a CRS de Marte. Usar `+proj=longlat +R=3396190` o coordenadas en metros de la proyección del archivo.
- **Ortoimagen de Jezero:** el índice de USGS redirige a S3 sin permiso de listado. Se usa la URL directa.
- **Kernels SPICE:** el de lunas de Marte cambia de nombre (`mar097` → `mar099s`). Se descubre por patrón.
- **robots.txt:** PDS Geosciences pide 10 s entre pedidos y no admite crawlers en `/m2020/` ni `/msl/`. Por eso hacemos descarga dirigida y lenta, no `wget -r`.
- **DONKI:** el endpoint del CCMC no es alcanzable desde AWS, y DEMO_KEY se agota rápido. El server usa la `NASA_API_KEY` de `/etc/mapeando.env`.
- **Gale:** parte del DEM es relleno sin detalle (rugosidad 0). No planificar rutas ahí.

## 6. Estado en Linear (M0 · Preparación)

| Issue | Estado |
|---|---|
| MAP-5 Reglas de Space Apps | Done |
| MAP-6 Roles y equipo en Linear | Done |
| MAP-7 Elegir sitio | Canceled: vamos con los dos |
| MAP-8 Revisar Resources del challenge | Canceled |
| MAP-9 Tiles de Mars Trek en MapLibre | Done |
| MAP-10 Kernels SPICE | Done |
| MAP-11 DTM HiRISE + recorte 200 m | Done |
| MAP-12 Mapa de cobertura 1 m real | Done |
| MAP-13 MEDA / REMS | Done (falta extraer la curva diurna, M1) |
| MAP-14 Fuente de fotos del rover | Done |
| MAP-15 THEMIS y CRISM | Done |
| MAP-16 Química y RIMFAX | Done |
| MAP-17 DONKI | Done, con datos guardados |
| MAP-18 Scaffold del repo | Done |

## 7. Pendientes

Todo M0 está cerrado en Linear. Quedan estos pendientes de datos e infraestructura:

1. **APXS:** bajar las tablas de óxidos por sol. Hoy solo está el inventario.
2. **Manifest:** sumar a `manifest.json` los datos científicos (THEMIS, CRISM, química, clima) para que la API los liste.
3. **Seguridad del server:** SSH está abierto a internet con una contraseña compartida y sudo. Opciones: pasar a claves (`ssh-copy-id`) y apagar el login por contraseña, o limitar el puerto 22 a la IP del equipo.
4. **LICENSE:** el repo todavía no tiene licencia.

---

*Prototipo educativo, no software de vuelo.*
