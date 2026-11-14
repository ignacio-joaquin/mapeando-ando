# Mapeando Ando · Mapa Marciano

Mapa de supervivencia para una EVA en la superficie de Marte (NASA Space Apps 2026, challenge *Interplanetary Survival Guide: Martian Map*): planificador 4D, capas de supervivencia a 1 m y navegación por landmarks.

Plan y tareas: proyecto **Mapa Marciano — Space Apps 2026** en Linear (equipo Mapeando Ando).

## Estructura

| Carpeta | Qué hay |
|---|---|
| `sites/` | Un JSON por sitio (Jezero, Gale) + `common.json`. Sumar un sitio = sumar un archivo. |
| `pipeline/` | Python que descarga y precomputa (rasterio, numpy, spiceypy, GDAL). |
| `api/` | FastAPI: estado, inventario de datos y, después, point queries y `/api/route`. |
| `web/` | Frontend. Hoy es una página de estado; acá va el mapa (React + MapLibre). |
| `deploy/` | Bootstrap del servidor, nginx, systemd y auto-deploy. |

## Servidor

- AWS EC2 en **us-east-2 (Ohio)**, Ubuntu 24.04. La IP pública está en Linear.
- `http://<IP>/` sirve `web/`, `/api/*` va a FastAPI y `/tiles/*` sirve `/data/output/`.
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

## Acceso al servidor

**SSH (equipo).** Cada integrante tiene su propio usuario, con sudo. El admin pasa usuario y contraseña inicial por privado; en el primer login se pide cambiarla. Hay fail2ban: 3 intentos fallidos bloquean la IP 24 h.

- Entrar: `ssh <usuario>@<IP del server>`. La IP la pasa el admin; no se publica acá.
- Recomendado: subir tu clave pública con `ssh-copy-id <usuario>@<IP>`, para no depender de la contraseña.
- Alta de alguien nuevo por clave: `sudo mapeando-add-member <usuario> "<clave pública>"`

Para dar de baja a alguien: `sudo mapeando-remove-member <usuario>`.

Dentro del server, los datos están en `/data` y el repo en `/opt/mapeando-ando`. El bucket S3 se usa con `aws s3 ...` sin credenciales propias: el server tiene un rol IAM.

**Session Manager (admin).** También se puede entrar sin SSH desde la consola de AWS: EC2 → la instancia → Connect → Session Manager.

---
Prototipo educativo, no software de vuelo.
## Capas de terreno para EVA (`pipeline/terrain_layers.py`)

Responde "¿piso caminable o terreno con bloques?" con capas separadas, para combinarlas después con otras fuentes. Lee `dtm.tif` y `slope.tif` de `precompute.py` y escribe en la misma carpeta (`/data/output/<sitio>/`). Badge: **MRO HiRISE · DERIVED**.

```
python pipeline/terrain_layers.py --site jezero
```

| Archivo | Unidad | Qué es |
|---|---|---|
| `roughness.tif` | m | Rugosidad pura: desvío estándar en 5 m de los residuos del DTM tras restar el promedio en 15 m |
| `terrain_factor.tif` | η (adimensional) | Factor de terreno de Pandolf, **solo por rugosidad** |
| `impassable.tif` | 0/1 | 1 = no transitable a pie |
| `terrain_layers.json` | — | Unidades, umbrales, leyenda, resumen por sitio |

**Solo geometría:** no incluye gravedad, traje ni carga (se aplican en otra etapa).

### Por qué rugosidad "pura"
La diferencia entre vecinos (`gdaldem roughness`) crece en cualquier ladera, aunque sea lisa, y repite la pendiente. Restando primero la tendencia local (promedio en 15 m), en una ladera lisa el residuo es ~0 y solo quedan bloques y escalones. Es el mismo criterio de "detrended terrain ruggedness" usado para analizar las travesías de Apollo 15 y 16 (Jacob et al., LPSC, NASA NTRS 20250011301). La ventana de 5 m coincide con la resolución horizontal real de un DTM HiRISE, que no es mejor que 3–5 píxeles (Kirk, MSL Landing Site Workshop).

### Pendiente y Pandolf
En Pandolf la pendiente entra como el grado **G**, separada de η. Por eso `terrain_factor` no incluye la pendiente: si la incluyera, se contaría dos veces. G depende de la dirección de marcha y tiene signo (subida o bajada), así que lo calcula el planificador sobre la ruta con `dtm.tif`: `G = 100 · Δz / Δd`.

### Umbrales y justificación

**η de Pandolf según rugosidad** (interpolación lineal; fuera de rango se satura):

| Rugosidad pura | η | Equivalente en Pandolf |
|---|---|---|
| ≤ 0,1 m | 1,1 | Camino de tierra: el regolito nunca es asfalto (1,0). Por debajo de 0,1 m es ruido del DTM |
| 0,3 m | 1,2 | Matorral liviano: irregularidad apenas por encima del ruido |
| 0,5 m | 1,5 | Matorral denso: obliga a esquivar obstáculos |
| ≥ 1,0 m | 1,8 | Pantano: bloques o escalones de ~1 m |

Valores de η de referencia: Soule & Goldman (1972), usados en Pandolf et al. (1977). Precisión vertical de los DTM HiRISE de 1 m: decenas de cm (Sutton et al., 2022, *Remote Sensing* 14:2403), por eso la rugosidad por debajo de ~0,3 m se toma como poco confiable.

**No transitable a pie:** pendiente > 30° **o** rugosidad > 1,0 m. Los astronautas de Apollo caminaron en pendientes de menos de 15° (Iqbal et al., 2024, *Acta Astronautica*), y la planificación de caminatas en el polo sur lunar limita las travesías a menos de 20°. Se toma 30° como límite físico (más allá, no es caminable aunque cueste más), y 1 m como escalón que obliga a trepar. Pandolf no modela lo imposible: por eso es una máscara aparte.

### Limitaciones
- El DTM no distingue el material: roca firme y arena suelta (η 2,1 en Pandolf) se ven iguales. η mide solo la irregularidad geométrica.
- Un DTM de 1 m no ve piedras individuales de menos de ~3–5 m: la rugosidad indica zonas con bloques, no detecta rocas.
- Las anclas son una propuesta del equipo a partir de las referencias; se cambian en las constantes al principio del script.

## Dosis de radiación (`pipeline/radiation.py`)

Badge: **MSL RAD · MODELED**. Lee `dtm.tif` (de `precompute.py`) y `dem200_crop.tif` (de `download.py`) y escribe en `/data/output/<sitio>/`:

```
python pipeline/radiation.py --site jezero
```

| Archivo | Unidad | Qué es |
|---|---|---|
| `dose_rate.tif` | mGy/día | Dosis absorbida por celda (grilla de 100 m), para el planificador |
| `skyview.tif` | 0–1 | Fracción del cielo que no tapa el terreno |
| `radiation.json` | — | Rango real de valores, modo de visualización, tasa por hora, limitaciones |

### Modelo
`dosis = D0 × sky_view`, con D0 = 0,21 ± 0,04 mGy/día, la dosis absorbida en superficie medida por MSL RAD en Gale (Hassler et al., 2014, *Science* 343:1244797; ver `reference/rad_surface_dose.json`).
`sky_view = 1 − promedio(sin γ)` sobre 32 azimuts, donde γ es el ángulo del horizonte (mínimo 0°). Supone radiación isótropa desde el cielo. El horizonte se busca hasta 60 km, con el DTM cerca y el DEM global de 200 m lejos, e incluye la curvatura de Marte (radio 3389,5 km).

### Decisión de visualización
Si la variación espacial (p1–p99) es menor que la incertidumbre de la medición (±19 %), se muestra como **presupuesto de dosis de la travesía** en el panel de la ruta, y el raster queda como capa secundaria. Si se muestra el raster, la escala de colores va fija de 0 a D0, sin estirarla al rango mín–máx.

Presupuesto: `dosis_travesía (mGy) = Σ dose_rate(celda) × horas_en_celda / 24`.

### Resultados

| Sitio | Sky-view mediano | Dosis p1–p99 (mGy/día) | Variación | Regla automática | Tasa mediana |
|---|---|---|---|---|---|
| Jezero | 0,95 | 0,172–0,205 | 16,3 % | presupuesto | 8,3 µGy/h (EVA 4 h ≈ 33 µGy) |
| Gale | 0,92 | 0,163–0,200 | 19,2 % | capa (por 0,2 puntos) | 8,0 µGy/h (EVA 4 h ≈ 32 µGy) |

**Decisión: presupuesto de dosis en ambos sitios**, con el raster como capa secundaria. En Gale la regla da "capa" por 0,2 puntos (empate técnico con la incertidumbre de RAD), y el modelo isótropo sobreestima el apantallamiento, así que la variación real es menor. La única variación apreciable está al pie de Mount Sharp, donde la dosis baja hasta un ~15 %: se aclara en la leyenda de la capa secundaria. (El `radiation.json` de Gale muestra el resultado de la regla automática; la decisión final es la de este README.)

### Limitaciones
- D0 se midió en el piso de Gale, que tiene algo de horizonte propio: se usa como valor de cielo abierto. El error es de pocos %, menor que la incertidumbre.
- Cerca del horizonte, la radiación atraviesa más atmósfera y llega menos: el modelo isótropo **sobreestima** el apantallamiento del terreno (es una cota superior).
- No incluye eventos de partículas solares, ciclo solar ni variación estacional de presión: cambian D0 en el tiempo, no en el espacio.
- No incluye secundarios del suelo (neutrones de albedo).