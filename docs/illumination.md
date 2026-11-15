# Sol y sombra con terreno · `pipeline/illumination.py`

Para cada sol, el script genera una pila de máscaras de sol/sombra indexadas por hora local y el horario de amanecer y atardecer de cada píxel, teniendo en cuenta el terreno. Funciona con cualquier DTM, en cualquier CRS y con cualquier tamaño de píxel. Para Jezero y Gale toma los datos del manifest.

Badge: **DERIVED**. Sale de datos medidos (DTM HiRISE, DEM MOLA+HRSC) y de efemérides de NAIF SPICE. No es una medición de luz.

## Cómo se corre

En el server, con el venv del pipeline:

```bash
cd /opt/mapeando-ando
.venv-pipeline/bin/python pipeline/illumination.py --site jezero --start 2026-11-15T00:00:00
.venv-pipeline/bin/python pipeline/illumination.py --site gale --res 2            # Gale a 2 m
.venv-pipeline/bin/python pipeline/illumination.py --dtm /ruta/otro_dtm.tif \
    --far-dem /ruta/dem_grueso.tif --out /data/output/otro                        # cualquier DTM
```

| Opción | Default | Qué hace |
|---|---|---|
| `--start` | ahora (UTC) | Arranca en la primera medianoche local (LTST 00:00) a partir de esa fecha |
| `--sols` | 1 | Cuántos soles seguidos calcular; uno por carpeta |
| `--step-min` | 60 | Paso de la pila en minutos LTST (10, 15, 20, 30, 60 o 120) |
| `--rise-step-min` | 5 | Resolución del amanecer/atardecer con terreno |
| `--res` | 1 | Promedia el DTM N×N antes de calcular (para DTM enormes o pruebas) |
| `--far-step-m` | 250 | Separación de los observadores del horizonte lejano |
| `--max-dist-km` | 100 | Hasta dónde se busca terreno lejano |
| `--kernels` | `DATA_DIR/raw/common` | Carpeta con `naif*.tls`, `pck*.tpc`, `de4*.bsp` y `mar*.bsp` |

Si falta el manifest, el DTM o algún kernel, el script avisa y sale con código 2 sin escribir nada. Si falta el DEM lejano, sigue igual pero lo marca en `warnings`: el borde del cráter no proyecta sombra y el amanecer sale más temprano.

## Qué produce

Escribe una carpeta por sol en `/data/output/<sitio>/illumination/<medianoche local en UTC>/`, por ejemplo `20261115T0649Z/`. Los rasters tienen la misma grilla y el mismo CRS que el DTM, o la grilla promediada si se usa `--res`.

| Archivo | Contenido |
|---|---|
| `shadow_hourly.tif` | COG uint8 con una banda por hora LTST (24 con el paso por defecto; la banda 1 es 00:00). Valores: `1` sol, `0` sombra, `255` sin dato. De noche, toda la banda es `0`. |
| `sun_times.tif` | COG uint16. Banda 1: amanecer con terreno; banda 2: atardecer con terreno. Ambos en minutos LTST desde la medianoche. `65534` = sin sol directo en todo el sol; `65535` = sin dato. |
| `index.json` | Por banda: hora LTST, hora UTC, azimut y elevación del Sol y fracción del sitio al sol. También trae amanecer y atardecer sobre horizonte plano, Ls (estación), grilla, procedencia, supuestos y avisos. |

El amanecer de un píxel es la primera muestra con sol y el atardecer, la última. El instante real cae dentro del paso `--rise-step-min`: hasta 5 min antes del valor de amanecer, o después del de atardecer. Si un píxel no recibe sol a la mañana, su amanecer es el primer sol de la tarde, y lo mismo al revés con el atardecer.

## Tiles para el mapa · `pipeline/shadow_tiles.py`

El mapa no abre un COG. Después de `illumination.py`, este script tesela cada hora con el Sol sobre el horizonte y escribe los índices que lee el deslizador de tiempo del sol:

```bash
.venv-pipeline/bin/python pipeline/shadow_tiles.py --site jezero                       # todos los soles
.venv-pipeline/bin/python pipeline/shadow_tiles.py --site jezero --sol 20261115T0649Z  # uno
.venv-pipeline/bin/python pipeline/shadow_tiles.py --out /data/output/otro --max-zoom 14
```

| Archivo | Contenido |
|---|---|
| `<sol>/tiles/<HHMM>/{z}/{x}/{y}.png` | Máscara de esa hora: sombra oscura semitransparente, sol transparente, sin dato gris azulado |
| `<sol>/tiles.json` | Por hora: LTST, UTC, azimut y elevación del Sol, fracción al sol, zoom y límites de los tiles, y si falló. Además, el `--max-zoom` con que se corrió |
| `catalog.json` | Qué soles hay en `illumination/` y cuáles están teselados (lo regenera cada corrida) |

- Las horas de noche no se teselan: el mapa pone un velo sobre el sitio. Con `--max-zoom 15` (default), un píxel de tile mide ~2,5 m en Marte (2,4 m en Jezero; los ~4,8 m de z15 son de la Tierra, y acá un grado del esquema XYZ es un grado de Marte). Alcanza para ver moverse las sombras, y si el mapa se acerca más, agranda el último nivel.
- Si un sol ya está teselado para el mismo `index.json` y el mismo `--max-zoom`, no se rehace (`--force` para forzarlo). Un fallo en una hora queda en `tiles.json` y no corta las demás.
- Se reproyecta con vecino más cercano: es una máscara por clases y un promedio inventaría "media sombra". El hueco del DTM (sin dato) y lo que queda fuera del DTM se separan para que el primero se vea y el segundo no.
- Necesita `gdal-bin` (lo instala `deploy/bootstrap.sh`).

## Método

1. **Sol (SPICE).** Se calcula la posición del Sol vista desde el centro del DTM, con corrección de tiempo de luz y aberración (`spkcpo`, `LT+S`), en el marco IAU_MARS. La hora local es la hora solar local verdadera de SPICE (`et2lst`). Las horas de la pila se buscan iterando hasta ±1 s local.
2. **Terreno cercano (dentro del DTM, a su resolución).** Para cada posición del Sol se recorre el DTM en líneas paralelas al azimut solar, empezando del lado del Sol. Un píxel está en sombra si algún punto anterior de su línea cumple `z_j + u_j·tan(e) > z_i + u_i·tan(e)`, donde `u` es la distancia sobre el suelo a lo largo del rayo. Eso es un máximo acumulado: cuesta O(N) por posición del Sol y no requiere guardar horizontes por píxel. Las alturas se pasan antes a un plano tangente en el centro (`z − r²/2R`), así entra la curvatura de Marte: a 10 km son 15 m. Los píxeles anisótropos (equirectangular lejos del ecuador) y los CRS rotados se resuelven con el jacobiano local píxel → metros.
3. **Terreno lejano (fuera del DTM).** Con el DEM MOLA+HRSC de 200 m se precomputa una vez el horizonte en una grilla de observadores separados 250 m, para 360 azimuts. Solo cuenta el terreno que el DTM no cubre, así las dos escalas no se pisan. En cada píxel se corrige por su altura: `tan H ≈ tan H_grilla − (z − z_grilla)/d*`, donde `d*` es la distancia a la que está ese horizonte. Cuando el Sol está por encima de todo el horizonte lejano, este paso se saltea.
4. **Amanecer/atardecer.** Se hacen dos medios barridos cada `--rise-step-min`: la mañana, desde el amanecer plano hasta el mediodía, y la tarde, desde el atardecer plano hacia atrás hasta el mediodía. Cada uno corta cuando una pasada deja todo el DTM al sol.

## Supuestos y límites

- **Sol puntual.** Se usa el centro del disco solar, sin refracción ni polvo. El disco mide ~0.35° visto desde Marte, así que la penumbra no aparece.
- **Un solo Sol para todo el DTM.** El azimut y la elevación se calculan en el centro y se aplican a todo el DTM. En Jezero (~21 km) el error es menor que ±0.2°; en Gale (~57 km) llega a ±0.5°.
- **Borde del DTM.** Cerca del borde, el terreno de afuera se ve con la resolución de la grilla lejana (250 m) y del DEM de 200 m.
- **Huecos del DTM.** Los píxeles sin dato no proyectan sombra dentro del DTM, pero se completan con el DEM de 200 m en la escala lejana.
- **Sol, no luz.** La máscara dice si hay sol directo. No calcula la luz difusa del cielo ni la que rebota en el terreno.
- **Un sol sirve para su estación.** Si la salida cae en un sol que no se corrió, la API y el mapa usan la pila de otro sol con |ΔLs| ≤ 2°, de cualquier año marciano, a la misma hora solar local (ver `docs/context.md` §4). A la misma hora solar local, el Sol cambia solo con su declinación: ±2° de Ls son, como mucho, 0,9° de declinación, y la diferencia se nota más en las sombras con el Sol bajo. Ese resultado va `MODELED`. Por eso el `index.json` guarda `sol.ls_deg` y `site_center`.

## Costo medido (server de 2 vCPU y 7 GB)

| DTM | Grilla | Tiempo por sol | RAM máx. |
|---|---|---|---|
| Jezero promediado ×8 (~8 m) | 2686 × 2675 | ~3.5 min (2 de horizonte lejano) | 0.6 GB |
| Jezero 1 m | 21488 × 21400 | (ver abajo) | ~2.7 GB |

Una pasada del Sol a 1 m en Jezero tarda de 1 a 7 s, según el azimut. El horizonte lejano es un costo fijo de unos 2–3 min por corrida. Los datos de trabajo (memmaps) van a `<out>/illumination/_work/` y se borran al terminar.

## Tests

```bash
cd pipeline && python -m pytest tests                                  # sin kernels: geometría, datos faltantes y teselado (si hay GDAL)
MAPEANDO_KERNELS=/data/raw/common python -m pytest tests               # en el server: corrida completa con SPICE
```
