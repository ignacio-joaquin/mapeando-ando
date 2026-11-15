#!/usr/bin/env python3
"""Refugios: "¿dónde me cubro y a cuántos minutos?".

A partir del DTM del sitio genera, en <out>/<sitio>/:

    shelter_skyview.tif   fracción de cielo visible (sky-view factor, 0–1), COG float32. No es el
                          skyview.tif de radiation.py (100 m, hasta 60 km): ese es para la dosis
    shelter.tif           2 refugio fuerte, 1 refugio, 0 no, 255 sin dato; COG uint8
    shelter_minutes.tif   minutos caminando hasta el refugio más cercano, COG float32
    shelter_strong_minutes.tif   ídem, hasta el refugio fuerte más cercano
    shelter-skyview/, shelter/, shelter-minutes/, shelter-strong-minutes/   tiles XYZ PNG (pipeline/tiles.py)
    shelter.json          procedencia, parámetros, estado y tiles de cada capa (mismo formato
                          que terrain.json, así el mapa lo lee igual)

Refugio = poco cielo visible (pie de escarpes, paredes de cráter, bloques grandes) en un lugar
donde se puede estar parado. Dos niveles: refugio (cielo ≤ 85 %) y refugio fuerte (≤ 75 %). Es un refugio de emergencia para dos o tres personas: alcanza con
unos 10 m². Menos cielo visible es menos radiación de fondo y más reparo; el número es
geométrico, no una dosis.

    python pipeline/shelter.py --site jezero
    python pipeline/shelter.py --dtm /ruta/dtm.tif --out /data/output/otro

Dos grillas: el sky-view y los refugios se calculan sobre el DTM promediado `--res` × `--res`
(2 m por defecto, para ver refugios chicos) y por franjas, sin cargar todo en memoria. Los
minutos se calculan sobre una grilla más gruesa (`--walk-res`, 10 m) porque el costo acumulado
necesita toda la grilla a la vez. Método y límites: docs/refugios.md.

Sale con 0 si anduvo, 1 si falló y 2 si faltan datos.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import shutil
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from rasterio.transform import Affine
from rasterio.windows import Window
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import illumination as il  # noqa: E402
import precompute as pc  # noqa: E402
import terrain_layers as tl  # noqa: E402
import tiles  # noqa: E402

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

# Parámetros por defecto (supuestos propios: ver docs/refugios.md)
RES = 2                    # promediar el DTM de 1 m en bloques de 2 × 2
WALK_RES = 10              # grilla de los minutos (múltiplo de RES)
RADIUS_M = 500.0           # hasta dónde se mira el horizonte local
DIRECTIONS = 16            # azimuts para el sky-view factor
DIST_RATIO = 1.15          # las distancias de muestreo crecen en progresión geométrica
SVF_MAX = 0.85             # refugio si se ve como mucho el 85 % del cielo
SVF_STRONG = 0.75          # refugio fuerte: 75 % o menos (en Gale, 0,85 marca casi todas las faldas)
# El corte único de "no transitable" (api/safety.py, leyenda de relief-slope), con la misma
# convención: desde este valor, inclusive, no se pisa.
MAX_SLOPE_DEG = tl.SLOPE_CUTS_DEG[-1]
MIN_AREA_M2 = 10.0         # dos o tres personas sentadas
WALK_SPEED_M_S = 0.8       # en plano; el mismo default que /api/route/consumables
STRIP_PX = 4_000_000       # píxeles por franja (sin contar el halo)

F32_NODATA = -9999.0
U8_NODATA = 255

# id de capa (web/src/map/layers.ts) -> archivo COG, carpeta de tiles, rampa de tiles.py y
# remuestreo al reproyectar. La carpeta es CONTRATO: el último segmento de la plantilla `tiles`.
LAYER_FILES = {
    "survival-shelter-skyview": ("shelter_skyview.tif", "shelter-skyview", "cielo", "bilinear"),
    "survival-shelter": ("shelter.tif", "shelter", "refugio", "near"),
    "survival-shelter-minutes": ("shelter_minutes.tif", "shelter-minutes", "minutos", "bilinear"),
    "survival-shelter-strong-minutes": ("shelter_strong_minutes.tif", "shelter-strong-minutes", "minutos",
                                        "bilinear"),
}


class DataNotReady(Exception):
    """Faltan datos de entrada (la descarga todavía no terminó o la ruta está mal)."""


def log(msg: str) -> None:
    print(f"[{dt.datetime.now(dt.timezone.utc):%H:%M:%S}] {msg}", flush=True)


# ------------------------------------------------------------------ sky-view factor

def ray_offsets(jac: np.ndarray, directions: int, radius_m: float, ratio: float = DIST_RATIO):
    """Por azimut, los desplazamientos enteros (fila, col) a muestrear y su distancia sobre el
    suelo (m). Distancias de 1 píxel hasta `radius_m` en progresión geométrica, sin repetidos."""
    jinv = np.linalg.inv(jac)                       # (este, norte) en m -> (col, fila) en píxeles
    px = min(np.hypot(*jac[:, 0]), np.hypot(*jac[:, 1]))
    dists = [px]
    while dists[-1] * ratio < radius_m:
        dists.append(max(dists[-1] * ratio, dists[-1] + px))
    dists.append(radius_m)
    out = []
    for k in range(directions):
        az = 2 * math.pi * k / directions
        seen, ray = set(), []
        for d in dists:
            dc, dr = jinv @ np.array([math.sin(az), math.cos(az)]) * d
            off = (int(round(dr)), int(round(dc)))
            if off == (0, 0) or off in seen:
                continue
            seen.add(off)
            ray.append((off[0], off[1], float(np.hypot(*(jac @ np.array([off[1], off[0]]))))))
        out.append(ray)
    return out


def sky_view(z: np.ndarray, halo: int, rays) -> np.ndarray:
    """Sky-view factor de las filas internas de `z` (Zakšek et al. 2011, SVF = 1 − Σ sin γ / n).

    z: (n + 2·halo, ancho) alturas, −inf o NaN donde no hay dato; `halo` filas de contexto
    arriba y abajo (≥ el desplazamiento máximo en filas de `rays`).
    Devuelve (n, ancho) float32 con NaN donde el píxel no tiene dato o alguno de sus rayos
    pasa por un hueco o sale del DTM antes del radio: sin horizonte completo no hay número.
    """
    n, w = z.shape[0] - 2 * halo, z.shape[1]
    cpad = max(abs(dc) for ray in rays for _, dc, _ in ray)
    zp = np.full((z.shape[0], w + 2 * cpad), np.nan, dtype=np.float32)
    zp[:, cpad:cpad + w] = np.where(np.isfinite(z), z, np.nan)
    z0 = zp[halo:halo + n, cpad:cpad + w]
    complete = np.isfinite(z0)
    sin_sum = np.zeros((n, w), dtype=np.float32)
    for ray in rays:
        best = np.zeros((n, w), dtype=np.float32)    # tan del horizonte, con piso en 0 (horizontal)
        for dr, dc, d in ray:
            zn = zp[halo + dr:halo + dr + n, cpad + dc:cpad + dc + w]
            complete &= np.isfinite(zn)
            np.fmax(best, (zn - z0) / d, out=best)
        sin_sum += best / np.sqrt(1 + best * best)    # sin(atan(t))
    svf = 1.0 - sin_sum / len(rays)
    svf[~complete] = np.nan
    return svf


# ------------------------------------------------------------------ refugios

def shelter_mask(svf: np.ndarray, slope: np.ndarray, svf_max: float, max_slope_deg: float,
                 min_px: int) -> np.ndarray:
    """True donde hay poco cielo, se puede estar parado (pendiente < `max_slope_deg`) y la mancha
    es de al menos `min_px`."""
    # En float32, como el COG: los tiles (tiles.f32) usan el mismo corte. NaN da False en las dos.
    cand = (svf <= np.float32(svf_max)) & (slope < np.float32(max_slope_deg))
    labels, n = ndimage.label(cand, structure=np.ones((3, 3), bool))
    if n == 0:
        return cand
    sizes = np.bincount(labels.ravel())
    keep = sizes >= min_px
    keep[0] = False
    return keep[labels]


# ------------------------------------------------------------------ minutos al refugio

def tobler_speed(tan_slope, flat_speed_m_s: float = WALK_SPEED_M_S):
    """Velocidad (m/s) de Tobler (1993), 6·e^(−3,5·|s + 0,05|) km/h, escalada para que en
    plano dé `flat_speed_m_s`. s > 0 es subida."""
    tobler = lambda s: np.exp(-3.5 * np.abs(s + 0.05))  # noqa: E731
    return flat_speed_m_s * tobler(np.asarray(tan_slope, dtype=np.float64)) / tobler(0.0)


def walk_cost(slope_deg: np.ndarray, max_slope_deg: float, flat_speed_m_s: float = WALK_SPEED_M_S,
              peak_deg: np.ndarray | None = None):
    """Segundos por metro horizontal de cada celda. inf donde no se puede pasar.

    `slope_deg` (la media de la celda) da la velocidad; `peak_deg` (la pendiente que no se
    puede esquivar, ver slope_blocks; default: la misma) decide si se pasa: desde
    `max_slope_deg` inclusive, no, igual que api/planner.py. La pendiente no es la del rumbo
    y no se sabe si se sube o se baja: se usa el promedio de subir y bajar, que es simétrico.
    """
    peak = slope_deg if peak_deg is None else peak_deg
    rad = np.radians(np.where(np.isfinite(slope_deg), slope_deg, 0.0))
    s = np.tan(rad)
    pace = 0.5 * (1 / tobler_speed(s, flat_speed_m_s) + 1 / tobler_speed(-s, flat_speed_m_s))
    cost = pace / np.cos(rad)                     # distancia sobre el terreno, no la horizontal
    with np.errstate(invalid="ignore"):
        cost[~np.isfinite(slope_deg) | ~np.isfinite(peak) | (peak >= max_slope_deg)] = np.inf
    return cost


def minutes_to_shelter(cost: np.ndarray, targets, pixel_m: tuple[float, float]) -> list[np.ndarray]:
    """Por cada máscara de `targets`, minutos desde cada celda hasta la celda de esa máscara más
    cercana en tiempo. NaN si no se llega (celda bloqueada o rodeada de celdas bloqueadas).
    pixel_m = (este, norte).

    El grafo se arma una sola vez para todas las máscaras: en Gale son ~19 M de celdas.
    """
    from skimage.graph import MCP_Geometric

    mcp = None
    outs = []
    for target in targets:
        out = np.full(cost.shape, np.nan, dtype=np.float32)
        outs.append(out)
        starts = np.argwhere(target & np.isfinite(cost))
        if len(starts) == 0:
            continue
        if mcp is None:
            mcp = MCP_Geometric(cost, sampling=(pixel_m[1], pixel_m[0]))
        # find_costs devuelve su arreglo interno, que la próxima llamada pisa: se copia a `out` ya.
        seconds, _ = mcp.find_costs([tuple(p) for p in starts])
        ok = np.isfinite(seconds)
        out[ok] = seconds[ok] / 60.0
    return outs


def shelter_mask_strips(svf, slope, out, svf_max: float, max_slope_deg: float, min_px: int,
                        strip_rows: int) -> None:
    """shelter_mask() por franjas sobre arreglos en disco, con el mismo resultado que de una vez.

    Cada franja se mira con `min_px` filas de más arriba y abajo: una mancha que toca la franja
    y sigue afuera de esa ventana ya tiene más de `min_px` filas adentro, así que el tamaño
    "local" alcanza el mínimo si y solo si el tamaño real lo alcanza.
    """
    rows = svf.shape[0]
    for r0 in range(0, rows, strip_rows):
        r1 = min(rows, r0 + strip_rows)
        q0, q1 = max(0, r0 - min_px), min(rows, r1 + min_px)
        m = shelter_mask(np.asarray(svf[q0:q1]), np.asarray(slope[q0:q1]), svf_max, max_slope_deg, min_px)
        out[r0:r1] = m[r0 - q0:r1 - q0]


def block_reduce(a, k: int, fn) -> np.ndarray:
    """Reduce bloques k × k de `a` (recorta el sobrante del borde) con `fn` sobre los ejes (1, 3)."""
    rows, cols = a.shape[0] // k, a.shape[1] // k
    out = None
    step = max(1, STRIP_PX // max(1, a.shape[1]) // k)
    for r0 in range(0, rows, step):
        r1 = min(rows, r0 + step)
        b = np.asarray(a[r0 * k:r1 * k, :cols * k]).reshape(r1 - r0, k, cols, k)
        red = fn(b, axis=(1, 3))
        if out is None:
            out = np.empty((rows, cols), dtype=red.dtype)
        out[r0:r1] = red
    return out


def slope_blocks(slope, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Media y pendiente "que no se esquiva" de cada bloque k × k de `slope` (°, NaN = sin dato),
    con el criterio de api/planner.py (Grid.peak): la k-ésima más alta del bloque, porque
    cruzarlo pisa al menos k píxeles. Una franja empinada que lo atraviesa no se diluye en el
    promedio y un píxel ruidoso suelto no lo bloquea. Bloques incompletos: el máximo
    (conservador). Sin ningún dato: NaN en los dos.
    """
    rows, cols, n = slope.shape[0] // k, slope.shape[1] // k, k * k
    mean = np.full((rows, cols), np.nan, dtype=np.float32)
    peak = np.full((rows, cols), np.nan, dtype=np.float32)
    step = max(1, STRIP_PX // max(1, slope.shape[1]) // k)
    for r0 in range(0, rows, step):
        r1 = min(rows, r0 + step)
        b = np.asarray(slope[r0 * k:r1 * k, :cols * k], dtype=np.float32)
        cells = b.reshape(r1 - r0, k, cols, k).transpose(0, 2, 1, 3).reshape(r1 - r0, cols, n)
        valid = np.isfinite(cells)
        count = valid.sum(axis=2)
        tops = np.where(valid, cells, -np.inf)
        with np.errstate(invalid="ignore", divide="ignore"):
            mean[r0:r1] = np.where(count > 0, np.where(valid, cells, 0).sum(axis=2) / count, np.nan)
        unavoid = np.partition(tops, n - k, axis=2)[..., n - k]
        peak[r0:r1] = np.where(count >= n, unavoid, np.where(count > 0, tops.max(axis=2), np.nan))
    return mean, peak


def coarse_grid(grid, k: int):
    """La grilla de trabajo agrandada k veces: lo que necesitan new_gtiff y el costo."""
    return SimpleNamespace(rows=grid.rows // k, cols=grid.cols // k, crs=grid.crs,
                           transform=grid.transform @ Affine.scale(k), jac=grid.jac * k,
                           pixel_m=(grid.pixel_m[0] * k, grid.pixel_m[1] * k))


# ------------------------------------------------------------------ entradas y salidas

def resolve_dtm(args):
    """(ruta del DTM, carpeta de salida del sitio, sitio, entrada de sites/<id>.json o None)."""
    if args.dtm:
        dtm = Path(args.dtm)
        if not dtm.exists():
            raise DataNotReady(f"No existe el DTM {dtm}")
        out = Path(args.out) if args.out else DATA_DIR / "output" / dtm.stem
        return str(dtm), out, args.site or dtm.stem, None
    try:
        site = pc.load_site(args.site)
        src = pc.find_input(site, "dtm")
        pc.raster_size(src)
    except pc.DataNotReady as e:
        raise DataNotReady(str(e)) from e
    out = Path(args.out) if args.out else DATA_DIR / "output" / site["id"]
    return src, out, site["id"], next(f for f in site["files"] if f["key"] == "dtm")


def write_cog(path: Path, grid, work: Path, dtype: str, nodata, strips) -> None:
    """Escribe un COG a partir de `strips`, que devuelve (fila inicial, bloque) de a franjas.
    Se arma en `work` y se mueve de un paso: nginx nunca sirve un archivo a medias."""
    tmp = work / f"{path.stem}_raw.tif"
    with il.new_gtiff(tmp, grid, 1, dtype, nodata) as ds:
        for r0, block in strips:
            ds.write(block.astype(dtype), 1, window=Window(0, r0, grid.cols, block.shape[0]))
    il.to_cog(tmp, work / path.name)
    os.replace(work / path.name, path)


def by_strips(rows: int, cols: int, fn):
    step = max(1, STRIP_PX // max(1, cols))
    for r0 in range(0, rows, step):
        r1 = min(rows, r0 + step)
        yield r0, fn(r0, r1)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", help="id del sitio (nombre del JSON en sites/)")
    p.add_argument("--dtm", help="DTM arbitrario (en lugar de --site)")
    p.add_argument("--out", help="carpeta del sitio (default: DATA_DIR/output/<sitio>)")
    p.add_argument("--res", type=int, default=RES, help="promediar el DTM N×N para sky-view y refugios")
    p.add_argument("--walk-res", type=int, default=WALK_RES, help="grilla de los minutos (múltiplo de --res)")
    p.add_argument("--radius-m", type=float, default=RADIUS_M, help="alcance del horizonte local")
    p.add_argument("--directions", type=int, default=DIRECTIONS, help="azimuts del sky-view")
    p.add_argument("--svf-max", type=float, default=SVF_MAX, help="umbral de cielo visible para refugio")
    p.add_argument("--svf-strong", type=float, default=SVF_STRONG, help="umbral para refugio fuerte")
    p.add_argument("--max-slope", type=float, default=MAX_SLOPE_DEG, help="pendiente máxima transitable (°)")
    p.add_argument("--min-area-m2", type=float, default=MIN_AREA_M2, help="área mínima de un refugio")
    p.add_argument("--no-tiles", action="store_true", help="no generar los tiles PNG del mapa")
    args = p.parse_args(argv)
    if not (args.site or args.dtm):
        p.error("hace falta --site o --dtm")
    if args.walk_res % args.res:
        p.error("--walk-res tiene que ser múltiplo de --res")
    if args.svf_strong > args.svf_max:
        p.error("--svf-strong no puede ser mayor que --svf-max")

    t0 = time.time()
    try:
        src, out, site_id, entry = resolve_dtm(args)
    except DataNotReady as e:
        log(f"DATOS NO LISTOS: {e}")
        return 2
    mission = (entry or {}).get("mission")
    work = out / ".shelter-run.work"   # no ".shelter.work": ese lo usa tiles.py para shelter/
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    try:
        log(f"DTM {src} (promedio {args.res}×{args.res})")
        try:
            grid = il.WorkGrid(Path(src), args.res, work)
        except il.DataNotReady as e:
            raise DataNotReady(str(e)) from e
        px_e, px_n = grid.pixel_m
        log(f"grilla {grid.rows}×{grid.cols}, píxel {px_e:.2f}×{px_n:.2f} m")

        # 1. Sky-view y pendiente por franjas, a disco. Con las alturas del DTM y no las del plano
        # tangente del centro: ese plano inclina el terreno ~r/R lejos del centro (0,56° en las
        # esquinas de Gale), y en 500 m la curvatura baja el horizonte apenas 4 cm.
        rays = ray_offsets(grid.jac, args.directions, args.radius_m)
        halo = max(1, max(abs(dr) for ray in rays for dr, _, _ in ray))
        jinv = np.broadcast_to(np.linalg.inv(grid.jac), (grid.rows, 2, 2))
        shape = (grid.rows, grid.cols)
        svf = np.lib.format.open_memmap(work / "svf.npy", mode="w+", dtype=np.float32, shape=shape)
        slope = np.lib.format.open_memmap(work / "slope.npy", mode="w+", dtype=np.float32, shape=shape)
        strip_rows = max(16, STRIP_PX // grid.cols)
        for r0 in range(0, grid.rows, strip_rows):
            r1 = min(grid.rows, r0 + strip_rows)
            q0, q1 = r0 - halo, r1 + halo
            z = np.full((q1 - q0, grid.cols), np.nan, dtype=np.float32)
            z[max(0, q0) - q0:min(grid.rows, q1) - q0] = grid.raw(max(0, q0), min(grid.rows, q1), 0, grid.cols)
            svf[r0:r1] = sky_view(z, halo, rays)
            ctx = z[halo - 1:halo + (r1 - r0) + 1]
            slope[r0:r1] = pc.slope_strip(ctx, np.isfinite(ctx), jinv[r0:r1])
            log(f"sky-view filas {r1}/{grid.rows}")

        # 2. Refugios en la grilla fina.
        min_px = max(1, math.ceil(args.min_area_m2 / (px_e * px_n)))
        shelter = np.lib.format.open_memmap(work / "shelter.npy", mode="w+", dtype=bool, shape=shape)
        shelter_mask_strips(svf, slope, shelter, args.svf_max, args.max_slope, min_px, strip_rows)
        # Fuerte: mismo criterio con menos cielo. Es un subconjunto de `shelter` (sus manchas
        # caen dentro de manchas de refugio, que son al menos igual de grandes).
        strong = np.lib.format.open_memmap(work / "strong.npy", mode="w+", dtype=bool, shape=shape)
        shelter_mask_strips(svf, slope, strong, args.svf_strong, args.max_slope, min_px, strip_rows)
        n_data = n_shelter = n_strong = 0
        for r0, (d, s, f) in by_strips(*shape, lambda a, b: (
                int((np.isfinite(svf[a:b]) & np.isfinite(slope[a:b])).sum()), int(shelter[a:b].sum()),
                int(strong[a:b].sum()))):
            n_data += d
            n_shelter += s
            n_strong += f
        fraction, fraction_strong = n_shelter / max(1, n_data), n_strong / max(1, n_data)
        log(f"refugio: {n_shelter} celdas de {px_e * px_n:.1f} m² ({fraction:.2%} de las celdas con dato), "
            f"fuerte: {n_strong} ({fraction_strong:.2%})")

        # 3. Minutos en la grilla gruesa: refugio si alguna celda fina del bloque lo es. La
        # pendiente sale de la fina (no de un DTM promediado, que aplana una franja empinada de
        # pocos metros): la media da la velocidad y la k-ésima más alta decide si se pasa.
        k = args.walk_res // args.res
        walk = coarse_grid(grid, k)
        mean_slope, peak_slope = slope_blocks(slope, k)
        cost = walk_cost(mean_slope, args.max_slope, peak_deg=peak_slope)
        del mean_slope, peak_slope
        minutes, minutes_strong = minutes_to_shelter(
            cost, [block_reduce(shelter, k, np.any), block_reduce(strong, k, np.any)], walk.pixel_m)
        del cost
        log(f"minutos al refugio listos (grilla {walk.rows}×{walk.cols})")

        # 4. COG.
        write_cog(out / "shelter_skyview.tif", grid, work, "float32", F32_NODATA, by_strips(*shape, lambda a, b: (
            np.where(np.isfinite(svf[a:b]), svf[a:b], F32_NODATA))))
        write_cog(out / "shelter.tif", grid, work, "uint8", U8_NODATA, by_strips(*shape, lambda a, b: (
            np.where(np.isfinite(svf[a:b]) & np.isfinite(slope[a:b]),
                     shelter[a:b].astype(np.uint8) + strong[a:b].astype(np.uint8), U8_NODATA))))
        for name, m in (("shelter_minutes.tif", minutes), ("shelter_strong_minutes.tif", minutes_strong)):
            write_cog(out / name, walk, work, "float32", F32_NODATA, [(0, np.where(np.isfinite(m), m, F32_NODATA))])

        fine_res = f"derivada, {px_e:.1f} × {px_n:.1f} m/px"
        common = {"status": "ok", "mission": mission,
                  "instrument": "HiRISE DTM" if mission == "MRO HiRISE" else None}

        def minutes_layer(fname, m, target):
            reach = m[np.isfinite(m)]
            return {
                **common, "file": fname, "unit": "min", "provenance": "MODELED",
                "resolution": f"modelada, {walk.pixel_m[0]:.0f} × {walk.pixel_m[1]:.0f} m/px",
                "nodata": F32_NODATA,
                "method": f"Costo acumulado (scikit-image MCP_Geometric, 8 vecinos) desde {target}.",
                "params": {"flat_speed_m_s": WALK_SPEED_M_S, "max_slope_deg": args.max_slope,
                           "walk_res": args.walk_res},
                "assumptions": [
                    f"Velocidad de Tobler (1993) escalada a {WALK_SPEED_M_S} m/s en plano.",
                    "Velocidad con la pendiente media de la celda, promediando subir y bajar.",
                    f"Una celda no se pisa si cruzarla obliga a pisar {args.max_slope:.0f}° o más "
                    f"(la {k}.ª pendiente más alta de sus {k * k} celdas de {args.res} m, como el planificador).",
                    f"Camino calculado a {walk.pixel_m[0]:.0f} m: un refugio de pocos metros cuenta "
                    "desde el borde de su celda."],
                "median_min": round(float(np.median(reach)), 1) if reach.size else None,
                "p90_min": round(float(np.percentile(reach, 90)), 1) if reach.size else None,
            }

        layers = {
            "survival-shelter-skyview": {
                **common, "file": "shelter_skyview.tif", "unit": "fracción", "provenance": "DERIVED",
                "resolution": fine_res, "nodata": F32_NODATA,
                "method": f"SVF = 1 − Σ sin γ / n (Zakšek et al. 2011), {args.directions} azimuts, "
                          f"horizonte hasta {args.radius_m:.0f} m.",
                "assumptions": [
                    f"Solo cuenta el terreno a menos de {args.radius_m:.0f} m.",
                    f"Sin dato a menos de {args.radius_m:.0f} m del borde del DTM y de sus huecos.",
                    "Sobre el plano horizontal: no corrige por la inclinación del propio píxel."],
            },
            "survival-shelter": {
                **common, "file": "shelter.tif", "unit": None, "provenance": "DERIVED",
                "resolution": fine_res, "nodata": U8_NODATA,
                "params": {"svf_max": args.svf_max, "svf_strong": args.svf_strong, "max_slope_deg": args.max_slope,
                           "min_area_m2": args.min_area_m2, "min_px": min_px},
                "values": {"0": "no", "1": "refugio", "2": "refugio fuerte"},
                "assumptions": [f"Refugio = cielo visible ≤ {args.svf_max:.0%}; fuerte = ≤ {args.svf_strong:.0%}.",
                                f"Pendiente < {args.max_slope:.0f}° y mancha de al menos "
                                f"{min_px * px_e * px_n:.0f} m² (dos o tres personas).",
                                "Poco cielo es reparo geométrico, no una dosis calculada."],
                "fraction": round(fraction, 5),   # sobre las celdas con dato
                "fraction_strong": round(fraction_strong, 5),
            },
            "survival-shelter-minutes": minutes_layer("shelter_minutes.tif", minutes, "los refugios"),
            "survival-shelter-strong-minutes": minutes_layer("shelter_strong_minutes.tif", minutes_strong,
                                                             "los refugios fuertes"),
        }
        del svf, slope, shelter, strong, minutes, minutes_strong

        # 5. Tiles para el mapa. Si fallan, los COG quedan y el índice lo dice.
        failed = False
        missing = tiles.faltan_herramientas()
        for layer_id, (fname, folder, ramp, warp) in LAYER_FILES.items():
            if args.no_tiles:
                continue
            if missing:
                layers[layer_id]["tiles"] = {"status": "error", "error": "Faltan herramientas de GDAL: " + ", ".join(missing)}
                failed = True
                continue
            try:
                info = tiles.raster_a_tiles(out / fname, out / folder, color=ramp, warp=warp)
                layers[layer_id]["tiles"] = {"status": "ok", **info}
            except Exception as e:  # seguir con la próxima capa
                failed = True
                log(f"Falló el teselado de {layer_id}: {e}")
                layers[layer_id]["tiles"] = {"status": "error", "error": str(e)[:400]}

        index = {
            "site": site_id,
            "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "mode": "completo",
            "source": {"key": "dtm", "desc": (entry or {}).get("desc"), "mission": mission, "read_from": src},
            "grid": {"shape": [grid.rows, grid.cols], "pixel_ground_m": [round(px_e, 3), round(px_n, 3)],
                     "res": args.res, "walk_shape": [walk.rows, walk.cols], "walk_res": args.walk_res},
            "layers": layers,
            "warnings": [],
        }
        (work / "shelter.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
        os.replace(work / "shelter.json", out / "shelter.json")
    except DataNotReady as e:
        log(f"DATOS NO LISTOS: {e}")
        return 2
    except Exception as e:  # sin shelter.json nuevo: no queda una capa a medias publicada como ok
        log(f"FALLÓ: {e}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
    log(f"Listo en {(time.time() - t0) / 60:.1f} min: {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
