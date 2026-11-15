"""Lectura de la pila de sol/sombra que precomputa `pipeline/illumination.py`.

Solo lee. Si la pila de un sol no está, se dice que falta: la API nunca corre el
pipeline (tarda minutos y usa GB de RAM). Formato de la salida en docs/illumination.md:

    /data/output/<sitio>/illumination/<AAAAMMDDTHHMMZ>/
        shadow_hourly.tif   uint8, una banda por paso LTST: 1 sol, 0 sombra, 255 sin dato
        index.json          por banda: hora LTST y UTC, Sol; grilla, procedencia y supuestos

Mientras el pipeline corre existe `illumination/_work/`: no es un sol y se ignora.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path

import numpy as np

LIT = 1
SHADOW = 0
NODATA_U8 = 255

# Nombre de carpeta que escribe run_sol(): medianoche local en UTC, sin segundos.
SOL_TAG_RE = re.compile(r"^\d{8}T\d{4}Z$")


class IlluminationNotReady(LookupError):
    """La pila de sombras de ese sitio o sol todavía no está precomputada."""


def parse_utc(s: str) -> float:
    """'2026-11-15T06:49:12Z' (o con fracción, o sin Z) → segundos epoch UTC."""
    t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.timestamp()


def sol_dirs(data_dir: Path, site_id: str) -> list[Path]:
    """Carpetas de sol completas (con tif e index), ordenadas por fecha."""
    base = Path(data_dir) / "output" / site_id / "illumination"
    if not base.is_dir():
        return []
    return sorted(
        p for p in base.iterdir()
        if p.is_dir() and SOL_TAG_RE.match(p.name)
        and (p / "index.json").is_file() and (p / "shadow_hourly.tif").is_file()
    )


class ShadowStack:
    """Una carpeta de sol: qué banda corresponde a cada instante y cómo leerla."""

    def __init__(self, sol_dir: Path):
        self.dir = Path(sol_dir)
        self.tag = self.dir.name
        self.index = json.loads((self.dir / "index.json").read_text(encoding="utf-8"))
        sh = self.index["shadow_hourly"]
        self.tif = self.dir / sh.get("file", "shadow_hourly.tif")
        self.step_min = int(sh["step_min"])
        self.bands = [(int(b["band"]), parse_utc(b["utc"]), b["ltst"], float(b.get("sun_el_deg", 0.0)))
                      for b in sh["bands"]]
        sol = self.index["sol"]
        self.start = parse_utc(sol["start_utc"])
        self.end = parse_utc(sol["end_utc"])
        self.sunrise = _crossing(sol.get("flat_sunrise"))
        self.sunset = _crossing(sol.get("flat_sunset"))
        # Medio paso real entre bandas (un minuto LTST dura ~61.6 s).
        gaps = np.diff([t for _, t, _, _ in self.bands])
        self.half_step_s = float(np.median(gaps)) / 2 if len(gaps) else self.step_min * 30.0

    def covers(self, t: float) -> bool:
        return self.start <= t < self.end

    def band_at(self, t: float) -> int | None:
        """Banda cuyo instante está más cerca de `t`, o None si `t` cae fuera de este sol."""
        if not self.bands:
            return None
        band, bt, _, _ = min(self.bands, key=lambda b: abs(b[1] - t))
        return band if abs(bt - t) <= self.half_step_s + 1 else None

    def band_for_ltst(self, ltst: str) -> int:
        """Banda de una hora LTST 'HH:MM'. La pila tiene bandas cada `step_min`."""
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", ltst.strip())
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
            raise ValueError("ltst tiene que ser HH:MM, con HH de 00 a 23 y MM de 00 a 59")
        minute = int(m.group(1)) * 60 + int(m.group(2))
        if minute % self.step_min:
            raise ValueError(f"La pila de este sol tiene una banda cada {self.step_min} min LTST; "
                             f"pedí una hora múltiplo de ese paso")
        band = minute // self.step_min + 1
        if not any(b == band for b, _, _, _ in self.bands):
            raise ValueError(f"El horario {ltst} no está en la pila de este sol")
        return band

    def provenance(self) -> dict:
        prov = self.index.get("provenance") or {}
        grid = self.index.get("grid") or {}
        px = grid.get("pixel_ground_m")
        return {
            "provenance": "DERIVED",
            "mission": "MRO",
            "instrument": "HiRISE DTM + NAIF SPICE",
            "resolution": f"{px[0]:.2f} × {px[1]:.2f} m/px" if px else None,
            "source": f"pipeline/illumination.py · sol {self.tag} · {prov.get('ephemeris', 'SPICE')}",
            "assumptions": list(self.index.get("assumptions") or []),
        }


def _crossing(c: dict | None) -> float | None:
    return parse_utc(c["utc"]) if c and c.get("utc") else None


def stack_for_time(data_dir: Path, site_id: str, t: float) -> ShadowStack | None:
    """La pila del sol que contiene el instante `t`, o None si no se precomputó."""
    for d in sol_dirs(data_dir, site_id):
        try:
            s = ShadowStack(d)
        except (OSError, KeyError, ValueError, json.JSONDecodeError):
            continue  # index.json a medio escribir o de otra versión: se ignora
        if s.covers(t):
            return s
    return None


def stack_for_tag(data_dir: Path, site_id: str, sol_tag: str | None) -> ShadowStack:
    """La pila de un sol por nombre de carpeta, o la más reciente si `sol_tag` es None."""
    if sol_tag is not None and not SOL_TAG_RE.match(sol_tag):
        raise ValueError("sol_tag tiene que ser AAAAMMDDTHHMMZ, por ejemplo 20261115T0649Z")
    dirs = sol_dirs(data_dir, site_id)
    if sol_tag is not None:
        dirs = [d for d in dirs if d.name == sol_tag]
    if not dirs:
        raise IlluminationNotReady(
            f"La pila de sombras de {site_id}" + (f" para el sol {sol_tag}" if sol_tag else "")
            + " todavía no está: la genera pipeline/illumination.py.")
    return ShadowStack(dirs[-1])


def apply_affine(t, xs, ys):
    """`t * (xs, ys)` para arrays, sin depender de cómo cada versión de affine lo opera."""
    return t.a * xs + t.b * ys + t.c, t.d * xs + t.e * ys + t.f


def sample_on_points(ds, band: int, xs: np.ndarray, ys: np.ndarray, cell_m: float | None = None,
                     pixel_m: float | None = None) -> np.ndarray:
    """Valor de `band` en cada punto (xs, ys), en el CRS de `ds`. 255 fuera del raster.

    Lee solo la ventana que cubre los puntos. Si los puntos están más separados que
    el píxel (`cell_m` > `pixel_m`), la lee remuestreada con vecino más cercano: es
    una máscara por clases, así que no se promedian valores.
    """
    from rasterio.enums import Resampling
    from rasterio.transform import Affine
    from rasterio.windows import Window

    out = np.full(xs.shape, NODATA_U8, dtype=np.uint8)
    inv = ~ds.transform
    cols, rows = apply_affine(inv, xs.ravel(), ys.ravel())
    c0, c1 = int(np.floor(np.nanmin(cols))), int(np.floor(np.nanmax(cols))) + 1
    r0, r1 = int(np.floor(np.nanmin(rows))), int(np.floor(np.nanmax(rows))) + 1
    c0, r0 = max(c0, 0), max(r0, 0)
    c1, r1 = min(c1, ds.width), min(r1, ds.height)
    if c1 <= c0 or r1 <= r0:
        return out
    win = Window(c0, r0, c1 - c0, r1 - r0)
    k = max(1, int(cell_m // pixel_m)) if cell_m and pixel_m else 1
    oh, ow = max(1, -(-win.height // k)), max(1, -(-win.width // k))
    arr = ds.read(band, window=win, out_shape=(oh, ow), resampling=Resampling.nearest)
    t = ds.window_transform(win) * Affine.scale(win.width / ow, win.height / oh)
    cc, rr = apply_affine(~t, xs.ravel(), ys.ravel())
    cc, rr = np.floor(cc).astype(np.int64), np.floor(rr).astype(np.int64)
    ok = (cc >= 0) & (cc < ow) & (rr >= 0) & (rr < oh)
    flat = out.ravel()
    flat[ok] = arr[rr[ok], cc[ok]]
    return flat.reshape(xs.shape)


MAX_WINDOW_CELLS = 250_000  # ~250 k celdas en JSON; más grande se remuestrea


def read_window(stack: ShadowStack, band: int, p1: tuple[float, float], p2: tuple[float, float]) -> dict:
    """Sol/sombra de una banda en el rectángulo entre dos puntos (lat, lon).

    `values[fila][columna]`: True al sol, False en sombra, None sin dato (nunca se
    rellena). Fila 0 = borde superior del raster. Si el rectángulo tiene más de
    MAX_WINDOW_CELLS celdas, se lee con vecino más cercano cada `decimation` píxeles.
    """
    import math

    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import transform
    from rasterio.windows import Window

    from .terrain import MARS_LONGLAT, _norm_lon

    with rasterio.open(stack.tif) as ds:
        if not 1 <= band <= ds.count:
            raise ValueError(f"La pila de este sol tiene bandas de 1 a {ds.count}")
        xs, ys = transform(MARS_LONGLAT, ds.crs, [_norm_lon(p1[1]), _norm_lon(p2[1])], [p1[0], p2[0]])
        ends = [ds.index(x, y, op=math.floor) for x, y in zip(xs, ys)]
        if any(not (0 <= r < ds.height and 0 <= c < ds.width) for r, c in ends):
            raise ValueError("Un punto cae fuera de la pila de sombras del sitio")
        (ra, ca), (rb, cb) = ends
        r0, c0 = min(ra, rb), min(ca, cb)
        h, w = abs(ra - rb) + 1, abs(ca - cb) + 1
        k = max(1, math.ceil(math.sqrt(h * w / MAX_WINDOW_CELLS)))
        oh, ow = -(-h // k), -(-w // k)
        arr = ds.read(band, window=Window(c0, r0, w, h), out_shape=(oh, ow), resampling=Resampling.nearest)

    px = (stack.index.get("grid") or {}).get("pixel_ground_m")
    info = next(b for b in stack.bands if b[0] == band)
    prov = stack.provenance()
    if k > 1:
        prov["assumptions"].append(f"Ventana remuestreada: 1 de cada {k} píxeles por lado (vecino más cercano)")
    return {
        "site_id": stack.index.get("site"),
        "sol_tag": stack.tag,
        "band": band,
        "ltst": info[2],
        "utc": dt.datetime.fromtimestamp(info[1], dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sun_el_deg": info[3],
        "decimation": k,
        "cell_ground_m": [round(px[0] * k, 3), round(px[1] * k, 3)] if px else None,
        "window": {"row_start": r0, "row_end": r0 + h - 1, "col_start": c0, "col_end": c0 + w - 1},
        "shape": [oh, ow],
        "values": [[None if v == NODATA_U8 else v == LIT for v in row] for row in arr.tolist()],
        **{k_: v for k_, v in prov.items() if k_ != "provenance"},
        "provenance": prov["provenance"],
    }
