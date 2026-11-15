---
name: mapeando-geodata
description: >
  Pipeline de datos marcianos: descargas educadas de PDS/USGS, rasterio/GDAL, SPICE y salidas precomputadas.
  Trigger: Al tocar pipeline/, al bajar datos de NASA/USGS/PDS, al trabajar con DEM, raster, reproyección, SPICE o efemérides.
metadata:
  author: mapeando-ando
  version: "1.0"
---

## Cuándo se usa

- Cualquier cambio en `pipeline/download.py`, `fetch_pds.py`, `fetch_extras.py`, `fetch_science.sh`.
- Sumar una fuente de datos nueva, o precomputar una capa de supervivencia.
- Tocar reproyección, recortes, pendientes, sombras, rutas o efemérides.

---

## Reglas duras

### 1. Ser educado con los servidores de la NASA (NO NEGOCIABLE)

Son servidores públicos y compartidos. Un pipeline agresivo nos bloquea la IP y mata el proyecto.

```python
# ✅ el patrón del repo (fetch_pds.py)
UA = "mapeando-ando/1.0 (NASA Space Apps 2026; descarga dirigida de datos PDS)"
DELAY = 10          # Crawl-delay del robots.txt de PDS Geosciences
time.sleep(DELAY)   # ANTES de cada pedido, sin excepciones
```

- Respetar el `Crawl-delay` del `robots.txt` del host. PDS Geosciences: 10 s.
- Un pedido a la vez por host. **Nunca** paralelizar descargas contra el mismo dominio.
- `User-Agent` identificable siempre.
- Backoff ante 429/503 (`fetch_extras.py` espera 600 s). Nunca reintentar en loop apretado.
- Nunca crawlear un árbol entero "por si acaso": descarga dirigida, solo lo que una capa necesita.

### 2. Todo se reanuda

Las descargas son de GB y la corrida tarda horas; se corta y se retoma.

```python
curl --fail -L -C - --retry 8 --retry-delay 10 --retry-connrefused -sS -o dest url
# rc 33 = el server ignoró el range sobre un archivo ya completo -> tratar como éxito
```

Reanudable significa: si el archivo ya está íntegro, no se vuelve a bajar.

### 3. No bajar lo que se puede leer remoto

El DEM global de 200 m son ~11 GB. Se recorta por sitio con lectura remota.

```
GDAL /vsicurl/ + gdal_translate -projwin  →  solo los bytes del bbox
```

### 4. Un fallo no mata la corrida

```python
except Exception as e:  # seguir; el manifest registra lo que falló
    entry.update(status="optional_missing" if f.get("optional") else "error", error=str(e)[:400])
```

El `manifest.json` es el reporte: `generated_at`, por archivo `status`/`path`/`bytes`/`error`. Verificar que cada raster **abra** (`gdalinfo`) antes de marcarlo `ok`; un `.tif` truncado pesa bien y no sirve.

### 5. NumPy 1.x, a propósito

`numpy==1.26.4` porque el `python3-gdal` de Ubuntu 24.04 está compilado contra NumPy 1.x. **No subir a NumPy 2**: rompe GDAL en el server. Todas las versiones de `pipeline/requirements.txt` quedan pineadas.

### 6. Unidades, proyección y procedencia

- Radio marciano: `3396190` m (está en `sites/common.json`, no hardcodear otro).
- Coordenadas planetocéntricas, este positivo. Metros para distancias y alturas.
- No mezclar resoluciones sin decirlo: DEM global 200 m, HiRISE DTM 1 m, ortho 25 cm.
- Toda salida declara de qué fuente y misión viene. El challenge se evalúa por uso correcto de datos reales de la NASA: **nunca inventar ni interpolar un valor y presentarlo como dato medido**.

### 7. SPICE

`spiceypy` con los kernels de `sites/common.json` (`lsk`, `pck`, `de440s`, satélites de Marte). Cargar con `furnsh` y liberar con `kclear`; no dejar kernels colgados entre corridas. Tiempos en ET/UTC explícito, nunca local.

### 8. Salidas

Crudo en `/data/raw/<sitio>/`, derivado en `/data/output/<sitio>/`. Nunca escribir dentro del repo (el auto-deploy hace `git reset --hard` y se pierde). Formatos web-friendly: COG para raster, GeoJSON o PMTiles para vectores.

---

## Anti-patrones

- ❌ Paralelizar descargas contra el mismo host, o quitar el `sleep`.
- ❌ Bajar el DEM global entero.
- ❌ Cargar un raster de GB completo en RAM: leer por ventanas (`rasterio.windows`).
- ❌ Dejar valores de `nodata` entrar en estadísticas (pendientes, dosis, sombras).
- ❌ Subir claves o tokens: el repo es público. API keys de NASA van por entorno (`/etc/mapeando.env`).
