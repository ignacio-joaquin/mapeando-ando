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
  python pipeline/tiles.py --input /data/output/jezero/dtm.tif \
                           --out /data/output/jezero/dem --dem

Con --dem el raster es de alturas y sale como tiles `raster-dem` para el mapa 3D
(ver dem_a_tiles): la altura va codificada en los tres canales del PNG.

precompute.py lo llama para la pendiente, el sombreado, el térmico de THEMIS, el peligro y la
dosis (raster_a_tiles) y anota el zoom y los límites en terrain.json; a mano sirve para
cualquier otro raster.

El nombre de la carpeta de salida es CONTRATO: tiene que ser el último segmento
de la plantilla `tiles` de web/src/map/layers.ts (`hillshade/`, `slope/`,
`thermal/`, `hazard/`, `dose/`, `ortho/`, `dem/`, `contours.geojson`). Si no coincide, el frontend no la encuentra y la
capa queda deshabilitada.

Necesita gdal-bin (gdalwarp, gdaldem, gdal2tiles.py, gdal_edit.py, ogr2ogr),
que ya instala deploy/bootstrap.sh.
"""
import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import warnings
from pathlib import Path

import numpy as np

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

# Rampas cuyos tramos incluyen el extremo de arriba, (desde, hasta]: las que copian un "≤" del
# pipeline. "cielo": shelter.py marca refugio con SVF ≤ 0,85 y fuerte con ≤ 0,75, así que un
# 0,75 exacto se pinta fuerte. El resto incluye el de abajo, [desde, hasta): la convención "≥"
# de la pendiente (25° exactos ya es no transitable).
RAMPAS_CERRADAS_ARRIBA = {"cielo"}

# Separación entre el borde de un tramo y la entrada del vecino en la tabla de gdaldem: más
# chica que la distancia entre dos float32 vecinos en todas las rampas, así ningún valor cae
# del lado equivocado del corte.
BORDE = 1e-9


def f32(x: float) -> float:
    """`x` redondeado a float32: los rásteres son float32 y el pipeline compara en float32
    (0,85 queda en 0,85000002, y un SVF de ese valor es refugio)."""
    return struct.unpack("f", struct.pack("f", x))[0]

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


def tabla_de_colores(rampa: str) -> str:
    """La tabla de gdaldem color-relief de una rampa: dos entradas por tramo, una en cada borde.

    Va con -nearest_color_entry: cada valor toma el color de la entrada más cercana, sin
    interpolar. Así el corte es neto y entre dos tramos no aparece un color mezclado que no
    está en la leyenda. El borde que el tramo incluye va justo en el corte (en float32); el
    otro, a BORDE del corte.
    """
    arriba = rampa in RAMPAS_CERRADAS_ARRIBA
    lineas = ["nv 0 0 0 0"]
    for desde, hasta, rgb in RAMPAS[rampa]:
        rgba = rgb if len(rgb.split()) == 4 else f"{rgb} 255"
        desde, hasta = f32(desde), f32(hasta)
        lineas.append(f"{desde + BORDE if arriba else desde!r} {rgba}")
        lineas.append(f"{hasta if arriba else hasta - BORDE!r} {rgba}")
    return "\n".join(lineas) + "\n"


def colorear(src: Path, dest: Path, rampa: str) -> None:
    """Aplica una rampa de color por rangos, con nodata transparente."""
    tabla = dest.parent / f"{rampa}_colores.txt"
    tabla.write_text(tabla_de_colores(rampa))
    run(["gdaldem", "color-relief", src, tabla, dest, "-alpha", "-nearest_color_entry", *GTIFF_OPTS])


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
    al reproyectar: "near" para máscaras (0/1), donde un bilineal inventaría 0,5, y para un dato observado
    grueso (THEMIS a 100 m), que se tiene que ver en sus cuadros y no como un degradé. Sin `warp`,
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


# ------------------------------------------------------------------ relieve 3D (relief-dem)
#
# MapLibre levanta el mapa en 3D con una fuente `raster-dem`: PNG donde cada píxel
# lleva una altura escondida en sus tres canales. gdal2tiles no sirve para esto:
# remuestrea los bytes de cada canal por separado y eso inventa alturas. Acá se
# remuestrea la altura (float) y recién después se codifica, tile por tile.
#
# Codificación (CONTRATO con web/src/map/MapView.tsx, que la lee de terrain.json):
#   h = R·256 + G + B/256, en metros, con pasos de 1/256 m.
# `h` es la altura SOBRE EL PUNTO MÁS BAJO del DTM (`datum_m`), no la absoluta. Así
# un píxel sin dato o fuera del raster (RGB 0, que es lo que MapLibre ve donde no
# hay tile) queda al ras del piso del sitio, y no 2 o 4 km más arriba como pasaría
# con la altura absoluta de Jezero o Gale contra el 0 que MapLibre asume afuera.
# La forma del relieve es la real; el corrimiento es solo de dibujo.

DEM_MAX_ZOOM = 15         # a z15 un píxel de tile mide ~2,5 m en Marte: más fino pesa 10x y no se ve
DEM_TILE_PX = 256
DEM_FILL_PX = 20          # huecos de hasta ~50 m se rellenan para no dibujar pozos; los más grandes no
DEM_ENCODING = {"red_factor": 256.0, "green_factor": 1.0, "blue_factor": 1 / 256, "base_shift": 0.0}
WEB_MERCATOR_HALF = 20037508.342789244  # medio ecuador de EPSG:3857, el esquema de tiles de MapLibre
DEM_HERRAMIENTAS = ["gdalwarp", "gdal_fillnodata.py"]


def grados_por_pixel(z: int) -> float:
    return 360.0 / (2 ** z) / DEM_TILE_PX


def tile_de(lon: float, lat: float, z: int) -> tuple[int, int]:
    """Tile XYZ que contiene un lon/lat (fórmulas de slippy map, con el truco de EPSG:4326)."""
    n = 2 ** z
    lat = max(min(lat, 85.0511), -85.0511)
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def limites_tile_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(oeste, sur, este, norte) del tile en metros de EPSG:3857."""
    lado = 2 * WEB_MERCATOR_HALF / (2 ** z)
    oeste = -WEB_MERCATOR_HALF + x * lado
    norte = WEB_MERCATOR_HALF - y * lado
    return oeste, norte - lado, oeste + lado, norte


def codificar_relieve(h: np.ndarray) -> np.ndarray:
    """Alturas relativas (m, >= 0) -> (3, alto, ancho) uint8. NaN y negativos van a 0."""
    h = np.where(np.isfinite(h), h, 0.0)
    q = np.clip(np.rint(h * 256.0), 0, 2 ** 24 - 1).astype(np.uint32)
    return np.stack([(q >> 16) & 255, (q >> 8) & 255, q & 255]).astype(np.uint8)


def decodificar_relieve(rgb: np.ndarray) -> np.ndarray:
    """La inversa, igual que la hace MapLibre con DEM_ENCODING. Para los tests."""
    r, g, b = (rgb[i].astype(np.float64) for i in range(3))
    e = DEM_ENCODING
    return r * e["red_factor"] + g * e["green_factor"] + b * e["blue_factor"] - e["base_shift"]


def zoom_minimo_dem(bounds: list[float], max_zoom: int) -> int:
    """El zoom más bajo en el que el raster entero cabe en un tile: de ahí para abajo, plano."""
    oeste, sur, este, norte = bounds
    ancho = max(este - oeste, norte - sur)
    z = max_zoom
    while z > 0 and 360.0 / (2 ** z) < ancho:
        z -= 1
    return min(z, max_zoom)


def _valido(z: np.ndarray, nodata) -> np.ndarray:
    ok = np.isfinite(z) & (np.abs(z) < 1e5)  # los DTM de USGS marcan nodata con ±3,4e38
    if nodata is not None and np.isfinite(nodata):
        ok &= z != nodata
    return ok


def teselar_relieve(src: Path, outdir: Path, min_zoom: int, max_zoom: int) -> dict:
    """Tiles de relieve desde un raster de alturas en lon/lat de Marte etiquetado EPSG:4326.

    Escribe en `outdir` directo (sin publicar): lo llama dem_a_tiles() sobre su carpeta
    de trabajo. Devuelve zooms, límites, cantidad y el datum.
    """
    import rasterio
    from rasterio.errors import NotGeoreferencedWarning
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    with rasterio.open(src) as ds:
        # Piso del sitio: el mínimo de lo que tiene dato, leído por bloques.
        piso = np.inf
        for _, win in ds.block_windows(1):
            z = ds.read(1, window=win)
            ok = _valido(z, ds.nodata)
            if ok.any():
                piso = min(piso, float(z[ok].min()))
        if not np.isfinite(piso):
            raise RuntimeError(f"{src} no tiene ningún píxel con altura")
        datum = float(np.floor(piso))
        b = ds.bounds
        bounds = [round(v, 6) for v in (b.left, b.bottom, b.right, b.top)]

        n = 0
        for z in range(min_zoom, max_zoom + 1):
            x0, y0 = tile_de(b.left, b.top, z)
            x1, y1 = tile_de(b.right, b.bottom, z)
            # Agrandar tiles (z alto) con bilineal; achicar (z bajo) promediando.
            remuestreo = Resampling.bilinear if z == max_zoom else Resampling.average
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    dst = np.full((DEM_TILE_PX, DEM_TILE_PX), np.nan, dtype=np.float32)
                    reproject(source=rasterio.band(ds, 1), destination=dst,
                              src_crs=ds.crs, src_nodata=ds.nodata,
                              dst_crs="EPSG:3857", dst_nodata=np.nan,
                              dst_transform=from_bounds(*limites_tile_3857(z, x, y), DEM_TILE_PX, DEM_TILE_PX),
                              resampling=remuestreo)
                    dst[~_valido(dst, None)] = np.nan
                    rgb = codificar_relieve(dst - datum)
                    path = outdir / str(z) / str(x) / f"{y}.png"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    # Un tile es un PNG sin georreferencia, a propósito: lo ubica su z/x/y.
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore", NotGeoreferencedWarning)
                        with rasterio.open(path, "w", driver="PNG", width=DEM_TILE_PX, height=DEM_TILE_PX,
                                           count=3, dtype="uint8") as out:
                            out.write(rgb)
                    n += 1
    # rasterio deja un .aux.xml al lado de cada PNG: nadie los pide.
    for aux in outdir.rglob("*.aux.xml"):
        aux.unlink()
    return {"minzoom": min_zoom, "maxzoom": max_zoom, "bounds": bounds, "count": n, "datum_m": datum}


def dem_a_tiles(src: Path, outdir: Path, max_zoom: int = DEM_MAX_ZOOM) -> dict:
    """Tiles `raster-dem` para el mapa 3D, desde el DTM (cualquier proyección).

    1. gdalwarp a lon/lat de Marte, al tamaño de píxel del zoom máximo, promediando.
    2. gdal_fillnodata rellena huecos chicos (hasta DEM_FILL_PX píxeles): sin eso cada
       hueco del DTM se dibuja como un pozo hasta el piso del sitio. Lo de afuera de la
       huella del DTM no se rellena: queda plano, al ras del piso.
    3. teselar_relieve() remuestrea la altura y la codifica.

    Es solo para dibujar. Ningún valor que ve el usuario sale de acá: las alturas y
    pendientes del inspector y del planificador salen del COG del DTM.
    """
    faltan = [t for t in DEM_HERRAMIENTAS if shutil.which(t) is None]
    if faltan:
        raise RuntimeError("Faltan herramientas de GDAL: " + ", ".join(faltan))
    work = outdir.parent / f".{outdir.name}.work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        paso = grados_por_pixel(max_zoom)
        lonlat = work / "lonlat.tif"
        run(["gdalwarp", "-q", "-overwrite", "-t_srs", MARS_LONGLAT, "-tr", f"{paso:.12f}", f"{paso:.12f}",
             "-r", "average", "-dstnodata", "nan", "-ot", "Float32", *GTIFF_OPTS, src, lonlat])
        relleno = work / "relleno.tif"
        run(["gdal_fillnodata.py", "-q", "-md", str(DEM_FILL_PX), "-si", "1",
             "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", lonlat, relleno])
        run(["gdal_edit.py", "-a_srs", "EPSG:4326", relleno])
        info = teselar_relieve(relleno, work / "tiles", zoom_minimo_dem(limites(relleno), max_zoom), max_zoom)
        if info["count"] == 0:
            raise RuntimeError(f"No salió ningún tile de relieve de {src}")
        publicar_carpeta(work / "tiles", outdir)
        return {"template": f"{outdir.name}/{{z}}/{{x}}/{{y}}.png", "tile_size": DEM_TILE_PX,
                "encoding": DEM_ENCODING, **info}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Teselado de capas para el mapa")
    fuente = ap.add_mutually_exclusive_group(required=True)
    fuente.add_argument("--input", type=Path, help="raster de entrada (GeoTIFF o COG)")
    fuente.add_argument("--vector", type=Path, help="vectorial de entrada (GPKG, SHP)")
    ap.add_argument("--out", type=Path, required=True,
                    help="carpeta de tiles, o archivo .geojson si es vectorial")
    ap.add_argument("--color", choices=sorted(RAMPAS),
                    help="rampa de color por rangos (pendiente, peligro o dosis)")
    ap.add_argument("--max-zoom", type=int, default=None, dest="max_zoom",
                    help="tope de zoom; por defecto lo deduce gdal2tiles del tamaño del pixel")
    ap.add_argument("--dem", action="store_true",
                    help="el raster es un DTM: sacar tiles de relieve 3D (raster-dem) y no una imagen")
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
    if args.dem:
        info = dem_a_tiles(args.input, args.out, max_zoom=args.max_zoom or DEM_MAX_ZOOM)
        log(f"{info['count']} tiles en {args.out} (zoom {info['minzoom']}-{info['maxzoom']}, "
            f"piso {info['datum_m']:.0f} m)")
        log(f"Listo en {(time.time() - t0) / 60:.1f} min")
        return
    info = raster_a_tiles(args.input, args.out, color=args.color, resampling=args.resampling,
                          max_zoom=args.max_zoom)
    log(f"{info['count']} tiles en {args.out} (zoom {info['minzoom']}-{info['maxzoom']})")
    log(f"Listo en {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
