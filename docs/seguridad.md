# Seguridad de una ruta · `api/safety.py`

Responde **"¿salgo o no salgo, y qué es lo que me limita?"**. Es la base del veredicto GO / CAUTION / NO-GO de `POST /api/route` y del mensaje del pitch: *ni la más rápida ni la más corta, la más segura*.

**Regla: no inventamos probabilidades.** Todo sale de márgenes que se pueden calcular y explicar.

## 1. Límites duros: si se rompe uno, es NO-GO

No se compensan con nada. Los valores los fija el equipo y **todavía no tienen fuente citable** (trajes EMU, análisis de Apollo, etc.). Se cambian en `Limits` de `api/safety.py` **y en esta tabla**.

Procedencia del valor del límite (`limit` en la respuesta):

- **`ASSUMED`** (badge propio en la UI) cuando el número entero lo eligió el equipo: pendiente, contacto, dosis y calorías.
- **`MODELED`** cuando sale de un parámetro del traje o de un dato, y la parte del equipo va en `assumptions`:
  - O2 y batería: capacidad del EMU × 0,8, con la reserva del 20 % como supuesto.
  - Luz: atardecer de la pila de sombras (MRO, HiRISE DTM + SPICE) − 30 min − salida, con el margen de 30 min como supuesto. Si la pila es de otro sol de la misma estación (|ΔLs| ≤ 2°, ver `docs/context.md` §4) va igual `MODELED` y el supuesto dice de qué sol sale. Sin pila de sombras va `ASSUMED`.

| Id | Límite | Valor | Qué se mide en la ruta | De dónde sale lo medido |
|---|---|---|---|---|
| `terrain` | Pendiente máxima transitable | **25°** | pendiente que no se puede esquivar en la peor celda pisada (ver abajo) | `slope.tif` (HiRISE DTM) · DERIVED |
| `o2` | Reserva de O2 al volver | **20 %** de la capacidad | O2 consumido (Pandolf) vs. capacidad × 0,8 | `api/consumables.py` · MODELED |
| `battery` | Reserva de batería al volver | **20 %** de la capacidad | batería consumida vs. capacidad × 0,8 | `api/consumables.py` · MODELED |
| `daylight` | Volver antes del atardecer, con margen | **30 min** antes | duración vs. (atardecer − 30 min − salida) | atardecer plano del `index.json` de la pila de sombras |
| `contact` | Minutos seguidos sin contacto con el hábitat | **10 min** (default del briefing) | racha más larga sin línea de vista al hábitat, contando las esperas | `api/contact.py` sobre el DTM · MODELED |
| `dose` | Presupuesto de dosis por EVA | **0,5 mSv** (a revisar) | tasa de base × tiempo afuera | MSL RAD, Hassler et al. 2014 · MODELED |
| `calories` | Tope de calorías por EVA | **sin definir** | gasto de Pandolf en kcal | `api/consumables.py` · MODELED |

Notas:

- **Pendiente.** Ojo: Pandolf (el modelo de consumo) se validó hasta ±25 % *de grado* (~14°), no hasta 25°. El límite de 25° es solo un supuesto de transitabilidad a pie. Es el mismo corte en todos lados (decidido 2026-11-14):
  - el A\*: no pisa celdas que lo superan;
  - la clase `blocked` del tramo (`SLOPE_CUTS` de `api/planner.py`);
  - la leyenda del mapa: "> 25° no transitable" (`SLOPE_CLASSES` de `web/src/map/layers.ts`);
  - los tiles de pendiente (`RAMPAS` de `pipeline/tiles.py`).

  Antes cortaba en 30°. **Los tiles de pendiente que ya están en el server hay que regenerarlos** (correr `precompute.py`) para que el mapa pinte el corte nuevo.
- **Pendiente que no se puede esquivar, no media ni máximo.** El A\* trabaja con celdas que juntan f × f píxeles de `slope.tif` (≈ 6 m en un tramo de 1 km, ≈ 30 m en uno de 5 km). Por cada celda se guardan dos valores:
  - La **media** se usa solo para el costo (`r_pendiente`).
  - La **f-ésima pendiente más alta** de la celda decide qué celdas no se pisan, el límite duro, el `max_slope` del tramo y su color. Cruzar la celda de lado a lado pisa al menos f píxeles, así que:
    - una franja de 40° que la atraviesa (≥ f píxeles) no se diluye en el promedio ni da un margen falso;
    - una roca o un píxel ruidoso suelto (< f píxeles) no bloquea una celda de 30 m. Con el máximo, lo que se podía pisar dependía del largo del tramo: el mismo terreno daba NO-GO en un tramo de 5 km y GO partido en dos.
  - Con f = 1 es el valor del píxel. Las celdas incompletas (borde de la ventana o del DTM, huecos) usan el máximo, que es lo conservador.
- **Contacto sin dato.** Un paso sin dato de visibilidad (por ejemplo, un tramo en línea recta fuera del DTM) no es "sin contacto". Se calculan dos rachas:
  - la **medida**, solo con pasos sin vista confirmada;
  - la **pesimista**, que también cuenta los pasos sin dato.

  Solo la medida puede romper el límite. Si la pesimista lo pasa y la medida no, el límite queda incompleto: CAUTION, con una nota de cuántos minutos faltan. Si ni la pesimista lo pasa, se cumple seguro y solo se avisa.
- **Ventana de la línea de vista.** `ContactField` lee el DTM con el mismo margen que la ventana del A\* del tramo más largo (tope 3 km). Así ninguna celda que el A\* puede elegir queda sin dato de visibilidad.
- **Calorías.** Se calculan y se muestran siempre, pero mientras el tope esté en `null` el límite sale `undefined`: no cuenta en el puntaje ni fuerza CAUTION.
- **Hábitat.** Es la salida (`waypoints[0]`). La reserva se mide al final de la ruta, sea o no el hábitat.

## 2. Puntaje = el margen más chico ("eslabón más débil")

Para cada límite, en el peor punto de la ruta:

```
margen_i = 1 − usado_i / límite_i
puntaje  = 100 · min_i margen_i          (recortado a 0–100)
```

El límite que da el mínimo es el **factor limitante** que muestra la UI. Ejemplo: O2 35, contacto 60, atardecer 15 → puntaje 15, "Limita: regreso antes del atardecer".

Un límite que no se pudo evaluar (`value: null` en `used`) **no entra** en el mínimo: se lista como "sin evaluar" y fuerza CAUTION. Nunca se rellena.

## 3. Robustez por escenarios

Se evalúa **la misma ruta** en condiciones de estrés: si salgo tarde con esta ruta, ¿sigo bien? No se recalcula el camino. Se muestra como **"Robusta en N de M escenarios"**: cuenta escenarios, no es una probabilidad. M solo incluye los escenarios que se pueden calcular.

| Id | Escenario | Cómo se calcula |
|---|---|---|
| `late_30` | Salir 30 min tarde | misma ruta, salida + 30 min |
| `slow_20` | Caminar un 20 % más lento | velocidad × 0,8 |
| `cargo_10` | Llevar un 10 % más de carga | carga + 10 % de la masa transportada (traje + carga) |
| `dust_storm` | Tormenta de polvo (más frío) | **no evaluable**: no hay modelo térmico del traje, y el frío no cambia ningún límite que podamos calcular |
| `no_shelter` | Sin el refugio más cercano | **no evaluable**: ningún límite duro depende hoy del refugio, y los refugios todavía no entran al planificador |

Los dos escenarios no evaluables salen en la respuesta con `status: "not_evaluated"` y el motivo. No se inventa su efecto.

## Veredicto

- **NO-GO**: algún límite duro roto en el caso base.
- **CAUTION**: puntaje < 20, falla en algún escenario de estrés, o un límite definido que no se pudo evaluar del todo (falta la pila de sombras, falta el DTM para el contacto, pasos sin pendiente).
- **GO**: todo lo demás.

## 4. Elegir entre rutas que pasan los límites: costo del A\*

`api/planner.py` busca la ruta de menor costo entre las que respetan la pendiente máxima:

```
costo = Σ celdas Δt · (1 + Σ_k w_k · r_k(x, t))
```

- `Δt` es el tiempo de caminata del paso.
- `r_k ∈ [0, 1]` en la celda `x` a la hora de llegada `t` (eso la hace 4D).
- El `1 +` es el tiempo puro. Garantiza que cada paso cueste al menos `Δt`, así la heurística (distancia / velocidad) es admisible y el A\* da el óptimo de la grilla.

| Id | Factor | `w` por defecto | `r_k` | Estado |
|---|---|---|---|---|
| `slope` | Pendiente | **2,0** | pendiente / pendiente máxima; sin dato = 1 | activo |
| `shadow` | Sombra / frío | **1,0** | 1 en sombra a la hora de llegada, 0 al sol o sin dato | activo si hay pila de sombras |
| `contact` | Sin contacto con el hábitat | **1,0** | 1 sin línea de vista o sin dato, 0 con vista | activo si hay DTM |
| `roughness` | Rugosidad | 1,0 | — | inactivo: falta la capa |
| `loose_soil` | Suelo suelto (THEMIS) | 1,0 | — | inactivo: falta la inercia térmica procesada |
| `radiation` | Radiación por terreno | 1,0 | — | inactivo: la tasa de base es igual en todas las celdas |

Los pesos se cambian en `CostWeights` de `api/planner.py` y en esta tabla. Con estos defaults, una celda de 20° en sombra y sin contacto cuesta 1 + 1,6 + 1 + 1 = 4,6 veces su tiempo de caminata. La respuesta trae `cost` con el peso de cada factor y cuántos minutos-equivalentes aportó en la ruta elegida. Los inactivos van con `minutes: null` y el motivo.

## Contacto: línea de vista al hábitat (`api/contact.py`)

Geometría sobre el DTM, con estos supuestos (todos van en `assumptions`):

- Radio en línea de vista directa, sin repetidores ni difracción.
- Antena del hábitat a 3 m sobre el suelo y la del traje a 2 m.
- Se descuenta la curvatura de Marte.
- El DTM se lee una vez por pedido, promediado (lado ≤ 1500 celdas) en una ventana que cubre todas las estaciones más el margen del A\* del tramo más largo (entre 1 y 3 km). Los obstáculos más chicos que la celda no se ven.
- Hasta 128 muestras por rayo.

Rendimiento medido en una laptop: 0,44 s para 90 000 celdas (una grilla de A\* de 300 × 300).

## Tests

- `api/tests/test_safety.py`: lógica pura, sin rasters. Incluye el caso **MAP-25**: la misma ruta a tres horas de salida da GO, CAUTION y NO-GO.
- `api/tests/test_planner.py::TestSeguridad`: de punta a punta, con rasters sintéticos. Una loma corta el contacto, la hora de salida cambia el veredicto, el desglose del costo suma el total y una pendiente entre 25° y 30° bloquea.
- `api/tests/test_planner.py::TestPendienteMaxima`: una franja angosta que cruza la celda bloquea; rocas sueltas en celdas gruesas no.
- `api/tests/test_planner.py::TestVeredictoPorReserva`: si O2 o batería no alcanzan, el veredicto culpa al que se agota primero.
