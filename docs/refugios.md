# Refugios · `pipeline/shelter.py`

Responde **"¿dónde me cubro y a cuántos minutos?"**. Para cada celda del sitio calcula cuánto cielo se ve, marca como refugio los lugares con poco cielo donde se puede estar parado y dice cuántos minutos hay caminando hasta el refugio más cercano.

Poco cielo visible es reparo geométrico: menos cielo abierto es menos radiación de fondo que llega y más pared entre el astronauta y el horizonte. **No es una dosis calculada.**

## Cómo se corre

En el server, con el venv del pipeline:

```bash
cd /opt/mapeando-ando
.venv-pipeline/bin/python pipeline/shelter.py --site jezero
.venv-pipeline/bin/python pipeline/shelter.py --site gale
.venv-pipeline/bin/python pipeline/shelter.py --dtm /ruta/otro_dtm.tif --out /data/output/otro
```

| Opción | Default | Qué hace |
|---|---|---|
| `--res` | 10 | Promedia el DTM de 1 m en bloques N×N antes de calcular |
| `--radius-m` | 500 | Hasta dónde se mira el horizonte local |
| `--directions` | 16 | Azimuts para el sky-view |
| `--svf-max` | 0.85 | Refugio si se ve como mucho esta fracción del cielo |
| `--max-slope` | 30 | Pendiente máxima (°) para estar parado y para caminar |
| `--min-area-m2` | 1000 | Manchas de refugio más chicas no cuentan |

Sale con 0 si anduvo, 1 si falló (no escribe `index.json`) y 2 si faltan datos.

Corrida en el server (2 vCPU, 7 GB), 2026-11-14:

| Sitio | Grilla | Tiempo | RAM pico | Refugio | Mediana / p90 al refugio |
|---|---|---|---|---|---|
| Jezero | 2148 × 2140 (9,5 × 10 m) | 25 s | 0,6 GB | 1,2 % | 19,7 / 73,2 min |
| Gale | 5744 × 3298 (10 × 10 m) | 4,3 min | 1,9 GB | 8,3 % | 10,7 / 56,3 min |

## Salida

En `<out>/<sitio>/shelter/`:

| Archivo | Capa | Qué es | Badge |
|---|---|---|---|
| `skyview.tif` | `survival-skyview` | Fracción de cielo visible, 0–1. COG float32, nodata −9999 | MRO HiRISE · DERIVED |
| `shelter.tif` | `survival-shelter` | 1 refugio, 0 no, 255 sin dato. COG uint8 | MRO HiRISE · DERIVED |
| `shelter_minutes.tif` | `survival-shelter-minutes` | Minutos caminando al refugio más cercano. COG float32, nodata −9999 | MRO HiRISE · MODELED |
| `index.json` | | Procedencia, resolución, parámetros, supuestos y estadísticas de cada capa | |

Los minutos llevan **MODELED** y no DERIVED: dependen de un modelo de caminata con supuestos (Tobler, velocidad), no solo del DTM.

## Método

1. **Grilla.** El DTM HiRISE de 1 m promediado 10 × 10, en el plano tangente del centro (la misma `WorkGrid` que `illumination.py`). A 10 m el cálculo entra en la memoria del server; a 1 m no.
2. **Sky-view factor** (Zakšek et al. 2011). Desde cada celda se recorren 16 azimuts hasta 500 m, en distancias que crecen en progresión geométrica. En cada azimut se toma el ángulo de horizonte γ más alto (con piso en 0°) y `SVF = 1 − Σ sin γ / 16`. Plano abierto da 1; el pie de una pared vertical da ~0,5.
3. **Pendiente.** Horn 3 × 3 sobre la misma grilla, con el tamaño de píxel real sobre la esfera (`precompute.slope_strip`).
4. **Refugio.** `SVF ≤ 0,85` y `pendiente ≤ 30°` (el límite de "no transitable" de la leyenda de pendiente), en manchas de al menos 1000 m² (vecindad de 8).
5. **Minutos.** Costo acumulado desde todos los refugios a la vez (scikit-image `MCP_Geometric`, 8 vecinos, píxel anisótropo). Cada celda cuesta los segundos por metro de la función de Tobler (1993), `6·e^(−3,5·|s + 0,05|)` km/h, escalada para dar **0,8 m/s en plano** (el mismo default que `/api/route/consumables`). Como la pendiente de la celda es la máxima y no se sabe si se sube o se baja, se usa el promedio de subir y bajar. La distancia es sobre el terreno (÷ cos θ). Más de 30° no se pisa.

## Límites

- **Resolución.** A 10 m no se ven rocas, bloques ni escalones chicos. Un refugio real puede ser más chico que una celda; uno de 10 m puede no existir a 1 m.
- **Borde y huecos.** Sin horizonte completo no hay número: las celdas a menos de 500 m del borde del DTM o de un hueco quedan sin sky-view y no pueden ser refugio. Los minutos sí se calculan ahí (solo necesitan la pendiente).
- **Solo terreno cercano.** No cuenta montañas a más de 500 m ni el borde lejano del cráter.
- **Umbral propio.** El 0,85 lo elegimos nosotros: en Jezero deja el ~1 % más cubierto del sitio. No sale de un estudio de dosis.
- **Costo de caminata provisorio.** El modelo de rutas sigue abierto (`docs/context.md` §5). Si el planificador adopta otro costo, se cambia `walk_cost` y se recalcula.
- **Isótropo.** Tobler es distinto subiendo que bajando; acá se promedia. La pendiente usada es la máxima de la celda, no la del rumbo: sobreestima el tiempo en laderas que se cruzan de costado.

## Pendientes

- [ ] Servir las tres capas en el mapa (`web/`) con su badge.
- [ ] Decidir el umbral de refugio con alguien que mire las zonas en el ortho.
- [ ] Cambiar el costo por el del planificador 4D cuando exista.
