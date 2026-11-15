# Consumibles del traje · supuestos del modelo

Con los supuestos actuales, caminar en terreno plano a 0.8 m/s gasta unos 600 W. El O2 primario alcanza para unas 3.6 h y la batería para unas 7.3 h: **el O2 es el recurso que limita la EVA.**

El modelo calcula, tramo por tramo, el gasto metabólico del astronauta y lo convierte en O2 y batería consumidos, con los acumulados desde la salida. Lo devuelve `POST /api/route/consumables` y todo lleva el badge **MODELED**: es una estimación, no una medición.

- Valores: [`api/consumables.py`](../api/consumables.py), clase `SuitParams`.
- Lectura del DTM: [`api/terrain.py`](../api/terrain.py).
- Contrato del endpoint: [README](../README.md#consumibles-del-traje-apirouteconsumables--modeled).

> Este archivo es la fuente de los supuestos. Si cambiás un valor en el código, actualizalo acá en el mismo commit.

## Supuestos

Son los valores por defecto, tomados del EMU de la ISS. Cualquiera se puede pisar en cada pedido sin tocar código (ver [Cómo corregir un supuesto](#cómo-corregir-un-supuesto)).

Estado: **Confirmado** (verificado contra una fuente), **A verificar** (valor publicado que falta confirmar) o **Supuesto propio** (lo elegimos nosotros).

| Parámetro | Qué es | Valor | Origen | Estado |
|---|---|---|---|---|
| `astronaut_kg` | Masa del astronauta sin traje | 80 kg | Adulto promedio | A verificar |
| `suit_kg` | Masa del traje con la mochila de soporte vital (PLSS) | 127 kg | EMU de la ISS, ~280 lb | A verificar |
| `cargo_kg` | Carga extra (herramientas, muestras) | 0 kg | Lo elige el usuario en el planificador (ver [Carga del equipo](#carga-del-equipo)) | Dato del usuario |
| `gravity_g` | Gravedad relativa a la Tierra | 0.38 | 3.71 / 9.81 m/s² | Confirmado |
| `terrain_factor` | Factor de terreno de Pandolf (η) | 1.1 | Tabla de Pandolf: 1.0 asfalto, 1.1 camino de tierra, 1.2 arbustos bajos, 2.1 arena suelta. Tomamos regolito compacto ≈ camino de tierra | Supuesto propio |
| `speed_m_s` | Velocidad de caminata | 0.8 m/s (~2.9 km/h) | Caminata con traje | Supuesto propio |
| `o2_kj_per_l` | Energía por litro de O2 consumido | 20.1 kJ/L | Equivalente energético con cociente respiratorio ≈ 0.85 | Confirmado |
| `o2_capacity_kg` | O2 disponible | 0.55 kg | O2 primario del PLSS (1.2 lb). No cuenta la reserva de emergencia (SOP) | A verificar |
| `o2_leak_kg_per_h` | Fuga del traje | 0 kg/h | Despreciable en un EMU nominal | Supuesto propio |
| `battery_capacity_wh` | Capacidad de la batería | 446.9 Wh | 16.8 V × 26.6 Ah (batería del EMU) | A verificar |
| `battery_efficiency` | Fracción de la energía nominal que se aprovecha | 0.9 | Elegido por el equipo | Supuesto propio |
| `base_power_w` | Consumo eléctrico fijo (ventilador, bomba, radio, electrónica) | 55 W | Elegido para que la batería dé ~7 h, del orden de una EVA real | Supuesto propio |

`speed_m_s` y `cargo_kg` van en el primer nivel del pedido; el resto, dentro de `suit`.

## Cómo corregir un supuesto

Para probar un valor sin tocar código, mandalo en el pedido. La respuesta devuelve en `assumptions` los valores que usó.

```json
{
  "site_id": "jezero",
  "points": [{"lat": 18.444, "lon": 77.450}, {"lat": 18.460, "lon": 77.420}],
  "cargo_kg": 20,
  "suit": {"suit_kg": 110, "base_power_w": 60}
}
```

Para cambiar el default de todos:

1. Editar el valor en `SuitParams` de [`api/consumables.py`](../api/consumables.py). Cada línea tiene un comentario con el origen. `speed_m_s` es la excepción: su default está en `RouteRequest` de [`api/main.py`](../api/main.py).
2. Actualizar la fila de la tabla de arriba: valor, origen y estado.
3. Al mergear a `main` se despliega solo. `GET /api/health` muestra el commit que corre.

## Fórmula

Pandolf et al. (1977), con la corrección para bajadas de Santee et al. (2001), integrada cada `sample_step_m` (10 m por defecto) sobre el DTM de 1 m:

```text
M = 1.5·W + g·[ 2.0·(W+L)·(L/W)² + η·(W+L)·(1.5·V² + 0.35·V·G) − CF ]
CF (solo si G < 0) = η·[ G·(W+L)·V/3.5 − (W+L)·(G+6)²/W + (25 − V²) ]
```

`M` es el gasto metabólico en W, `W` la masa del astronauta, `L` la del traje más la carga, `V` la velocidad en m/s, `G` la pendiente en %, `η` el factor de terreno y `g` la gravedad relativa.

- **Ajuste a 0.38 g (hipótesis nuestra).** El término de estar de pie (1.5·W) no se escala, porque es casi todo metabolismo basal. Los términos de carga y caminata, que son trabajo contra el peso, se multiplican por `g`. El gasto nunca baja del de estar de pie.
- **Tiempo** de cada sub-paso = distancia sobre el terreno ÷ `V`.
- **O2** = energía metabólica ÷ `o2_kj_per_l` × 1.429 g/L, más la fuga del traje.
- **Batería** = `base_power_w` × tiempo ÷ `battery_efficiency`. El EMU se enfría sublimando agua, así que la batería no depende del esfuerzo.

## Límites

Los dos primeros también salen en la respuesta (`warnings` y `model_notes`).

- **Pendiente fuera de rango.** Pandolf y Santee se validaron hasta más o menos ±25 %. En Jezero y Gale, con paso de 10 m, aparecen pendientes locales de 40 a 80 %; esos tramos se marcan.
- **Carga muy pesada.** Con el EMU, L/W ≈ 1.6, por encima de lo que se validó. El término de carga probablemente sobreestima, y por eso salen ~600 W en plano.
- **Traje presurizado.** No se modela la rigidez del traje, que suma esfuerzo.
- **Fuera del alcance.** No hay paradas en estaciones, reserva para la vuelta ni velocidad que cambie con la pendiente.
- Es un prototipo educativo: los números sirven como orden de magnitud, no reemplazan un análisis de EVA.

## Carga del equipo

El usuario elige qué lleva en el panel del planificador ("Carga del equipo") y puede sumar kilos a mano (muestras juntadas, otro equipo). El total viaja como `cargo_kg` en `POST /api/route` y entra a Pandolf como parte de `L`. Catálogo: [`web/src/domain/equipment.ts`](../web/src/domain/equipment.ts).

No hay herramientas de EVA marciana que hayan volado, así que las masas son las de Apollo, pesadas para el vuelo. Van con badge **OBSERVED** (son pesos medidos), y en el tooltip queda declarado el supuesto de que un kit para Marte pesaría lo mismo. La carga a mano va como **ASSUMED**: es un dato del usuario.

| Equipo | Masa | Qué suma | Fuente |
|---|---|---|---|
| Taladro de núcleo | 13,4 kg | Apollo Lunar Surface Drill, total de sus 4 componentes | Allton 1989, JSC-23454, ficha del taladro |
| Cámara | 3,08 kg | Hasselblad eléctrica (3,1 lb) + lente de 60 mm (1,7 lb) + empuñadura (0,6 lb) + un cargador (1,4 lb) | *Working on the Moon* (ALSJ), Imagery Weight Totals, Apollo 17 |
| Kit de muestras | 3,04 kg | Pala grande ajustable 590 g + pinzas de 32" 454 g + mango largo 816 g (Apollo 17) + bolsa de recolección 742,7 g + dispensador de 20 bolsas 440,4 g (Apollo 16) | Allton 1989, JSC-23454, tablas de Apollo 16 y 17 |
| Rastrillo | 1,50 kg | 1497 g | Allton 1989, tabla de Apollo 17 |
| Martillo geológico | 1,32 kg | Martillo pesado, 1315 g | Allton 1989, tabla de Apollo 17 |
| Tubos de núcleo | 0,62 kg | Par de tubos de 4 cm: 316,6 g + 299,1 g | Allton 1989, tabla de Apollo 17 |
| Gnomon | 0,27 kg | 272 g | Allton 1989, tabla de Apollo 17 |

Allton, J. H. (1989). *Catalog of Apollo Lunar Surface Geological Sampling Tools and Containers*, JSC-23454, NASA Johnson Space Center.

**Qué mueve y qué no.** Con los supuestos de arriba, en plano a 0,8 m/s:

| Carga | Gasto caminando | Gasto parado | El O2 primario alcanza para |
|---|---|---|---|
| 0 kg | 600 W | 516 W | 3,6 h |
| 3 kg (kit de muestras) | 626 W | 542 W | 3,4 h |
| 13,4 kg (taladro) | 724 W | 636 W | 3,0 h |
| 23,2 kg (todo el catálogo) | 829 W | 737 W | 2,6 h |

- Sube el O2, caminando y en cada parada: el término de carga de Pandolf no depende de la velocidad.
- **No** cambia los tiempos: la velocidad es fija (0,8 m/s). Un modelo de velocidad que baje con la carga no está validado y no lo inventamos.
- **No** cambia la batería: el PLSS gasta lo mismo haga lo que haga el astronauta.
- Con L/W ≈ 1,6 ya con el traje solo, el término de carga probablemente sobreestima (ver [Límites](#límites)). El efecto de cada kilo extra puede estar inflado.

## Pendientes

- [ ] Confirmar con una fuente oficial de NASA la masa del EMU (127 kg), el O2 primario (0.55 kg) y la batería (16.8 V × 26.6 Ah).
- [ ] Decidir si usamos el EMU de la ISS o un traje de superficie más liviano para Marte.
- [ ] Revisar el consumo fijo (55 W) y la eficiencia (0.9), que elegimos nosotros.
- [ ] Acordar el factor de terreno para regolito (hoy 1.1) y la velocidad de caminata (hoy 0.8 m/s).
- [x] Definir el rango de `cargo_kg` con la feature de carga (MAP-50): 0–500 kg en la API, hasta 100 kg a mano en el panel.
- [ ] Envolvente de regreso (MAP-47): no existe todavía; cuando exista, tiene que usar la misma carga.
