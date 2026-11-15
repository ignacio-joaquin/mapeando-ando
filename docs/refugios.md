# Refugios · `pipeline/shelter.py`

Responde **"¿dónde me cubro y a cuántos minutos?"**. Para cada celda del sitio calcula cuánto cielo se ve, marca como refugio los lugares con poco cielo donde se puede estar parado y dice cuántos minutos hay caminando hasta el refugio más cercano.

Es un **refugio de emergencia para dos o tres personas**: alcanza con unos 10 m² (el pie de un bloque grande, una cornisa, el fondo de un cráter chico). Por eso se calcula a 2 m y no a 10.

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
| `--res` | 2 | Promedia el DTM de 1 m en bloques N×N para el sky-view y los refugios |
| `--walk-res` | 10 | Grilla de los minutos (múltiplo de `--res`) |
| `--radius-m` | 500 | Hasta dónde se mira el horizonte local |
| `--directions` | 16 | Azimuts para el sky-view |
| `--svf-max` | 0.85 | Refugio si se ve como mucho esta fracción del cielo |
| `--svf-strong` | 0.75 | Refugio fuerte: el mismo criterio con menos cielo |
| `--max-slope` | 25 (`terrain_layers.SLOPE_CUTS_DEG[-1]`) | Desde esta pendiente (°), inclusive, no se puede estar parado ni pasar |
| `--min-area-m2` | 10 | Manchas de refugio más chicas no cuentan (a 2 m son 3 celdas) |
| `--no-tiles` | | No genera los tiles PNG del mapa |

Sale con 0 si anduvo, 1 si falló (si falla el cálculo no escribe `shelter.json`; si falla solo el teselado, lo anota en la capa) y 2 si faltan datos.

Corrida en el server (2 vCPU, 7 GB), 2026-11-14, a 2 m y minutos a 10 m, **con el corte de pendiente anterior (30°)**. Con 25° los porcentajes y los minutos cambian un poco: hay que volver a correrlo.

| Sitio | Grilla fina | Tiempo | RAM pico | Refugio / fuerte | Al refugio (mediana / p90) | Al fuerte (mediana / p90) |
|---|---|---|---|---|---|---|
| Jezero | 10744 × 10700 (1,9 × 2 m) | 6,6 min | 2,2 GB | 4,2 % / 0,05 % | 3,0 / 11,9 min | 25,0 / 130,8 min |
| Gale | 28720 × 16490 (2 × 2 m) | 36 min | 3,2 GB | 17,9 % / 5,1 % | 0,5 / 6,4 min | 3,6 / 27,2 min |

Con `--res 10` y 1000 m² (la primera versión) salían 1,2 % y 19,7 / 73,2 min en Jezero: a 2 m aparecen los refugios chicos (pie de bloques y cornisas) y casi todo queda a minutos de uno.

**El umbral pesa distinto en cada sitio.** Fracción de celdas con cielo visible bajo cada umbral (solo sky-view, sin el filtro de pendiente y área):

| Umbral | Jezero | Gale |
|---|---|---|
| ≤ 0,85 | 4,7 % | 23,3 % |
| ≤ 0,80 | 0,7 % | 14,5 % |
| ≤ 0,75 | 0,1 % | 9,2 % |
| ≤ 0,70 | 0,0 % | 5,9 % |

En Gale, las faldas de Mount Sharp (yardangs, cárcavas) y el borde norte tienen 50–80 % de refugio por bloque de 128 m: es relieve real, pero ahí "refugio" deja de distinguir. En las llanuras del norte de Gale la densidad cambia por rectángulos que siguen las costuras del mosaico del DTM: parte de esos refugios chicos sale del ruido del DTM, no del relieve.

## Salida

En `<out>/<sitio>/`, al lado de lo que deja `precompute.py`:

| Archivo | Capa del mapa | Qué es | Badge |
|---|---|---|---|
| `shelter_skyview.tif`, `shelter-skyview/` | `survival-shelter-skyview` | Fracción de cielo visible, 0–1, a 2 m. COG float32, nodata −9999 | MRO HiRISE · DERIVED |
| `shelter.tif`, `shelter/` | `survival-shelter` | 2 refugio fuerte, 1 refugio, 0 no, 255 sin dato, a 2 m. COG uint8 | MRO HiRISE · DERIVED |
| `shelter_minutes.tif`, `shelter-minutes/` | `survival-shelter-minutes` | Minutos caminando al refugio más cercano (cualquiera de los dos niveles), a 10 m. COG float32, nodata −9999 | MRO HiRISE · MODELED |
| `shelter_strong_minutes.tif`, `shelter-strong-minutes/` | `survival-shelter-strong-minutes` | Ídem, hasta el refugio fuerte más cercano | MRO HiRISE · MODELED |
| `shelter.json` | | Procedencia, resolución, parámetros, supuestos, estadísticas y tiles de cada capa | |

Las carpetas son tiles XYZ PNG (`pipeline/tiles.py`, rampas `cielo`, `refugio` y `minutos`, con `gdaldem -nearest_color_entry`: solo colores de la leyenda, y la de cielo incluye el corte de arriba, como el `≤` de los refugios). Los nombres de carpeta y los ids son **contrato** con `web/src/map/layers.ts`.

`shelter.json` tiene la misma forma que `terrain.json`; el mapa lee los dos y los junta (`fetchTerrain` en `web/src/api/client.ts`), así una capa se puede prender cuando su COG y sus tiles salieron bien. Si `shelter.json` está roto, el relieve sigue andando.

El sky-view de refugios tiene id y archivo propios porque `skyview.tif` / `survival-skyview` ya es el de `pipeline/radiation.py` (paso de dosis de `precompute.py`), con otro método: 32 azimuts hasta 60 km a 100 m, contra 16 hasta 500 m a 2 m acá. Si compartieran archivo, el que corre último pisaría al otro y el inspector mostraría uno con la procedencia del otro.

Los minutos llevan **MODELED** y no DERIVED: dependen de un modelo de caminata con supuestos (Tobler, velocidad), no solo del DTM.

## En el mapa

- **Refugios**: celeste el refugio, violeta el fuerte; la leyenda dice cuál es cuál y con qué umbral. Lo único que se dibuja es dónde hay refugio.
- **Minutos al refugio fuerte**: igual que la de abajo, pero solo hasta los refugios fuertes.
- **Minutos al refugio**: cuatro clases (< 5, 5–15, 15–30, > 30 min), con el número en la leyenda: no depende solo del color.
- **Cielo visible**: violeta hasta 75 % (fuerte), celeste hasta 85 % (refugio), gris hasta 97 %, transparente con cielo abierto.
- **Inspector**: al fijar un punto, `GET /api/sites/{sitio}/point` devuelve en `layers` los minutos al refugio, los minutos al refugio fuerte y el cielo visible de ese punto, con su badge (`null` si el punto no tiene dato).

## Método

1. **Grillas.** El DTM HiRISE de 1 m promediado 2 × 2 (la misma `WorkGrid` que `illumination.py`), en disco y por franjas: Gale a 2 m son 474 millones de celdas y no entran en memoria. Sky-view y pendiente usan las alturas del DTM, no las del plano tangente del centro: ese plano inclina el terreno ~r/R lejos del centro (0,56° en las esquinas de Gale); en 500 m la curvatura baja el horizonte apenas 4 cm. Los minutos van en una grilla de 10 m: el costo acumulado necesita toda la grilla junta.
2. **Sky-view factor** (Zakšek et al. 2011). Desde cada celda se recorren 16 azimuts hasta 500 m, en distancias que crecen en progresión geométrica. En cada azimut se toma el ángulo de horizonte γ más alto (con piso en 0°) y `SVF = 1 − Σ sin γ / 16`. Plano abierto da 1; el pie de una pared vertical da ~0,5.
3. **Pendiente.** Horn 3 × 3 sobre la misma grilla, con el tamaño de píxel real sobre la esfera (`precompute.slope_strip`).
4. **Refugio.** Dos niveles: refugio `SVF ≤ 0,85` y refugio fuerte `SVF ≤ 0,75`, los dos con `pendiente < 25°` (el corte único de "no transitable": A\*, leyenda y tiles de pendiente), en manchas de al menos 10 m² (vecindad de 8). Por franjas, mirando `min_px` filas de más a cada lado: da lo mismo que de una vez.
5. **Minutos.** En la grilla de 10 m, una celda es refugio si alguna de sus celdas de 2 m lo es. Costo acumulado desde todos los refugios a la vez (scikit-image `MCP_Geometric`, 8 vecinos, píxel anisótropo; el grafo se arma una vez y sirve para los dos niveles). Cada celda cuesta los segundos por metro de la función de Tobler (1993), `6·e^(−3,5·|s + 0,05|)` km/h, escalada para dar **0,8 m/s en plano** (el mismo default que `/api/route/consumables`). La pendiente sale de las 25 celdas de 2 m de cada celda de 10 m, no de un DTM promediado a 10 m (que aplana una franja empinada de pocos metros): la media da la velocidad y la 5.ª más alta decide si se pasa, el mismo criterio que `api/planner.py` (cruzar la celda pisa al menos 5 celdas de 2 m; una sola celda ruidosa no la bloquea). Desde 25° no se pisa. No se sabe si se sube o se baja: se usa el promedio de subir y bajar. La distancia es sobre el terreno (÷ cos θ).

## Límites

- **Resolución.** A 2 m se ven bloques y escalones de algunos metros, no rocas chicas. Los minutos son a 10 m: el camino real puede pasar por un hueco más angosto que una celda, o no poder pasar por una celda que a 10 m parece suave.
- **Borde y huecos.** Sin horizonte completo no hay número: las celdas a menos de 500 m del borde del DTM o de un hueco quedan sin sky-view y no pueden ser refugio. Los minutos sí se calculan ahí (solo necesitan la pendiente).
- **Solo terreno cercano.** No cuenta montañas a más de 500 m ni el borde lejano del cráter.
- **Umbrales propios.** El 0,85 y el 0,75 los elegimos nosotros. No salen de un estudio de dosis. Con un solo umbral no alcanzaba: 0,85 marca casi todas las faldas de Mount Sharp, y algo más estricto deja a Jezero casi sin refugios. Por eso hay dos niveles.
- **Costo de caminata provisorio.** El modelo de rutas sigue abierto (`docs/context.md` §5). Si el planificador adopta otro costo, se cambia `walk_cost` y se recalcula.
- **Isótropo.** Tobler es distinto subiendo que bajando; acá se promedia. La pendiente usada es la de la celda, no la del rumbo: sobreestima el tiempo en laderas que se cruzan de costado.
- **Misma regla que el planificador, pero no la misma pendiente.** El criterio de paso es el de `api/planner.py` (la k-ésima pendiente más alta de la celda), pero acá se aplica a la pendiente a 2 m (DTM promediado 2 × 2), y el A\* usa `slope.tif` a 1 m. Una franja empinada de 1 m de ancho se suaviza un poco: en casos borde, el A\* puede bloquear una celda que acá se pasa.
- **Sin pendiente, no se pasa.** Una celda sin dato de pendiente queda bloqueada, y si eso deja un punto sin camino, ese punto queda sin minutos (nodata, no un número inventado). El A\* hace otra cosa: la deja pasar con el costo de pendiente máximo. Acá preferimos el hueco: un "a N minutos" que cruza terreno sin medir sería un dato que no tenemos.

## Pendientes

- [ ] Revisar los dos umbrales (0,85 y 0,75) con alguien que mire las zonas en el ortho.
- [ ] Filtrar los refugios que salen del ruido en las costuras del mosaico de Gale.
- [ ] Cambiar el costo por el del planificador 4D cuando exista.
