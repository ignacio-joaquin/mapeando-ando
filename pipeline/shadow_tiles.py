#!/usr/bin/env python3
"""Tesela la pila de sombras por hora para el deslizador de tiempo del mapa.

`illumination.py` escribe, por sol, un COG con una banda por hora LTST
(`shadow_hourly.tif`). El navegador no abre un COG, así que este script hace,
para cada banda con el Sol sobre el horizonte, una pirámide de tiles PNG:

  /data/output/<sitio>/illumination/<sol>/tiles/<HHMM>/{z}/{x}/{y}.png
  /data/output/<sitio>/illumination/<sol>/tiles.json    qué horas hay y con qué zoom
  /data/output/<sitio>/illumination/catalog.json        qué soles hay (lo lee el mapa)

nginx sirve /data/output como /tiles/, así que el mapa los pide directo.

  python pipeline/shadow_tiles.py --site jezero              # todos los soles del sitio
  python pipeline/shadow_tiles.py --site jezero --sol 20261115T0649Z
  python pipeline/shadow_tiles.py --out /data/output/otro    # cualquier carpeta de salida

Las bandas de noche no se teselan: con el Sol bajo el horizonte toda la banda es
sombra y el mapa lo dice sin pedir tiles. Cada hora es una máscara (sol / sombra /
sin dato) y se dibuja tal cual: no se interpola entre horas.

Necesita gdal-bin (lo instala deploy/bootstrap.sh). Un fallo en una hora no corta
las demás: queda anotado en tiles.json.
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import tiles as tl

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
SOL_TAG_RE = re.compile(r"^\d{8}T\d{4}Z$")

# Zoom tope por defecto. Los tiles son lat/lon de Marte etiquetado como EPSG:4326,
# así que a z15 un píxel mide ~2,5 m en el ecuador marciano (2,4 m en Jezero), no
# los ~4,8 m de la Tierra: alcanza para ver moverse las sombras y no genera
# cientos de miles de PNG por sol. El mapa agranda el último nivel si se acerca más.
DEFAULT_MAX_ZOOM = 15

# Colores de la máscara (valores de shadow_hourly.tif). Si cambian, cambia la
# leyenda de la capa "survival-shadows" en web/src/map/layers.ts.
#   0 = sombra   -> oscuro semitransparente
#   1 = sol      -> transparente (se ve el terreno)
#   255 = sin dato dentro del DTM -> gris azulado, para no confundirlo con "al sol"
#   254 = fuera del DTM (relleno de la reproyección) -> transparente
# El "sin dato" se pasa a valor común antes de colorear: gdaldem deja
# transparente el nodata declarado e ignora la entrada `nv`.
FUERA = 254
COLORES = [
    "0 12 10 9 175",
    "1 0 0 0 0",
    f"{FUERA} 0 0 0 0",
    "255 120 130 150 110",
]


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def hhmm(ltst: str) -> str:
    """'07:00' -> '0700' (nombre de carpeta: es contrato con el frontend)."""
    h, m = ltst.split(":")
    return f"{int(h):02d}{int(m):02d}"


def sol_dirs(base: Path) -> list[Path]:
    """Carpetas de sol completas de illumination/, ordenadas por fecha."""
    if not base.is_dir():
        return []
    return sorted(
        p for p in base.iterdir()
        if p.is_dir() and SOL_TAG_RE.match(p.name)
        and (p / "index.json").is_file() and (p / "shadow_hourly.tif").is_file()
    )


def daylight_bands(index: dict) -> list[dict]:
    """Bandas con el Sol sobre el horizonte plano: las únicas que vale la pena teselar."""
    return [b for b in index["shadow_hourly"]["bands"] if float(b.get("sun_el_deg", 0.0)) > 0.0]


def provenance(index: dict, tag: str) -> dict:
    """Misma procedencia que declara la API para esta pila (api/illumination.py)."""
    prov = index.get("provenance") or {}
    px = (index.get("grid") or {}).get("pixel_ground_m")
    return {
        "provenance": "DERIVED",
        "mission": "MRO",
        "instrument": "HiRISE DTM + NAIF SPICE",
        "resolution": f"{px[0]:.2f} × {px[1]:.2f} m/px" if px else None,
        "source": f"pipeline/illumination.py · sol {tag} · {prov.get('ephemeris', 'SPICE')}",
        "assumptions": list(index.get("assumptions") or []),
    }


def a_web_mascara(src: Path, dest: Path, work: Path) -> None:
    """Reproyecta la pila como tiles.a_crs_web, pero separando dos "sin dato":
    el hueco del DTM (255, se dibuja) y lo que queda fuera del DTM (254, transparente)."""
    crudo = work / "crudo.tif"
    tl.run(["gdal_translate", "-q", "-a_nodata", "none", *tl.GTIFF_OPTS, src, crudo])
    tl.run(["gdalwarp", "-q", "-overwrite", "-t_srs", tl.MARS_LONGLAT, "-r", "near",
            "-dstnodata", str(FUERA), *tl.GTIFF_OPTS, crudo, dest])
    crudo.unlink(missing_ok=True)
    tl.run(["gdal_edit.py", "-a_srs", "EPSG:4326", dest])  # misma etiqueta que tiles.a_crs_web


def colorear_mascara(src: Path, dest: Path) -> None:
    tabla = dest.parent / "sombra_colores.txt"
    tabla.write_text("\n".join(COLORES) + "\n")
    # -nearest y no -exact: con -exact_color_entry, GDAL 3.8 deja transparente la última
    # entrada de la tabla. La máscara solo tiene 0, 1, 254 y 255, así que es lo mismo.
    tl.run(["gdaldem", "color-relief", "-nearest_color_entry", "-alpha", src, tabla, dest, *tl.GTIFF_OPTS])


def up_to_date(prev: dict, index: dict, max_zoom: int) -> bool:
    """¿El tiles.json anterior ya corresponde a esta pila y a este zoom, sin horas fallidas?

    El zoom cuenta: si no, volver a correr con otro --max-zoom no haría nada.
    """
    return (prev.get("index_generated_at") == index.get("generated_at")
            and prev.get("max_zoom") == max_zoom
            and all(b.get("status") == "ok" for b in prev.get("bands", [])))


def tile_sol(sol_dir: Path, site_base: Path, max_zoom: int, force: bool = False) -> dict:
    """Tesela las horas de día de un sol y escribe su tiles.json. Devuelve ese índice."""
    tag = sol_dir.name
    index = json.loads((sol_dir / "index.json").read_text(encoding="utf-8"))
    out_json = sol_dir / "tiles.json"
    if out_json.is_file() and not force:
        try:
            prev = json.loads(out_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            prev = {}  # roto: se rehace
        if up_to_date(prev, index, max_zoom):
            log(f"sol {tag}: tiles al día (usá --force para rehacerlos)")
            return prev

    rel_sol = sol_dir.relative_to(site_base).as_posix()
    work = sol_dir / ".tiles.work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    bands_out: list[dict] = []
    try:
        # Una sola reproyección de toda la pila, con vecino más cercano: es una
        # máscara por clases y un promedio inventaría "media sombra".
        web = work / "web.tif"
        a_web_mascara(sol_dir / "shadow_hourly.tif", web, work)
        bounds = tl.limites(web)
        tiles_dir = sol_dir / "tiles"
        tiles_dir.mkdir(exist_ok=True)

        for b in daylight_bands(index):
            name = hhmm(b["ltst"])
            entry = {k: b.get(k) for k in ("band", "ltst", "utc", "sun_az_deg", "sun_el_deg", "lit_fraction")}
            try:
                banda = work / f"b{name}.tif"
                tl.run(["gdal_translate", "-q", "-b", str(b["band"]), "-a_nodata", "none",
                        *tl.GTIFF_OPTS, web, banda])
                color = work / f"c{name}.tif"
                colorear_mascara(banda, color)
                piramide = work / f"t{name}"
                n = tl.teselar(color, piramide, resampling="near", max_zoom=max_zoom)
                if n == 0:
                    raise RuntimeError("gdal2tiles no generó ningún tile")
                zmin, zmax = tl.zooms(piramide)
                tl.publicar_carpeta(piramide, tiles_dir / name)
                entry.update(status="ok", template=f"{rel_sol}/tiles/{name}/{{z}}/{{x}}/{{y}}.png",
                             minzoom=zmin, maxzoom=zmax, bounds=bounds, count=n)
                log(f"sol {tag} {b['ltst']} LTST: {n} tiles (z{zmin}-{zmax})")
            except (subprocess.CalledProcessError, RuntimeError, OSError) as e:
                entry.update(status="error", error=str(e)[:400])
                log(f"sol {tag} {b['ltst']} LTST: ERROR {e}")
            finally:
                for f in work.glob(f"[bc]{name}.tif"):
                    f.unlink(missing_ok=True)
            bands_out.append(entry)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    result = {
        "badge": "DERIVED",
        "sol_tag": tag,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "index_generated_at": index.get("generated_at"),
        "step_min": index["shadow_hourly"]["step_min"],
        "max_zoom": max_zoom,
        "sol": index["sol"],
        "values": {"sombra": "RGBA 12 10 9 175", "sol": "transparente",
                   "sin dato": "RGBA 120 130 150 110", "fuera del DTM": "transparente"},
        "provenance": provenance(index, tag),
        "warnings": list(index.get("warnings") or []),
        "bands": bands_out,
    }
    tmp = sol_dir / ".tiles.json.tmp"
    tmp.write_text(json.dumps(result, indent=1, ensure_ascii=False))
    os.replace(tmp, out_json)  # nginx nunca sirve un JSON a medias
    return result


def write_catalog(illum: Path) -> dict:
    """Lista de soles del sitio, para que el mapa elija el del instante pedido."""
    sols = []
    for d in sol_dirs(illum):
        try:
            index = json.loads((d / "index.json").read_text(encoding="utf-8"))
            sol = index["sol"]
        except (OSError, KeyError, json.JSONDecodeError):
            continue  # index a medio escribir: se ignora, como en la API
        tiles_ok = False
        tj = d / "tiles.json"
        if tj.is_file():
            try:
                tiles_ok = any(b.get("status") == "ok" for b in json.loads(tj.read_text(encoding="utf-8"))["bands"])
            except (OSError, KeyError, json.JSONDecodeError):
                tiles_ok = False
        sols.append({
            "tag": d.name,
            "start_utc": sol["start_utc"],
            "end_utc": sol["end_utc"],
            "ls_deg": sol.get("ls_deg"),
            "flat_sunrise": sol.get("flat_sunrise"),
            "flat_sunset": sol.get("flat_sunset"),
            "step_min": index["shadow_hourly"]["step_min"],
            "tiles": f"{d.name}/tiles.json" if tiles_ok else None,
        })
    catalog = {
        "badge": "DERIVED",
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sols": sols,
    }
    tmp = illum / ".catalog.json.tmp"
    tmp.write_text(json.dumps(catalog, indent=1, ensure_ascii=False))
    os.replace(tmp, illum / "catalog.json")  # nginx nunca sirve un JSON a medias
    return catalog


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", help="Sitio (usa DATA_DIR/output/<sitio>)")
    p.add_argument("--out", type=Path, help="Carpeta de salida del sitio (en lugar de --site)")
    p.add_argument("--sol", action="append", default=[], help="Sol a teselar (AAAAMMDDTHHMMZ); repetible")
    p.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM, dest="max_zoom")
    p.add_argument("--force", action="store_true", help="Rehacer aunque los tiles estén al día")
    args = p.parse_args(argv)
    if not (args.site or args.out):
        p.error("hace falta --site o --out")

    faltan = tl.faltan_herramientas()
    if faltan:
        log(f"Faltan herramientas de GDAL: {', '.join(faltan)} (las instala deploy/bootstrap.sh)")
        return 2

    site_base = args.out or (DATA_DIR / "output" / args.site)
    illum = site_base / "illumination"
    dirs = sol_dirs(illum)
    for tag in args.sol:
        if not SOL_TAG_RE.match(tag):
            p.error(f"--sol {tag}: tiene que ser AAAAMMDDTHHMMZ")
    if args.sol:
        dirs = [d for d in dirs if d.name in args.sol]
    if not dirs:
        log(f"DATOS NO LISTOS: no hay pila de sombras en {illum} (la genera pipeline/illumination.py)")
        return 2

    t0 = time.time()
    for d in dirs:
        tile_sol(d, site_base, args.max_zoom, force=args.force)
    write_catalog(illum)
    log(f"catálogo en {illum / 'catalog.json'} · listo en {(time.time() - t0) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
