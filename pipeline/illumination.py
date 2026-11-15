"""Pila de máscaras de sol/sombra por hora y amanecer/atardecer con terreno, por sol.

Funciona con cualquier DTM (cualquier CRS y tamaño de píxel). Para un sitio del repo toma
el DTM y el DEM 200 m del manifest; para otro DTM se pasan las rutas a mano.

    python pipeline/illumination.py --site jezero --start 2026-11-15T00:00:00
    python pipeline/illumination.py --dtm /ruta/dtm.tif --far-dem /ruta/dem.tif --out /data/output/otro

Salida, una carpeta por sol en <out>/illumination/<medianoche local en UTC>/:

    shadow_hourly.tif  COG uint8, una banda por hora LTST: 1 sol, 0 sombra, 255 sin dato
    sun_times.tif      COG uint16: banda 1 amanecer, banda 2 atardecer, en minutos LTST
    index.json         hora UTC/LTST, Sol (azimut, elevación) y fracción iluminada por banda

Detalle del método y límites: docs/illumination.md.
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
import rasterio
import rasterio.shutil
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window, from_bounds
from scipy.ndimage import map_coordinates

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sun_geometry as sg  # noqa: E402
import terrain_shadows as ts  # noqa: E402

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MARS_LONGLAT = "+proj=longlat +R=3396190 +no_defs"
KERNEL_PATTERNS = ("naif*.tls", "pck*.tpc", "de4*.bsp", "mar*.bsp")
NODATA_U8, NODATA_U16, NO_SUN_U16 = 255, 65535, 65534
STRIP = 512


class DataNotReady(Exception):
    """Faltan datos de entrada (la descarga todavía no terminó o la ruta está mal)."""


def log(msg: str) -> None:
    print(f"[{dt.datetime.now(dt.timezone.utc):%H:%M:%S}] {msg}", flush=True)


# ------------------------------------------------------------------ entradas

def resolve_inputs(args) -> dict:
    """Rutas de DTM, DEM lejano, kernels y salida. Lanza DataNotReady si falta algo esencial."""
    kernels_dir = Path(args.kernels) if args.kernels else DATA_DIR / "raw" / "common"
    kernels = []
    for pat in KERNEL_PATTERNS:
        found = sorted(kernels_dir.glob(pat))
        if not found:
            raise DataNotReady(f"Falta el kernel SPICE {pat} en {kernels_dir}")
        kernels.append(found[-1])

    if args.dtm:
        dtm, far = Path(args.dtm), Path(args.far_dem) if args.far_dem else None
        out = Path(args.out) if args.out else DATA_DIR / "output" / dtm.stem
        site = args.site or dtm.stem
    else:
        manifest = DATA_DIR / "manifest.json"
        if not manifest.exists():
            raise DataNotReady(f"No existe {manifest}: la descarga todavía no terminó")
        m = json.loads(manifest.read_text())
        if args.site not in m.get("sites", {}):
            raise DataNotReady(f"El sitio {args.site} no está en el manifest")
        files = {f["key"]: f for f in m["sites"][args.site]["files"]}
        if files.get("dtm", {}).get("status") != "ok":
            raise DataNotReady(f"El DTM de {args.site} todavía no está descargado")
        dtm = DATA_DIR / files["dtm"]["path"]
        far = DATA_DIR / files["dem200_crop"]["path"] if files.get("dem200_crop", {}).get("status") == "ok" else None
        out = Path(args.out) if args.out else DATA_DIR / "output" / args.site
        site = args.site
    if not dtm.exists():
        raise DataNotReady(f"No existe el DTM {dtm}")
    if far is not None and not far.exists():
        far = None
    return {"site": site, "dtm": dtm, "far": far, "kernels": kernels, "out": out}


# ------------------------------------------------------------------ grilla de trabajo

class WorkGrid:
    """El DTM (opcionalmente promediado `res` × `res`) en un memmap float32, ya pasado al
    plano tangente en el centro (z − r²/2R) y con −inf donde no hay dato. Así cada pasada
    del Sol lee alturas listas, sin recalcular la curvatura."""

    def __init__(self, dtm_path: Path, res: int, work_dir: Path):
        with rasterio.open(dtm_path) as ds:
            self.rows, self.cols = ds.height // res, ds.width // res
            self.transform = ds.transform @ Affine.scale(res)
            self.crs = ds.crs
            self.center = (self.rows / 2.0, self.cols / 2.0)
            self.jac = ts.ground_jacobian(self.pix_to_lonlat, self.center[1], self.center[0])
            self.z = np.lib.format.open_memmap(work_dir / "z.npy", mode="w+", dtype=np.float32,
                                               shape=(self.rows, self.cols))
            for r0 in range(0, self.rows, STRIP):
                nr = min(STRIP, self.rows - r0)
                win = Window(0, r0 * res, self.cols * res, nr * res)
                band = ds.read(1, window=win, out_shape=(nr, self.cols), masked=True,
                               resampling=Resampling.average if res > 1 else Resampling.nearest)
                block = band.astype(np.float32).filled(np.nan)
                bad = ~np.isfinite(block) | (np.abs(block) > 1e5)
                block -= self._drop(r0, r0 + nr, 0, self.cols)
                block[bad] = -np.inf
                self.z[r0:r0 + nr] = block
            self.z.flush()
        self.pixel_m = (float(np.hypot(*self.jac[:, 0])), float(np.hypot(*self.jac[:, 1])))
        lon, lat = self.pix_to_lonlat(np.array([self.center[1]]), np.array([self.center[0]]))
        self.center_lon, self.center_lat = float(lon[0]), float(lat[0])
        sr, sc = max(1, self.rows // 200), max(1, self.cols // 200)
        sample = self.raw(0, self.rows, 0, self.cols, step=(sr, sc))
        if not np.isfinite(sample).any():
            raise DataNotReady(f"El DTM {dtm_path} no tiene datos válidos")
        self.zmin = float(np.nanmin(sample)) - 50.0
        self.center_z = float(np.nanmedian(sample))

    def pix_to_lonlat(self, cols: np.ndarray, rows: np.ndarray):
        t = self.transform
        c, r = np.asarray(cols, float) + 0.5, np.asarray(rows, float) + 0.5
        xs, ys = t.a * c + t.b * r + t.c, t.d * c + t.e * r + t.f
        lons, lats = warp_transform(self.crs, MARS_LONGLAT, np.atleast_1d(xs).tolist(), np.atleast_1d(ys).tolist())
        return np.array(lons), np.array(lats)

    def _drop(self, r0, r1, c0, c1, step=(1, 1)) -> np.ndarray:
        rows = np.arange(r0, r1, step[0], dtype=np.float64)[:, None]
        cols = np.arange(c0, c1, step[1], dtype=np.float64)[None, :]
        return ts.curvature_drop(rows, cols, self.jac, self.center).astype(np.float32)

    def tangent(self, r0, r1, c0, c1) -> np.ndarray:
        """Alturas en el plano tangente del bloque (−inf donde no hay dato)."""
        return np.asarray(self.z[r0:r1, c0:c1])

    def valid(self, r0, r1, c0, c1) -> np.ndarray:
        return np.isfinite(self.z[r0:r1, c0:c1])

    def raw(self, r0, r1, c0, c1, step=(1, 1)) -> np.ndarray:
        """Alturas originales del DTM (NaN donde no hay dato)."""
        z = np.asarray(self.z[r0:r1:step[0], c0:c1:step[1]], dtype=np.float64)
        z = z + self._drop(r0, r1, c0, c1, step)
        z[~np.isfinite(z)] = np.nan
        return z


def build_far(grid: WorkGrid, dem_path: Path, step_m: float, max_dist_m: float):
    """Horizonte lejano a partir del DEM grueso, solo con terreno que el DTM no cubre."""
    f = max(1, int(round(step_m / min(grid.pixel_m))))
    grid_rows = np.arange(f / 2.0, grid.rows, f)
    grid_cols = np.arange(f / 2.0, grid.cols, f)
    gr, gc = np.meshgrid(grid_rows, grid_cols, indexing="ij")
    obs_lon, obs_lat = grid.pix_to_lonlat(gc.ravel(), gr.ravel())
    ri, ci = gr.astype(int).ravel(), gc.astype(int).ravel()
    obs_z = np.asarray(grid.z[ri, ci], dtype=np.float64) + ts.curvature_drop(ri, ci, grid.jac, grid.center)
    obs_z[~np.isfinite(obs_z)] = np.nan

    # DEM en lon/lat (cualquier CRS de entrada), solo la zona que se puede ver.
    pad = math.degrees(max_dist_m / ts.MARS_RADIUS_M) / max(math.cos(math.radians(grid.center_lat)), 0.2)
    lo_lon, hi_lon = obs_lon.min() - pad, obs_lon.max() + pad
    lo_lat, hi_lat = max(obs_lat.min() - pad, -90), min(obs_lat.max() + pad, 90)
    with rasterio.open(dem_path) as src, WarpedVRT(src, crs=MARS_LONGLAT, resampling=Resampling.bilinear) as vrt:
        win = from_bounds(lo_lon, lo_lat, hi_lon, hi_lat, vrt.transform).round_offsets().round_lengths()
        win = win.intersection(Window(0, 0, vrt.width, vrt.height))
        dem = vrt.read(1, window=win, masked=True).astype(np.float64).filled(np.nan)
        dem_t = vrt.window_transform(win)
    dlon, dlat = dem_t.a, -dem_t.e
    lon_c = dem_t.c + dlon * dem.shape[1] / 2
    dem_step_m = math.radians(dlat) * ts.MARS_RADIUS_M

    def sample_dem(lat, lon):
        lon = (lon - lon_c + 180.0) % 360.0 - 180.0 + lon_c
        r = (dem_t.f - lat) / dlat - 0.5
        c = (lon - dem_t.c) / dlon - 0.5
        return map_coordinates(dem, [r.ravel(), c.ravel()], order=1, mode="constant", cval=np.nan).reshape(lat.shape)

    # Qué cubre el DTM: lon/lat -> píxel con un ajuste afín (exacto en equirectangular y
    # en lon/lat; aproximado en otras proyecciones) + máscara gruesa de datos válidos.
    pr, pc = np.meshgrid(np.linspace(0, grid.rows - 1, 5), np.linspace(0, grid.cols - 1, 5), indexing="ij")
    plon, plat = grid.pix_to_lonlat(pc.ravel(), pr.ravel())
    plon = (plon - grid.center_lon + 180.0) % 360.0 - 180.0
    design = np.column_stack([plon, plat, np.ones_like(plon)])
    coef_c = np.linalg.lstsq(design, pc.ravel(), rcond=None)[0]
    coef_r = np.linalg.lstsq(design, pr.ravel(), rcond=None)[0]
    valid_coarse = np.isfinite(np.asarray(grid.z[::f, ::f]))

    def covered_by_dtm(lat, lon):
        lon = (lon - grid.center_lon + 180.0) % 360.0 - 180.0
        c = coef_c[0] * lon + coef_c[1] * lat + coef_c[2]
        r = coef_r[0] * lon + coef_r[1] * lat + coef_r[2]
        inside = (c >= 0) & (c < grid.cols) & (r >= 0) & (r < grid.rows)
        ri = np.clip((r // f).astype(int), 0, valid_coarse.shape[0] - 1)
        ci = np.clip((c // f).astype(int), 0, valid_coarse.shape[1] - 1)
        return inside & valid_coarse[ri, ci]

    missing = ~np.isfinite(obs_z)
    if missing.any():  # observador sobre un hueco del DTM: altura del DEM grueso
        obs_z[missing] = sample_dem(obs_lat[missing][:, None], obs_lon[missing][:, None]).ravel()
    dist = np.arange(dem_step_m, max_dist_m + dem_step_m, dem_step_m)
    log(f"horizonte lejano: {len(obs_z)} observadores cada {f * min(grid.pixel_m):.0f} m, "
        f"{len(dist)} muestras hasta {max_dist_m / 1000:.0f} km")
    return ts.build_far_horizon(obs_lat, obs_lon, obs_z, gr.shape, grid_rows, grid_cols,
                                sample_dem, covered_by_dtm, dist)


# ------------------------------------------------------------------ máscara para una posición del Sol

def lit_blocks(grid: WorkGrid, far, az: float, el: float):
    """Produce (r0, r1, c0, c1, lit, valid) por bloque, en orientación normal (filas, cols)."""
    if el <= 0:
        for r0 in range(0, grid.rows, STRIP):
            r1 = min(r0 + STRIP, grid.rows)
            valid = grid.valid(r0, r1, 0, grid.cols)
            yield r0, r1, 0, grid.cols, np.zeros_like(valid), valid
        return
    plan = ts.sweep_plan(grid.jac, az)
    tan_el = math.tan(math.radians(el))
    a = b = None
    if far is not None:
        a, b = far.at_azimuth(az)
        if tan_el > float(np.max(a - grid.zmin * b)):
            a = None  # el Sol está por encima de todo el horizonte lejano: no hace falta
    if plan.axis == 0:
        n_major, n_minor = grid.rows, grid.cols
        get = lambda i0, i1: grid.tangent(i0, i1, 0, grid.cols)
    else:
        n_major, n_minor = grid.cols, grid.rows
        get = lambda i0, i1: np.ascontiguousarray(grid.tangent(0, grid.rows, i0, i1).T)
    for i0, i1, lit in ts.sweep_lit(get, n_major, n_minor, plan, tan_el, block=STRIP):
        if plan.axis == 0:
            r0, r1, c0, c1 = i0, i1, 0, grid.cols
        else:
            r0, r1, c0, c1, lit = 0, grid.rows, i0, i1, lit.T
        valid = grid.valid(r0, r1, c0, c1)
        if a is not None:
            z = grid.raw(r0, r1, c0, c1)
            far_tan = far.tan_at(a, b, np.arange(r0, r1, dtype=float), np.arange(c0, c1, dtype=float),
                                 np.where(valid, z, grid.center_z))
            lit = lit & (tan_el > far_tan)
        yield r0, r1, c0, c1, lit, valid


# ------------------------------------------------------------------ salidas

def new_gtiff(path: Path, grid: WorkGrid, count: int, dtype: str, nodata: int):
    return rasterio.open(path, "w", driver="GTiff", width=grid.cols, height=grid.rows, count=count,
                         dtype=dtype, nodata=nodata, crs=grid.crs, transform=grid.transform,
                         tiled=True, blockxsize=512, blockysize=512, BIGTIFF="YES")


def to_cog(tmp: Path, dst: Path) -> None:
    rasterio.shutil.copy(tmp, dst, driver="COG", compress="DEFLATE", blocksize=512,
                         overview_resampling="NEAREST", bigtiff="IF_SAFER", num_threads="ALL_CPUS")
    tmp.unlink()


def fmt_ltst(seconds: float) -> str:
    s = int(round(seconds)) % sg.LOCAL_DAY_S
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}"


def run_sol(grid: WorkGrid, far, sun: sg.SiteSun, et_midnight: float, args, inputs: dict, work: Path) -> Path:
    et_next = sun.et_at_ltst(et_midnight + sg.SOL_S, 0.0)
    # Nombre del sol por día/mes/año/hora UTC, con minutos y segundos en 0.
    tag = dt.datetime.fromtimestamp(et_midnight, dt.timezone.utc).replace(
        minute=0, second=0, microsecond=0
    ).strftime("%Y%m%dT%H00Z")
    out_dir = inputs["out"] / "illumination" / tag
    out_dir.mkdir(parents=True, exist_ok=True)
    rise_et, set_et = sun.flat_horizon_crossings(et_midnight, et_next)
    log(f"sol {tag}: Ls {sg.solar_longitude_deg(et_midnight):.1f}°, amanecer plano "
        f"{fmt_ltst(sun.ltst_s(rise_et)) if rise_et else '—'}, atardecer {fmt_ltst(sun.ltst_s(set_et)) if set_et else '—'} LTST")

    # 1) Pila horaria
    n_bands = 1440 // args.step_min
    bands = []
    tmp = work / "shadow_hourly.tif"
    with new_gtiff(tmp, grid, n_bands, "uint8", NODATA_U8) as dst:
        for bi in range(n_bands):
            target = bi * args.step_min * 60
            et = sun.et_at_ltst(et_midnight + target * sg.SOL_S / sg.LOCAL_DAY_S, target)
            az, el = sun.az_el(et)
            n_lit = n_valid = 0
            t0 = time.time()
            for r0, r1, c0, c1, lit, valid in lit_blocks(grid, far, az, el):
                out = np.where(valid, lit.astype(np.uint8), np.uint8(NODATA_U8))
                dst.write(out, bi + 1, window=Window(c0, r0, c1 - c0, r1 - r0))
                n_lit += int((lit & valid).sum())
                n_valid += int(valid.sum())
            dst.set_band_description(bi + 1, f"LTST {fmt_ltst(target)}")
            frac = n_lit / n_valid if n_valid else 0.0
            bands.append({"band": bi + 1, "ltst": fmt_ltst(target), "utc": sg.et_to_utc(et),
                          "sun_az_deg": round(az, 3), "sun_el_deg": round(el, 3), "lit_fraction": round(frac, 4)})
            if el > 0:
                log(f"  banda {bi + 1:02d} LTST {fmt_ltst(target)}: Sol az {az:.1f}° el {el:.1f}°, "
                    f"{100 * frac:.1f} % al sol ({time.time() - t0:.0f} s)")
    to_cog(tmp, out_dir / "shadow_hourly.tif")

    # 2) Amanecer y atardecer con terreno
    step = args.rise_step_min * 60 * sg.SOL_S / sg.LOCAL_DAY_S
    rise = np.lib.format.open_memmap(work / "rise.npy", mode="w+", dtype=np.uint16, shape=(grid.rows, grid.cols))
    sset = np.lib.format.open_memmap(work / "set.npy", mode="w+", dtype=np.uint16, shape=(grid.rows, grid.cols))
    for r0 in range(0, grid.rows, STRIP):
        v = grid.valid(r0, r0 + STRIP, 0, grid.cols)
        rise[r0:r0 + STRIP] = np.where(v, NO_SUN_U16, NODATA_U16)
        sset[r0:r0 + STRIP] = np.where(v, NO_SUN_U16, NODATA_U16)
    if rise_et and set_et:
        # Dos medios barridos que se completan entre sí: mañana (amanecer plano -> mediodía,
        # hacia adelante) y tarde (atardecer plano -> mediodía, hacia atrás). Cada uno corta
        # cuando una pasada deja todo el DTM al sol. Minutos de la mañana < 720, tarde ≥ 720.
        #   amanecer = primer instante con sol a la mañana; si no hubo, el primero de la tarde.
        #   atardecer = último instante con sol a la tarde; si no hubo, el último de la mañana.
        noon_et = sun.et_at_ltst(et_midnight + sg.SOL_S / 2, sg.LOCAL_DAY_S / 2)
        t0 = time.time()
        morning = np.arange(rise_et, noon_et, step)
        afternoon = np.arange(set_et, noon_et, -step)
        n_passes = 0

        def scan(times, update, stop_when_all_lit=True):
            """Aplica `update` en cada posición del Sol. Devuelve el índice de la primera
            pasada con todo el DTM al sol (desde ahí no cambia nada) o None."""
            nonlocal n_passes
            for i, et in enumerate(times):
                az, el = sun.az_el(et)
                minute = int(sun.ltst_s(et) // 60)
                n_on = n_val = 0
                for r0, r1, c0, c1, lit, valid in lit_blocks(grid, far, az, el):
                    on = lit & valid
                    update(rise[r0:r1, c0:c1], sset[r0:r1, c0:c1], on, minute)
                    n_on += int(on.sum())
                    n_val += int(valid.sum())
                n_passes += 1
                if stop_when_all_lit and n_val and n_on == n_val:
                    return i
            return None

        def am(rv, sv, on, minute):   # primer sol de la mañana; sv guarda el último de la mañana
            rv[on & (rv == NO_SUN_U16)] = minute
            sv[on] = minute

        def pm(rv, sv, on, minute):   # último sol de la tarde; rv, el primero de la tarde si no hubo a la mañana
            rv[on & (rv >= 720) & (rv != NODATA_U16)] = minute
            sv[on & ((sv < 720) | (sv == NO_SUN_U16))] = minute

        stop_am = scan(morning, am)
        stop_pm = scan(afternoon, pm)

        def count(arr, cond):
            return sum(int(cond(arr[r0:r0 + STRIP]).sum()) for r0 in range(0, grid.rows, STRIP))

        # Si una mitad cortó antes y en la otra quedaron píxeles sin sol, retomar la que cortó:
        # esos píxeles toman su amanecer/atardecer de la mitad que se había cortado.
        if stop_am is not None and count(sset, lambda v: v < 720):
            scan(morning[stop_am + 1:], lambda rv, sv, on, m: sv.__setitem__(on & (sv < 720), m), False)
        if stop_pm is not None and count(rise, lambda v: (v >= 720) & (v < NO_SUN_U16)):
            scan(afternoon[stop_pm + 1:], lambda rv, sv, on, m: rv.__setitem__(on & (rv >= 720) & (rv < NO_SUN_U16), m), False)
        no_sun = count(rise, lambda v: v == NO_SUN_U16)
        log(f"  amanecer/atardecer con terreno: {n_passes} posiciones del Sol "
            f"({time.time() - t0:.0f} s), {no_sun} píxeles sin sol directo en todo el sol")
    tmp = work / "sun_times.tif"
    with new_gtiff(tmp, grid, 2, "uint16", NODATA_U16) as dst:
        for r0 in range(0, grid.rows, STRIP):
            r1 = min(r0 + STRIP, grid.rows)
            win = Window(0, r0, grid.cols, r1 - r0)
            dst.write(rise[r0:r1], 1, window=win)
            dst.write(sset[r0:r1], 2, window=win)
        dst.set_band_description(1, "Amanecer con terreno (minutos LTST)")
        dst.set_band_description(2, "Atardecer con terreno (minutos LTST)")
    del rise, sset
    to_cog(tmp, out_dir / "sun_times.tif")

    index = {
        "badge": "DERIVED",
        "site": inputs["site"],
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sol": {"start_utc": sg.et_to_utc(et_midnight), "end_utc": sg.et_to_utc(et_next),
                "ls_deg": round(sg.solar_longitude_deg(et_midnight), 2),
                "flat_sunrise": {"utc": sg.et_to_utc(rise_et), "ltst": fmt_ltst(sun.ltst_s(rise_et))} if rise_et else None,
                "flat_sunset": {"utc": sg.et_to_utc(set_et), "ltst": fmt_ltst(sun.ltst_s(set_et))} if set_et else None},
        "site_center": {"lat": round(grid.center_lat, 6), "lon": round(grid.center_lon, 6), "elev_m": round(grid.center_z, 1)},
        "shadow_hourly": {"file": "shadow_hourly.tif", "values": {"1": "sol", "0": "sombra", "255": "sin dato"},
                          "step_min": args.step_min, "bands": bands},
        "sun_times": {"file": "sun_times.tif", "bands": {"1": "amanecer", "2": "atardecer"},
                      "units": "minutos LTST desde medianoche", "step_min": args.rise_step_min,
                      "values": {"65534": "sin sol directo en este sol", "65535": "sin dato"},
                      "note": "Primera (amanecer) y última (atardecer) muestra con sol; el instante real "
                              f"está dentro de los {args.rise_step_min} min previos (amanecer) o siguientes (atardecer)."},
        "grid": {"shape": [grid.rows, grid.cols], "res_factor": args.res,
                 "pixel_ground_m": [round(grid.pixel_m[0], 3), round(grid.pixel_m[1], 3)], "crs": grid.crs.to_wkt()},
        "provenance": {
            "terrain": f"{inputs['dtm'].name} (DTM del sitio)",
            "far_terrain": inputs["far"].name if inputs["far"] else None,
            "ephemeris": "NAIF SPICE: " + ", ".join(p.name for p in inputs["kernels"]),
        },
        "assumptions": [
            "Sol puntual (centro del disco); sin refracción ni polvo.",
            "Azimut y elevación del Sol calculados en el centro del DTM y aplicados a todo el DTM.",
            "Terreno cercano a la resolución del DTM; terreno fuera del DTM con el DEM lejano "
            "(horizonte por observador cada " f"{args.far_step_m:.0f} m, hasta {args.max_dist_km:.0f} km).",
        ],
        "warnings": [] if inputs["far"] else ["Sin DEM lejano: el terreno fuera del DTM (p. ej. el borde "
                                              "del cráter) no proyecta sombra; el amanecer sale temprano."],
    }
    (out_dir / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    log(f"sol {tag} listo en {out_dir}")
    return out_dir


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", help="Sitio del manifest (jezero, gale)")
    p.add_argument("--dtm", help="DTM arbitrario (en lugar de --site)")
    p.add_argument("--far-dem", help="DEM grueso para el terreno fuera del DTM (con --dtm)")
    p.add_argument("--kernels", help="Carpeta con los kernels SPICE (default: DATA_DIR/raw/common)")
    p.add_argument("--out", help="Carpeta de salida (default: DATA_DIR/output/<sitio>)")
    p.add_argument("--start", help="UTC; se calcula desde la primera medianoche local siguiente (default: ahora)")
    p.add_argument("--sols", type=int, default=1)
    p.add_argument("--step-min", type=int, default=60, choices=[10, 15, 20, 30, 60, 120],
                   help="Paso de la pila en minutos LTST")
    p.add_argument("--rise-step-min", type=int, default=5, help="Resolución de amanecer/atardecer")
    p.add_argument("--res", type=int, default=1, help="Promediar el DTM N×N antes de calcular")
    p.add_argument("--far-step-m", type=float, default=250.0, help="Separación de observadores del horizonte lejano")
    p.add_argument("--max-dist-km", type=float, default=100.0, help="Alcance del horizonte lejano")
    args = p.parse_args(argv)
    if not (args.site or args.dtm):
        p.error("hace falta --site o --dtm")

    try:
        inputs = resolve_inputs(args)
    except DataNotReady as e:
        log(f"DATOS NO LISTOS: {e}")
        return 2
    work = inputs["out"] / "illumination" / "_work"
    work.mkdir(parents=True, exist_ok=True)
    try:
        log(f"DTM {inputs['dtm']} (res ×{args.res})")
        grid = WorkGrid(inputs["dtm"], args.res, work)
        log(f"grilla {grid.rows}×{grid.cols}, píxel {grid.pixel_m[0]:.2f}×{grid.pixel_m[1]:.2f} m, "
            f"centro {grid.center_lat:.4f}, {grid.center_lon:.4f}")
        far = None
        if inputs["far"]:
            far = build_far(grid, inputs["far"], args.far_step_m, args.max_dist_km * 1000.0)
        else:
            log("AVISO: sin DEM lejano; solo sombras del terreno dentro del DTM")
        with sg.spice_kernels(inputs["kernels"]):
            sun = sg.SiteSun(grid.center_lat, grid.center_lon, grid.center_z)
            start = args.start or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
            et = sun.local_midnight_after(sg.utc_to_et(start))
            for _ in range(args.sols):
                run_sol(grid, far, sun, et, args, inputs, work)
                et = sun.et_at_ltst(et + sg.SOL_S, 0.0)
    except DataNotReady as e:
        log(f"DATOS NO LISTOS: {e}")
        return 2
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
