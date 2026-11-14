---
name: mapeando-api
description: >
  Convenciones de la API FastAPI de Mapa Marciano (api/main.py): endpoints, contratos, manifest y errores.
  Trigger: Al tocar cualquier cosa en api/, al agregar o cambiar un endpoint, o al definir el contrato que consume web/.
metadata:
  author: mapeando-ando
  version: "1.0"
---

## Cuándo se usa

- Agregar o modificar endpoints en `api/main.py` (point query, `/api/route`, capas).
- Cambiar la forma de una respuesta que el frontend ya consume.
- Decidir qué va en la API y qué va precomputado en el pipeline.

---

## Reglas duras

### 1. La API no calcula pesado en caliente

El pipeline precomputa y escribe en `/data/output/<sitio>/`; nginx lo sirve en `/tiles/`.
La API solo lee, indexa y resuelve consultas puntuales rápidas.

```python
# ✅ leer un valor ya precomputado
@app.get("/api/sites/{site_id}/point")
def point(site_id: str, lat: float, lon: float): ...

# ❌ NUNCA: abrir un DEM de 7 GB y reproyectar dentro del request
```

Si una respuesta tarda más de ~1 s, va al pipeline como salida precomputada.

### 2. `manifest.json` es la única fuente de verdad del inventario

Nunca listar `/data` con `glob` ni asumir que un archivo existe. Siempre vía `_manifest()`.

```python
m = _manifest()
if m is None or site_id not in m["sites"]:
    raise HTTPException(404, "Sitio desconocido o datos todavía no descargados")
```

### 3. Degradar, no romper

Los datos tardan horas en bajar. Todo endpoint debe responder algo útil con datos a medias.

```python
# ✅ el patrón del proyecto
if m is None:
    return {"sites": [], "note": "La descarga de datos todavía no terminó."}

# ❌ NUNCA: 500 porque el manifest no existe
```

Status de archivo en el manifest: `ok` | `error` | `optional_missing`. Un `optional_missing` no es un fallo.

### 4. Nada de estado en el proceso

El servicio se reinicia en cada deploy (ver `mapeando-deploy`). Sin caché en memoria que importe, sin sesiones, sin escrituras en el repo. Escribir solo bajo `DATA_DIR`.

### 5. Rutas y nombres

- Todo bajo el prefijo `/api/`, en inglés, kebab o snake plano: `/api/health`, `/api/sites/{site_id}`, `/api/route`.
- `DATA_DIR` siempre por entorno: `Path(os.environ.get("DATA_DIR", "/data"))`. Nunca `/data` hardcodeado.
- Coordenadas: `lat`/`lon` en grados decimales, planetocéntricas, este positivo (igual que `sites/*.json`). Alturas y distancias en metros.

### 6. Errores

`HTTPException` con mensaje en español, corto y accionable para el equipo. Sin stacktrace al cliente.

---

## Dependencias

`api/requirements.txt` está pineado y lo instala el auto-deploy al cambiar. Sumar una dependencia es una decisión de equipo: la API corre en una EC2 chica junto al pipeline. Preferir stdlib.

Para leer rasters desde la API, usar `rasterio` ya pineado en el pipeline **solo** si hace falta y midiendo; la ruta por defecto es precomputar.

---

## Tests

`pytest` + `TestClient` de FastAPI, con `DATA_DIR` apuntando a un manifest de fixture (ver skill `pytest`). Caso obligatorio en todo endpoint nuevo: **sin manifest** y **con manifest incompleto**.

---

## Anti-patrones

- ❌ Romper un contrato que `web/` ya consume sin actualizar el frontend en el mismo PR.
- ❌ Agregar auth o secretos: el repo es público y el server solo lee.
- ❌ `print` para diagnosticar; el servicio loguea por systemd/journald.
