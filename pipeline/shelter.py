#!/usr/bin/env python3
"""Refugios: "¿dónde me cubro y a cuántos minutos?".

A partir del DTM del sitio genera, en <out>/<sitio>/shelter/:

    skyview.tif           fracción de cielo visible (sky-view factor, 0–1), COG float32
    shelter.tif           1 refugio, 0 no, 255 sin dato; COG uint8
    shelter_minutes.tif   minutos caminando hasta el refugio más cercano, COG float32
    index.json            procedencia, parámetros, supuestos y estado de cada capa

Refugio = poco cielo visible (pie de escarpes, paredes de cráter) en un lugar donde se puede
estar parado. Menos cielo visible es menos radiación de fondo y más reparo; el número es
geométrico, no una dosis.

    python pipeline/shelter.py --site jezero
    python pipeline/shelter.py --dtm /ruta/dtm.tif --out /data/output/otro

El cálculo se hace sobre el DTM promediado `--res` × `--res` (10 m por defecto, para que entre
en la memoria del server). Método y límites: docs/refugios.md.

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

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import illumination as il  # noqa: E402
import precompute as pc  # noqa: E402
import terrain_shadows as ts  # noqa: E402

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

# Parámetros por defecto (supuestos propios: ver docs/refugios.md)
RES = 10                   # promediar el DTM de 1 m en bloques de 10 × 10
RADIUS_M = 500.0           # hasta dónde se mira el horizonte local
DIRECTIONS = 16            # azimuts para el sky-view factor
DIST_RATIO = 1.15          # las distancias de muestreo crecen en progresión geométrica
SVF_MAX = 0.85             # refugio si se ve como mucho el 85 % del cielo
MAX_SLOPE_DEG = 30.0       # igual que "no transitable" en la leyenda de survival-slope (web)
MIN_AREA_M2 = 1000.0       # refugios más chicos que esto no cuentan
WALK_SPEED_M_S = 0.8       # en plano; el mismo default que /api/route/consumables
STRIP = 1024               # filas por franja al calcular el sky-view

F32_NODATA = -9999.0
U8_NODATA = 255


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
    """True donde hay poco cielo, se puede estar parado y la mancha es de al menos `min_px`."""
    cand = (svf <= svf_max) & (slope <= max_slope_deg)          # NaN da False en las dos
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


def walk_cost(slope_deg: np.ndarray, max_slope_deg: float, flat_speed_m_s: float = WALK_SPEED_M_S):
    """Segundos por metro horizontal de cada celda. inf donde no se puede pasar.

    La pendiente de la celda es la máxima (no la del rumbo) y no se sabe si se sube o se
    baja: se usa el promedio de subir y bajar, que es simétrico y conservador.
    """
    rad = np.radians(np.where(np.isfinite(slope_deg), slope_deg, 0.0))
    s = np.tan(rad)
    pace = 0.5 * (1 / tobler_speed(s, flat_speed_m_s) + 1 / tobler_speed(-s, flat_speed_m_s))
    cost = pace / np.cos(rad)                     # distancia sobre el terreno, no la horizontal
    cost[~np.isfinite(slope_deg) | (slope_deg > max_slope_deg)] = np.inf
    return cost


def minutes_to_shelter(cost: np.ndarray, shelter: np.ndarray, pixel_m: tuple[float, float]) -> np.ndarray:
    """Minutos desde cada celda hasta la celda de refugio más cercana en tiempo. NaN si no se
    llega (celda bloqueada o rodeada de celdas bloqueadas). pixel_m = (este, norte)."""
    from skimage.graph import MCP_Geometric

    out = np.full(cost.shape, np.nan, dtype=np.float32)
    starts = np.argwhere(shelter & np.isfinite(cost))
    if len(starts) == 0:
        return out
    mcp = MCP_Geometric(cost, sampling=(pixel_m[1], pixel_m[0]))
    seconds, _ = mcp.find_costs([tuple(p) for p in starts])
    ok = np.isfinite(seconds)
    out[ok] = seconds[ok] / 60.0
    return out


# ------------------------------------------------------------------ entradas y salidas

def resolve_dtm(args):
    """(ruta del DTM, carpeta de salida, sitio, entrada de sites/<id>.json o None)."""
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


def write_cog(path: Path, grid, arr: np.ndarray, dtype: str, nodata, work: Path) -> None:
    tmp = work / f"{path.stem}_raw.tif"
    with il.new_gtiff(tmp, grid, 1, dtype, nodata) as ds:
        ds.write(arr.astype(dtype), 1)
    il.to_cog(tmp, work / path.name)
    os.replace(work / path.name, path)     # nginx nunca sirve un archivo a medias


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", help="id del sitio (nombre del JSON en sites/)")
    p.add_argument("--dtm", help="DTM arbitrario (en lugar de --site)")
    p.add_argument("--out", help="carpeta base del sitio (default: DATA_DIR/output/<sitio>)")
    p.add_argument("--res", type=int, default=RES, help="promediar el DTM N×N antes de calcular")
    p.add_argument("--radius-m", type=float, default=RADIUS_M, help="alcance del horizonte local")
    p.add_argument("--directions", type=int, default=DIRECTIONS, help="azimuts del sky-view")
    p.add_argument("--svf-max", type=float, default=SVF_MAX, help="umbral de cielo visible para refugio")
    p.add_argument("--max-slope", type=float, default=MAX_SLOPE_DEG, help="pendiente máxima transitable (°)")
    p.add_argument("--min-area-m2", type=float, default=MIN_AREA_M2, help="área mínima de un refugio")
    args = p.parse_args(argv)
    if not (args.site or args.dtm):
        p.error("hace falta --site o --dtm")

    t0 = time.time()
    try:
        src, base, site_id, entry = resolve_dtm(args)
    except DataNotReady as e:
        log(f"DATOS NO LISTOS: {e}")
        return 2
    mission = (entry or {}).get("mission")
    out = base / "shelter"
    work = out / "_work"
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
        resolution = f"derivada, {px_e:.1f} × {px_n:.1f} m/px"

        rays = ray_offsets(grid.jac, args.directions, args.radius_m)
        halo = max(1, max(abs(dr) for ray in rays for dr, _, _ in ray))
        jinv = np.broadcast_to(np.linalg.inv(grid.jac), (grid.rows, 2, 2))
        svf = np.empty((grid.rows, grid.cols), dtype=np.float32)
        slope = np.empty((grid.rows, grid.cols), dtype=np.float32)
        for r0 in range(0, grid.rows, STRIP):
            r1 = min(grid.rows, r0 + STRIP)
            q0, q1 = r0 - halo, r1 + halo
            z = np.full((q1 - q0, grid.cols), -np.inf, dtype=np.float32)
            z[max(0, q0) - q0:min(grid.rows, q1) - q0] = grid.tangent(max(0, q0), min(grid.rows, q1), 0, grid.cols)
            svf[r0:r1] = sky_view(z, halo, rays)
            ctx = z[halo - 1:halo + (r1 - r0) + 1]
            slope[r0:r1] = pc.slope_strip(ctx, np.isfinite(ctx), jinv[r0:r1])
            log(f"sky-view filas {r1}/{grid.rows}")

        min_px = max(1, math.ceil(args.min_area_m2 / (px_e * px_n)))
        shelter = shelter_mask(svf, slope, args.svf_max, args.max_slope, min_px)
        has_data = np.isfinite(svf) & np.isfinite(slope)
        fraction = float(shelter.sum() / max(1, has_data.sum()))
        log(f"refugio: {shelter.sum()} celdas ({fraction:.1%} de las celdas con dato)")
        minutes = minutes_to_shelter(walk_cost(slope, args.max_slope), shelter, grid.pixel_m)
        log("minutos al refugio listos")

        has_svf = np.isfinite(svf)
        shelter_u8 = np.where(has_data, shelter.astype(np.uint8), U8_NODATA)
        write_cog(out / "skyview.tif", grid, np.where(has_svf, svf, F32_NODATA), "float32", F32_NODATA, work)
        write_cog(out / "shelter.tif", grid, shelter_u8, "uint8", U8_NODATA, work)
        write_cog(out / "shelter_minutes.tif", grid, np.where(np.isfinite(minutes), minutes, F32_NODATA),
                  "float32", F32_NODATA, work)

        reach = minutes[np.isfinite(minutes)]
        common = {"mission": mission, "instrument": "HiRISE" if mission == "MRO HiRISE" else None,
                  "resolution": resolution}
        index = {
            "site": site_id,
            "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": {"key": "dtm", "desc": (entry or {}).get("desc"), "mission": mission, "read_from": src},
            "grid": {"shape": [grid.rows, grid.cols], "pixel_ground_m": [round(px_e, 3), round(px_n, 3)],
                     "res": args.res},
            "layers": {
                "survival-skyview": {
                    "file": "skyview.tif", "status": "ok", "unit": "fracción", "provenance": "DERIVED",
                    "nodata": F32_NODATA, **common,
                    "method": f"SVF = 1 − Σ sin γ / n (Zakšek et al. 2011), {args.directions} azimuts, "
                              f"horizonte hasta {args.radius_m:.0f} m.",
                    "assumptions": [
                        f"Solo cuenta el terreno a menos de {args.radius_m:.0f} m.",
                        f"Sin dato a menos de {args.radius_m:.0f} m del borde del DTM y de sus huecos.",
                        "Sobre el plano horizontal: no corrige por la inclinación del propio píxel."],
                },
                "survival-shelter": {
                    "file": "shelter.tif", "status": "ok", "unit": None, "provenance": "DERIVED",
                    "nodata": U8_NODATA, **common,
                    "params": {"svf_max": args.svf_max, "max_slope_deg": args.max_slope,
                               "min_area_m2": args.min_area_m2},
                    "assumptions": [f"Refugio = cielo visible ≤ {args.svf_max:.0%}, pendiente ≤ "
                                    f"{args.max_slope:.0f}° y mancha de al menos {args.min_area_m2:.0f} m².",
                                    "Poco cielo es reparo geométrico, no una dosis calculada."],
                    "fraction": round(fraction, 4),   # sobre las celdas con dato
                },
                "survival-shelter-minutes": {
                    "file": "shelter_minutes.tif", "status": "ok", "unit": "min", "provenance": "MODELED",
                    "nodata": F32_NODATA, **common,
                    "method": "Costo acumulado (scikit-image MCP_Geometric, 8 vecinos) desde los refugios.",
                    "params": {"flat_speed_m_s": WALK_SPEED_M_S, "max_slope_deg": args.max_slope},
                    "assumptions": [
                        f"Velocidad de Tobler (1993) escalada a {WALK_SPEED_M_S} m/s en plano.",
                        "Pendiente máxima de la celda, promediando subir y bajar (conservador).",
                        f"Celdas con más de {args.max_slope:.0f}° no se pisan.",
                        f"Terreno a {px_e:.0f} m: no ve rocas ni escalones más chicos."],
                    "median_min": round(float(np.median(reach)), 1) if reach.size else None,
                    "p90_min": round(float(np.percentile(reach, 90)), 1) if reach.size else None,
                },
            },
        }
        (out / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    except DataNotReady as e:
        log(f"DATOS NO LISTOS: {e}")
        return 2
    except Exception as e:  # el index.json no se escribe: no queda una capa a medias publicada como ok
        log(f"FALLÓ: {e}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
    log(f"Listo en {(time.time() - t0) / 60:.1f} min: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
