---
name: mapeando-sites
description: >
  Contrato de los JSON de sitio (sites/*.json y common.json): sumar o editar un sitio de Marte.
  Trigger: Al crear o modificar cualquier archivo en sites/, o al sumar un sitio o una fuente de datos nueva.
metadata:
  author: mapeando-ando
  version: "1.1"
---

## Principio

**Sumar un sitio = sumar un archivo.** Nada de código nuevo. Si para agregar un sitio hay que tocar Python, el diseño está mal: la lógica va en `pipeline/`, la configuración en `sites/`.

---

## Contrato de `sites/<id>.json`

```json
{
  "id": "jezero",
  "name": "Jezero",
  "rover": "Perseverance (Mars 2020)",
  "center": {"lat": 18.488, "lon": 77.403},
  "bbox": {"lat_min": 18.3068, "lat_max": 18.6693, "lon_min": 77.2229, "lon_max": 77.5840},
  "notes": "Qué cubre el área y por qué se eligió.",
  "horizon_pad_deg": 1.0,
  "files": [
    {"key": "dtm", "kind": "raster", "desc": "HiRISE DTM mosaic 1 m (MRO HiRISE, USGS)",
     "mission": "MRO HiRISE", "url": "https://...", "approx_gb": 1.8}
  ]
}
```

| Campo | Regla |
|---|---|
| `id` | minúsculas, sin espacios, igual al nombre del archivo |
| `center` / `bbox` | grados decimales, planetocéntricos, este positivo |
| `horizon_pad_deg` | margen extra para el horizonte (sombras y visibilidad) |
| `files[].key` | estable: lo usan la API y el frontend. Renombrar un `key` es breaking change |
| `files[].kind` | `raster` \| `json` \| `spice` \| `zip` \| `csv` |
| `files[].desc` | **incluye resolución y fuente**: "HiRISE DTM mosaic 1 m (MRO HiRISE, USGS)" |
| `files[].mission` | misión de origen; obligatorio para citar procedencia |
| `files[].approx_gb` | tamaño estimado, para no sorprender al disco de la EC2 |
| `files[].optional` | `true` si su ausencia no debe marcar error |
| `files[].instrument` | instrumento que midió el dato (`ChemCam`, `SuperCam`, `PIXL`, `APXS`). Lo usa `places.py` para el `instrument` y el `detail` de cada objetivo científico. Obligatorio en las fuentes de objetivos |
| `files[].name` | nombre para mostrar de la fuente cuando el `desc` no sirve como nombre (ej. `"Depósito Three Forks"` en `sample_depot_locations`): es el nombre del lugar en el buscador |

### Keys con significado en `pipeline/places.py`

Son contrato: `places.py` activa cada fuente del buscador de destinos solo si el sitio declara ese `key`. Sumar un sitio con helicóptero o depósito no necesita código.

| `key` | `kind` | Qué aporta a `places.json` |
|---|---|---|
| `rover_waypoints` | `json` | posiciones del rover (MMGIS) y, por site/drive, la posición de los objetivos de ChemCam, SuperCam y PIXL |
| `heli_waypoints` | `json` | aeródromos del helicóptero (MMGIS) |
| `sample_depot_locations` | `csv` | un lugar por tubo; `name` le da nombre al depósito |
| `chemcam_obs` | `csv` | objetivos de ChemCam (`msl_ccam_obs.csv`), `instrument: "ChemCam"` |
| `supercam_obs` | `csv` | objetivos de SuperCam (`m2020_scam_masterlist.csv`), `instrument: "SuperCam"` |
| `pixl_inventory` | `csv` | inventario de PIXL; la lista la arma `fetch_targets.py` desde las etiquetas, `instrument: "PIXL"` |
| `apxs_targets*` | `csv` | tablas de APXS con la posición medida del objetivo (prefijo: puede haber varias), `instrument: "APXS"` |

Un objetivo medido por varios instrumentos es un solo lugar: se agrupa por id normalizado (`John_Klein` y `John Klein` son el mismo).

Sin URL fija, se descubre por patrón:

```json
"discover": {"index": "https://.../spk/satellites/", "pattern": "^mar\d{3}s?\.bsp$", "pick": "last"}
```

`common.json` es para lo compartido entre sitios (kernels SPICE, DEM global, gazetteer). Si algo sirve a dos sitios, va ahí, no duplicado.

---

## Checklist antes del PR

- [ ] `python -m json.tool sites/<id>.json` pasa (lo valida el CI).
- [ ] Todas las URLs responden 200 y el `approx_gb` es realista.
- [ ] El `bbox` cubre lo que dicen las `notes`, y el raster lo contiene de verdad.
- [ ] Cada `desc` dice resolución + instrumento + quién publica.
- [ ] Nada de código nuevo en el PR solo para soportar este sitio.
- [ ] Sumado el peso total: ¿entra en el disco del server?
