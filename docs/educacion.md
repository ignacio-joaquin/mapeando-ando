# Modo entrenamiento · `web/src/edu/`

Un modo que enseña las dificultades de planificar una EVA en Marte **usando el planificador real**. El alumno arma rutas con el planificador de siempre y cada lección lee lo que contesta `POST /api/route`.

Funciona como un onboarding. El botón 🎓 del encabezado abre un selector de misiones a pantalla completa, y durante la misión una tarjeta flotante apunta a la pieza de la interfaz de la que habla. En los pasos de mirar se atenúa el resto de la pantalla; en los de hacer, no, para poder usar el mapa. La tarjeta se achica con ▾ o con Esc. Pensado para cualquier edad: cada paso tiene una frase corta y clara (`say`), y abajo, en "Más a fondo", el detalle con los números y la letra chica. El detalle viene abierto en los pasos de mirar y cerrado en los de hacer.

Cada misión arranca con la travesía vacía y el clic del mapa en "sumar puntos" (el selector de modo está escondido durante la lección). Así la consigna la cumple lo que hace el alumno y no una ruta que ya estaba. Al salir vuelve la travesía que tenía antes, salvo en la misión final, que deja la ruta armada para imprimirla. Si cambió de sitio en el medio, no se devuelve nada: esos puntos eran de otro lugar.

## La regla

**Una lección no trae números propios.** Todo número que muestra sale de la respuesta real (`web/src/edu/read.ts`), y las consignas se corrigen con predicados sobre esa respuesta (`status`, `limiting_factor`, `margin`, `robustness`), nunca contra un valor esperado escrito en la lección. Si el equipo cambia un límite en `api/safety.py`, las lecciones siguen andando y el texto cambia solo. Lo único escrito a mano son hechos generales (la duración de un sol, la gravedad de Marte), nunca un valor del modelo.

- Una predicción se corrige contra la ruta del momento en que se hizo, congelada: cambiar la ruta después no cambia la corrección.
- La misión final no pide un GO que los datos de hoy no permiten. Si un límite no se pudo evaluar del todo (por ejemplo, la luz sin pila de sombras), el veredicto queda en CAUTION por diseño (`api/safety.py`), y el paso lo dice y se puede saltear.

- Con el planificador de ejemplo (sin backend) no se corrige nada: lo dice en pantalla.
- Si los datos del server no dejan cumplir una consigna (falta la pila de sombras, el DTM, la dosis, los lugares), el paso lo dice y se puede saltear, pero **la lección no queda como hecha**. Nunca se finge el resultado.

## Lecciones

| Id | Dificultad | Lo que lee de la respuesta | Consigna |
|---|---|---|---|
| `datos` | Desconfiá de un número sin fuente | `provenance` de todos los valores, tramos `unknown`, límites `ASSUMED` | Armar cualquier ruta |
| `pendiente` | No se puede caminar por cualquier lado | `legs[].distance`, `max_slope`, límite `terrain`, costo `slope` | Desvío ≥ 15 % sobre la línea recta, o un tramo `limit`/`blocked` (`caution` no cuenta: lo tienen casi todas las rutas) |
| `reloj` | El mapa cambia con la hora (4D) | límite `daylight`, costo `shadow` | Mismos puntos, dos horas de salida con veredictos distintos, **las dos con la luz evaluada**: si una hora tiene sombras calculadas y la otra no, el cambio es de cobertura de datos y no cuenta |
| `consumibles` | El aire y la batería se acaban | límites `o2`, `battery` | Margen de O₂ o batería < 50 % |
| `contacto` | Perder de vista el hábitat | límite `contact`, costo `contact` | Al menos un rato sin línea de vista |
| `dosis` | La radiación se acumula | límite `dose` | Dosis evaluada; muestra qué parte del tope por EVA usaste. No calcula un total de misión: no hay tope de misión con fuente |
| `robustez` | Los planes fallan | `robustness.scenarios` | Predecir el factor limitante; después no NO-GO y todos los escenarios evaluables aguantan |
| `incertezas` | Lo que no sabemos | escenarios `not_evaluated`, factores de costo inactivos, límites sin evaluar o `ASSUMED` | Armar cualquier ruta |
| `mision` | Misión final | todo | Destino = lugar de `places.json` (muestra u objetivo si el sitio los tiene), predecir, dejarla GO y robusta |

## Cómo funciona

- `state/edu.ts`: lección y paso activos, predicción, intentos (cada ruta real que llega con la lección abierta) y lecciones hechas (en `localStorage`, con try/catch: si no hay, el progreso dura lo que la pestaña).
- `edu/lessons.tsx`: las lecciones como datos. Pasos `info`, `task` (con `check`) y `predict` (con `reveal`).
- `edu/EduOverlay.tsx`: el selector de misiones y la tarjeta flotante (se ubica al costado de la pieza `anchor`, o adentro del mapa).
- `edu/stage.ts`: la puesta en escena (piezas visibles, capas, pines, cámara, travesía vacía al empezar) con atributos `data-edu-*` en `<body>`; el CSS está en `index.css`.
- Piezas señalables: `data-edu="verdict" | "breakdown" | "depart" | "sun-timeline" | "layers" | "points" | "search" | "profile" | "clock" | "inspector" | "share" | "tools" | "map"`. Mover o renombrar uno de esos atributos rompe el resaltado de las lecciones.

## Una lección guiada

Cada paso declara su puesta en escena en `edu/lessons.tsx`, y `setupAt()` la acumula paso a paso:

- **`ui`: qué piezas de la interfaz se ven.** Al empezar una lección se esconde todo lo que no es el mapa y el panel. Cada paso suma piezas (`search`, `points`, `verdict`, `breakdown`, `depart`, `sun-timeline`, `profile`, `layers`, `clock`, `inspector`, `share`, `tools`), y lo que un paso resalta o tapa también se ve. Si no hay nada del panel derecho a la vista, el panel desaparece y el mapa se agranda. El aviso "no es software de vuelo" pasa al panel de la lección, que siempre está visible.
- **`layers`: las capas prendidas, exactas.** Las demás se apagan; la ortoimagen no se toca. Si el server no tiene una capa, el paso lo dice. Al salir de la lección vuelven las capas y los pines como los tenía el usuario.
- **`pins`: los pines de lugares.** Apagados salvo que el paso los pida (en la misión final, para elegir el destino).
- **`camera`: a dónde vuela el mapa al entrar al paso.** Puede ser el sitio (bbox de `/api/sites`), el hábitat o la ruta calculada. Nunca una coordenada escrita a mano. Si el paso encuadra la ruta y todavía no está calculada, vuela cuando llega. Si los paneles nuevos achican el mapa justo después del vuelo, reencuadra.
- **`lockZoom`: el zoom trabado** (min = max) en los pasos de mirar. El mapa se sigue pudiendo mover, y el panel avisa que el zoom está trabado. En los pasos donde el alumno arma la ruta el zoom queda libre.

## Contratos que consume

Los ids de límite (`terrain`, `o2`, `battery`, `daylight`, `contact`, `dose`), los ids de factor de costo (`slope`, `shadow`, `contact`), `verdict.robustness` y los ids de capa `relief-slope` y `relief-hillshade`. Cambiar uno obliga a revisar `edu/lessons.tsx` en el mismo PR.

## Estado de los datos (2026-11-15)

- `reloj` no se puede completar en ningún sitio hasta que el server tenga pilas de sombras (`illumination.py` + `shadow_tiles.py`): sin atardecer, la hora no cambia el veredicto.
- Jezero todavía no tiene muestras ni objetivos en `places.json`: la misión final acepta cualquier lugar con nombre y lo avisa.
- Gale no tiene `places.json`: la misión final queda bloqueada ahí.

## Apoyo paso a paso (2026-11-15)

Basado en un informe sobre juegos educativos: las mejoras vienen del apoyo paso a paso y de jugar más de una vez, no de la historia ni del realismo visual. Por eso el esfuerzo va a la guía y no al juego.

- **Escenarios armados.** Una consigna puede traer `preset`: hábitat → destino con ida y vuelta, armado con dos lugares reales de `places.json` (por id, nunca coordenadas escritas a mano). Se eligieron consultando `/api/route` el 2026-11-15, con salida 14:00 UTC y 15 min en el destino:

  | Lección | Escenario | Lo que mostró |
  |---|---|---|
  | `contacto` | Hozho → pal | NO-GO, limita el contacto (pendiente 47 %, O₂ 71 % de margen) |
  | `pendiente` | vindholet → bubenka 1695 | CAUTION, limita la pendiente (4 % de margen), contacto bien |
  | `consumibles` | pile bay → Airfield S | con 15 min limita la pendiente; con 150 min en el destino, NO-GO por O₂ |

  `expect` es lo que mostraba ese día. Mientras el escenario está cargado sin cambios, la tarjeta lo verifica en vivo y, si los datos cambiaron, dice qué limita ahora.
- **Deslizador de hora** (`timeSlider`): ±12 h de a 15 min. Mueve solo la hora de salida, nunca los puntos.
- **Qué misiones se pueden hacer hoy.** Cada lección declara `requires` (`shadows`, `places`). La elección de misiones avisa cuál espera datos que el server no tiene. Cuando el sitio tenga sombras, "El mapa cambia con la hora" pasa a ser la primera misión: cambia una sola cosa, la hora.
- **¿Cómo lo sabemos?** El tooltip de cada badge de procedencia explica en lenguaje llano qué es un dato observado, derivado, modelado o supuesto. Para HiRISE, RAD y Mars24 suma una línea sobre el instrumento, y enlaza a ciencia.nasa.gov.
- **El veredicto es nuestro.** La elección de misiones dice que el GO / NO-GO es de nuestro modelo, no una evaluación de la NASA. Sin logos de la NASA.
- **Sin rankings.** No hay tabla de velocidad ni de distancia: en un planificador de seguridad, eso premia los planes arriesgados.

### Pendiente de decidir (toca contratos o el modelo)

- **Deslizadores de carga y de reserva de O₂, y el escenario "mochila pesada".** `POST /api/route` no recibe parámetros del traje. Sumarlos cambia el contrato de API y web.
- **Reglas de las simulaciones análogas** (MDRS, BASALT): nunca salir solo, no salir cerca del amanecer ni del atardecer, volver con reserva y replanear ante una tormenta a mitad de camino. La reserva y el atardecer ya son límites. Las otras cambiarían el veredicto (`api/safety.py`) y necesitan una fuente citable antes de entrar.
- **"Mediodía vs. atardecer".** Espera a que el server tenga pilas de sombras.
