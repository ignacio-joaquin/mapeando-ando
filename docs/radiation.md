# Dosis de radiación por celda · MSL RAD · MODELED

`pipeline/radiation.py`, llamado por `pipeline/precompute.py` como un paso más. Escribe en `/data/output/<sitio>/`:

| Archivo | Unidad | Qué es |
|---|---|---|
| `dose_rate.tif` | µSv/h | Dosis equivalente por celda, grilla de 100 m. La usa `api/planner.py` |
| `skyview.tif` | 0–1 | Fracción del cielo que no tapa el terreno |
| `dose/` | tiles | Capa secundaria `survival-dose` del mapa, con escala fija |

En `terrain.json` quedan como `survival-dose` (con `"display": "budget"` y un `summary` con el rango real) y `survival-skyview`.

## Modelo

```
dosis(celda) = H0 × sky_view(celda) / sky_view(Bradbury Landing)
sky_view     = 1 − promedio sobre azimuts de sin(γ)
```

- **H0 = 0,64 ± 0,12 mSv/día = 26,7 µSv/h**: la dosis **equivalente** en superficie medida por MSL RAD en Gale entre agosto de 2012 y junio de 2013 (Hassler et al., 2014, *Science* 343:1244797; `reference/rad_surface_dose.json`). Se usa la equivalente (Sv) y no la absorbida (0,21 mGy/día) porque el planificador, su límite de dosis por EVA y el mapa trabajan en mSv y µSv/h. Entre una y otra hay un factor ~3: mezclarlas daría dosis 3 veces más bajas.
- **sky-view**: γ es el ángulo del horizonte en cada uno de 32 azimuts, con mínimo 0°. Bajo radiación isótropa desde el cielo, la fracción del ángulo sólido que tapa una pared de ángulo γ es sin γ, así que 1 − promedio(sin γ) es la fracción de cielo abierto.
- **Horizonte**: hasta 60 km, en 200 distancias espaciadas en forma geométrica. Cerca, el DTM HiRISE promediado a 100 m; lejos, el DEM global HRSC/MOLA de 200 m (`dem200_crop.tif`). Incluye la caída por curvatura, d²/2R, con el radio del proyecto (3396190 m, `sites/common.json`).
- **Metros reales**: el DTM está en equirectangular con paralelo estándar en el ecuador. En Jezero, un "metro" de la proyección mide 0,948 m hacia el este, así que los pasos este-oeste se convierten a metros sobre el suelo (`ground_scale_x`). Es el mismo problema que ya se corrigió para la pendiente.
- **Normalización en Bradbury Landing** (−4,5895°, 137,4417°, en Gale): RAD midió con el horizonte de Gale alrededor (sky-view ≈ 0,92). Multiplicar H0 por el sky-view contaba dos veces ese blindaje y daba ~8 % menos justo donde se midió. Dividiendo por el sky-view de Bradbury, el modelo da exactamente H0 en ese lugar. En Gale se toma de la grilla; desde otro sitio se calcula con el DEM de 200 m de Gale (Bradbury está en una planicie: el detalle del DTM casi no cambia su horizonte). Si faltan los datos de Gale, la dosis no se normaliza y `terrain.json` lo avisa.

## Cómo se muestra

**Decisión (2026-11-14): presupuesto de dosis de la travesía como vista principal; el raster es una capa secundaria.**

La dosis cambia de un lugar a otro menos que la incertidumbre de la propia medición de RAD (±19 %), y el modelo isótropo además exagera ese cambio. Lo que pesa es el tiempo afuera, no el lugar. Por eso:

- El planificador usa el promedio de `dose_rate.tif` sobre los puntos de la ruta para la dosis acumulada en cada estación y para el límite de dosis por EVA (`api/safety.py`). Sin la capa, usa la tasa de base igual en todo el recorrido.
- La dosis **no** entra en el costo del A\*: la diferencia entre caminos es menor que la incertidumbre.
- La capa del mapa usa **escala fija** de 0 a la base, en cuartos y con un solo tono (`RAMPAS["dosis"]` en `pipeline/tiles.py` = leyenda de `survival-dose` en `web/src/map/layers.ts`). No se estira al rango del sitio y la leyenda no usa palabras de alarma.
- `summary.spread_vs_uncertainty` en `terrain.json` guarda la mitad del rango p1–p99 contra la incertidumbre de RAD, para revisar la decisión si cambian los datos. Ya no hay una regla automática: la decisión es esta y está escrita en los datos (`"display": "budget"`).

## Limitaciones

- La radiación cerca del horizonte atraviesa más atmósfera y llega menos que la del cenit. El modelo isótropo **sobreestima** el blindaje del terreno: es una cota superior.
- H0 cambia en el tiempo con el ciclo solar, la presión atmosférica estacional y los eventos de partículas solares. Este modelo solo describe cómo cambia en el espacio.
- No incluye los neutrones que rebotan en el suelo, que no dependen del sky-view.
- Si falta `dem200_crop.tif`, el horizonte lejano no se incluye y el sky-view sale más alto de lo real; `terrain.json` lo avisa.
- Grilla de 100 m: no ve paredes de menos de ~100 m de ancho.
