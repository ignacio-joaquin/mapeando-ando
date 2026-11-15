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

precompute.py lo llama para la pendiente, el sombreado y el peligro (raster_a_tiles) y anota
el zoom y los límites en terrain.json; a mano sirve para cualquier otro raster.

El nombre de la carpeta de salida es CONTRATO: tiene que ser el último segmento
de la plantilla `tiles` de web/src/map/layers.ts (`hillshade/`, `slope/`,
`hazard/`, `ortho/`, `contours.geojson`). Si no coincide, el frontend no la encuentra y la
capa queda deshabilitada.

Necesita gdal-bin (gdalwarp, gdaldem, gdal2tiles.py, gdal_edit.py, ogr2ogr),
que ya instala deploy/bootstrap.sh.
"""
import argparse
import json
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
        (20, 25, "224 122 74"),   # límite del rover   #e07a4a
        (25, 90, "224 86 74"),    # no transitable     #e0564a  (25° = límite duro, api/safety.py)
    ],
    # Clases de pipeline/terrain_layers.py (hazard.tif) = leyenda de survival-hazard en
    # web/src/map/layers.ts. Mismos colores que la pendiente: el mismo nivel de riesgo se ve igual.
    "peligro": [
        (0, 1, "47 125 79"),      # bajo               #2f7d4f
        (1, 2, "224 162 74"),     # medio              #e0a24a
        (2, 3, "224 122 74"),     # alto               #e07a4a
        (3, 4, "224 86 74"),      # no transitable     #e0564a
    ],
    # Capas de refugio (pipeline/shelter.py). Un color con cuatro números lleva su alfa.
    "cielo": [
        (0, 0.75, "176 124 240"),     # refugio fuerte     #b07cf0
        (0.75, 0.85, "86 200 232"),   # refugio            #56c8e8
        (0.85, 0.92, "138 154 140"),  # algo cubierto      #8a9a8c
        (0.92, 0.97, "120 108 96 120"),  # poco cubierto   #786c60, semitransparente
        (0.97, 1.001, "0 0 0 0"),     # cielo abierto: transparente
    ],
    "refugio": [
        (0, 1, "0 0 0 0"),            # no es refugio: transparente
        (1, 2, "86 200 232"),         # refugio            #56c8e8 (no se confunde con "< 5 min")
        (2, 3, "176 124 240"),        # refugio fuerte     #b07cf0
    ],
    "minutos": [
        (0, 5, "47 125 79"),          # < 5 min            #2f7d4f
        (5, 15, "224 162 74"),        # 5–15 min           #e0a24a
        (15, 30, "224 122 74"),       # 15–30 min          #e07a4a
        (30, 100000, "224 86 74"),    # > 30 min           #e0564a
    ],
}
# Dosis (dose_rate.tif, µSv/h) con escala FIJA de 0 a la base de RAD (0,64 mSv/día = 26,7 µSv/h),
# en cuartos, y un solo tono: no se estira al rango del sitio para no dramatizar diferencias que
# son menores que la incertidumbre de la medición. = leyenda de survival-dose en layers.ts.
RAMPAS["dosis"] = [
    (0.0, 6.67, "232 228 240"),     # < 6,7 µSv/h        #e8e4f0
    (6.67, 13.33, "190 178 216"),   # 6,7–13,3           #beb2d8
    (13.33, 20.0, "143 125 186"),   # 13,3–20            #8f7dba
    (20.0, 1000.0, "96 76 150"),    # ≥ 20 (base 26,7)   #604c96
]

# Rampas de un raster POR CLASES: al reproyectar se usa el vecino más cercano, porque un
# bilineal entre la clase 0 y la 3 inventa un 1,5 que no existe.
RAMPAS_POR_CLASES = {"peligro"}

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


def a_crs_web(src: Path, dest: Path, resampling: str = "bilinear", te=None) -> None:
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

    `te` recorta en lon/lat (lon_min, lat_min, lon_max, lat_max) antes de
    teselar. Se usa con la ortoimagen, que cubre más que el sitio y teselarla
    entera cuesta horas y llena el disco.
    """
    cmd = ["gdalwarp", "-q", "-overwrite", "-t_srs", MARS_LONGLAT, "-r", resampling]
    if te:
        cmd += ["-te", *[f"{v:.6f}" for v in te]]
    run([*cmd, *GTIFF_OPTS, src, dest])
    # Solo reescribe la etiqueta del CRS; no mueve ni un pixel.
    run(["gdal_edit.py", "-a_srs", "EPSG:4326", dest])


def colorear(src: Path, dest: Path, rampa: str) -> None:
    """Aplica una rampa de color por rangos, con nodata transparente."""
    tabla = dest.parent / f"{rampa}_colores.txt"
    lineas = ["nv 0 0 0 0"]
    for desde, hasta, rgb in RAMPAS[rampa]:
        # Dos entradas por rango: así el corte es neto y no un degradé.
        rgba = rgb if len(rgb.split()) == 4 else f"{rgb} 255"
        lineas.append(f"{desde} {rgba}")
        lineas.append(f"{hasta - 0.001} {rgba}")
    tabla.write_text("\n".join(lineas) + "\n")
    run(["gdaldem", "color-relief", src, tabla, dest, "-alpha", *GTIFF_OPTS])


def teselar(src: Path, outdir: Path, resampling="average", max_zoom=None) -> int:
    cmd = ["gdal2tiles.py", "--xyz", "-w", "none", "-r", resampling,
           "--processes", os.cpu_count() or 2]
    if max_zoom:
        cmd += ["-z", f"0-{max_zoom}"]
    run(cmd + [src, outdir])
    return sum(1 for _ in outdir.rglob("*.png"))


def zooms(outdir: Path) -> tuple[int, int]:
    """Zoom mínimo y máximo que generó gdal2tiles (una carpeta por nivel)."""
    niveles = sorted(int(p.name) for p in outdir.iterdir() if p.is_dir() and p.name.isdigit())
    return niveles[0], niveles[-1]


def limites(raster: Path) -> list[float]:
    """[oeste, sur, este, norte] en lon/lat de Marte de un raster ya pasado por a_crs_web()."""
    out = subprocess.run(["gdalinfo", "-json", str(raster)], capture_output=True, text=True, check=True)
    esquinas = json.loads(out.stdout)["cornerCoordinates"]
    oeste, norte = esquinas["upperLeft"]
    este, sur = esquinas["lowerRight"]
    return [round(v, 6) for v in (oeste, sur, este, norte)]


def publicar_carpeta(nueva: Path, destino: Path) -> None:
    """Reemplaza `destino` por `nueva` con dos renombres: nginx no sirve una pirámide a medias."""
    vieja = destino.with_name(f".{destino.name}.vieja")
    shutil.rmtree(vieja, ignore_errors=True)
    if destino.exists():
        os.replace(destino, vieja)
    os.replace(nueva, destino)
    shutil.rmtree(vieja, ignore_errors=True)


def raster_a_tiles(src: Path, outdir: Path, color=None, resampling=None, max_zoom=None, te=None,
                   warp=None) -> dict:
    """Tesela `src` en `outdir` y devuelve lo que el mapa necesita para pedir los tiles.

    Los intermedios van a una carpeta oculta al lado de `outdir` y se borran al final.
    Una capa por clases (`color`) se remuestrea con el vecino más cercano: un promedio
    mezcla las clases e inventa colores que no están en la leyenda. `warp` es el remuestreo
    al reproyectar: "near" para máscaras (0/1), donde un bilineal inventaría 0,5. Sin `warp`,
    "near" para las rampas de RAMPAS_POR_CLASES y bilineal para el resto.
    """
    work = outdir.parent / f".{outdir.name}.work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        web = work / "web.tif"
        if warp is None:
            warp = "near" if color in RAMPAS_POR_CLASES else "bilinear"
        a_crs_web(src, web, resampling=warp, te=te)
        if color:
            coloreado = work / "color.tif"
            colorear(web, coloreado, color)
            web = coloreado
        remuestreo = resampling or ("near" if color else "average")
        n = teselar(web, work / "tiles", resampling=remuestreo, max_zoom=max_zoom)
        if n == 0:
            raise RuntimeError(f"gdal2tiles no generó ningún tile de {src}")
        zmin, zmax = zooms(work / "tiles")
        info = {"template": f"{outdir.name}/{{z}}/{{x}}/{{y}}.png", "minzoom": zmin, "maxzoom": zmax,
                "bounds": limites(web), "count": n, "resampling": remuestreo}
        publicar_carpeta(work / "tiles", outdir)
        return info
    finally:
        shutil.rmtree(work, ignore_errors=True)


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
                    help="rampa de color por rangos (pendiente o peligro)")
    ap.add_argument("--max-zoom", type=int, default=None, dest="max_zoom",
                    help="tope de zoom; por defecto lo deduce gdal2tiles del tamaño del pixel")
    ap.add_argument("--resampling", default=None,
                    help="remuestreo entre niveles de zoom (default: near con --color, average sin)")
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

    args.out.parent.mkdir(parents=True, exist_ok=True)
    info = raster_a_tiles(args.input, args.out, color=args.color, resampling=args.resampling,
                          max_zoom=args.max_zoom)
    log(f"{info['count']} tiles en {args.out} (zoom {info['minzoom']}-{info['maxzoom']})")
    log(f"Listo en {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
