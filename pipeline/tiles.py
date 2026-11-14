#!/usr/bin/env python3
"""Teselado de capas para el mapa: de un raster marciano a tiles XYZ PNG.

El pipeline escribe COG, que es la fuente de VALORES: de ahí leen el point
query y el perfil de elevación. Pero un navegador no abre un COG, así que lo
que se DIBUJA son tiles XYZ. Este script hace esa traducción.

Es independiente a propósito: toma cualquier raster y lo tesela. Así se puede
correr después de `precompute.py`, de `illumination.py` o de lo que venga, sin
que ninguno tenga que saber del otro.

  python pipeline/tiles.py --input /data/output/jezero/hillshade.tif \
                           --out /data/output/jezero/hillshade
  python pipeline/tiles.py --input /data/output/jezero/slope.tif \
                           --out /data/output/jezero/slope --color pendiente
  python pipeline/tiles.py --vector /data/output/jezero/contours.gpkg \
                           --out /data/output/jezero/contours.geojson

El nombre de la carpeta de salida es CONTRATO: tiene que ser el último segmento
de la plantilla `tiles` de web/src/map/layers.ts (`hillshade/`, `slope/`,
`ortho/`, `contours.geojson`). Si no coincide, el frontend no la encuentra y la
capa queda deshabilitada.

Necesita gdal-bin (gdalwarp, gdaldem, gdal2tiles.py, gdal_edit.py, ogr2ogr),
que ya instala deploy/bootstrap.sh.
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Esfera de Marte: la misma de sites/common.json y api/terrain.py.
MARS_LONGLAT = "+proj=longlat +R=3396190 +no_defs"

GTIFF_OPTS = ["-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=IF_SAFER"]

# Cortes de pendiente de la leyenda del mapa (web/src/map/layers.ts). Si cambian
# allá, cambian acá: el usuario tiene que ver los mismos rangos que dice la leyenda.
RAMPAS = {
    "pendiente": [
        (0, 10, "47 125 79"),     # transitable        #2f7d4f
        (10, 20, "224 162 74"),   # con cuidado        #e0a24a
        (20, 30, "224 122 74"),   # límite del rover   #e07a4a
        (30, 90, "224 86 74"),    # no transitable     #e0564a
    ],
}

# Un GeoJSON más pesado que esto no abre con poca banda.
MAX_GEOJSON_MB = 20

HERRAMIENTAS = ["gdalwarp", "gdaldem", "gdal2tiles.py", "gdal_edit.py", "ogr2ogr"]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run(cmd):
    log("$ " + " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True)


def faltan_herramientas():
    return [t for t in HERRAMIENTAS if shutil.which(t) is None]


def a_crs_web(src: Path, dest: Path, resampling: str = "bilinear") -> None:
    """Deja un raster marciano listo para el esquema XYZ del navegador.

    MapLibre solo entiende el esquema de tiles de Web Mercator terrestre. No hay
    forma de teselar Marte "bien" para un slippy map: lo que se hace, y lo que
    hacen los visores planetarios de la NASA, es reproyectar a lat/lon marciano
    y después *etiquetar* el archivo como EPSG:4326. Los números de lat/lon no
    se tocan, así que cada pixel cae en la coordenada correcta; lo único falso
    es el datum que declara el archivo, y eso solo afecta cómo se dibuja.

    Por eso NINGUNA medición sale del mapa: las distancias las calcula
    web/src/mars/geo.ts y las elevaciones api/terrain.py, los dos sobre la
    esfera marciana real. Ver la limitación anotada en web/src/map/MapView.tsx.
    """
    run(["gdalwarp", "-q", "-overwrite", "-t_srs", MARS_LONGLAT, "-r", resampling,
         *GTIFF_OPTS, src, dest])
    # Solo reescribe la etiqueta del CRS; no mueve ni un pixel.
    run(["gdal_edit.py", "-a_srs", "EPSG:4326", dest])


def colorear(src: Path, dest: Path, rampa: str) -> None:
    """Aplica una rampa de color por rangos, con nodata transparente."""
    tabla = dest.parent / f"{rampa}_colores.txt"
    lineas = ["nv 0 0 0 0"]
    for desde, hasta, rgb in RAMPAS[rampa]:
        # Dos entradas por rango: así el corte es neto y no un degradé.
        lineas.append(f"{desde} {rgb} 255")
        lineas.append(f"{hasta - 0.001} {rgb} 255")
    tabla.write_text("\n".join(lineas) + "\n")
    run(["gdaldem", "color-relief", src, tabla, dest, "-alpha", *GTIFF_OPTS])


def teselar(src: Path, outdir: Path, resampling="average", max_zoom=None) -> int:
    cmd = ["gdal2tiles.py", "--xyz", "-w", "none", "-r", resampling,
           "--processes", os.cpu_count() or 2]
    if max_zoom:
        cmd += ["-z", f"0-{max_zoom}"]
    run(cmd + [src, outdir])
    return sum(1 for _ in outdir.rglob("*.png"))


def vector_a_geojson(src: Path, dest: Path, simplify_deg: float = 0.00001) -> None:
    dest.unlink(missing_ok=True)
    run(["ogr2ogr", "-f", "GeoJSON", "-t_srs", MARS_LONGLAT,
         "-simplify", simplify_deg, dest, src])
    mb = dest.stat().st_size / 1e6
    log(f"{dest.name}: {mb:.1f} MB")
    if mb > MAX_GEOJSON_MB:
        log(f"AVISO: pasa los {MAX_GEOJSON_MB} MB; con poca banda no abre. "
            "Generá las curvas con más equidistancia o simplificá más.")


def main():
    ap = argparse.ArgumentParser(description="Teselado de capas para el mapa")
    fuente = ap.add_mutually_exclusive_group(required=True)
    fuente.add_argument("--input", type=Path, help="raster de entrada (GeoTIFF o COG)")
    fuente.add_argument("--vector", type=Path, help="vectorial de entrada (GPKG, SHP)")
    ap.add_argument("--out", type=Path, required=True,
                    help="carpeta de tiles, o archivo .geojson si es vectorial")
    ap.add_argument("--color", choices=sorted(RAMPAS),
                    help="rampa de color por rangos (para pendiente)")
    ap.add_argument("--max-zoom", type=int, default=None, dest="max_zoom",
                    help="tope de zoom; por defecto lo deduce gdal2tiles del tamaño del pixel")
    ap.add_argument("--resampling", default="average",
                    help="remuestreo entre niveles de zoom (average, near, bilinear...)")
    args = ap.parse_args()

    faltan = faltan_herramientas()
    if faltan:
        sys.exit(f"Faltan herramientas de GDAL: {', '.join(faltan)}. "
                 "En el server las instala deploy/bootstrap.sh (gdal-bin).")

    t0 = time.time()

    if args.vector:
        if not args.vector.exists():
            sys.exit(f"No existe {args.vector}")
        args.out.parent.mkdir(parents=True, exist_ok=True)
        vector_a_geojson(args.vector, args.out)
        log(f"Listo en {(time.time() - t0) / 60:.1f} min")
        return

    if not args.input.exists():
        sys.exit(f"No existe {args.input}")

    # Los intermedios van a una carpeta aparte: son descartables, no son salida.
    tmp = args.out.parent / "_web"
    tmp.mkdir(parents=True, exist_ok=True)
    base = args.input.stem

    web = tmp / f"{base}_4326.tif"
    a_crs_web(args.input, web)

    if args.color:
        coloreado = tmp / f"{base}_color.tif"
        colorear(web, coloreado, args.color)
        web = coloreado

    n = teselar(web, args.out, resampling=args.resampling, max_zoom=args.max_zoom)
    log(f"{n} tiles en {args.out}")
    log(f"Listo en {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
