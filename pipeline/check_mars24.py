#!/usr/bin/env python3
"""Genera la referencia de efemérides contra la que se valida el reloj del mapa.

El reloj de `web/` usa Mars24 (Allison & McEwen), que es una aproximación
analítica. El criterio de cierre de su ticket es que coincida con las
efemérides de verdad, o sea con SPICE. Pero SPICE corre en Python y en el
server (donde están los kernels), y el reloj corre en TypeScript en el
navegador: no se pueden comparar en el mismo proceso.

Por eso la validación está partida en dos:

  1. Este script, en el server: calcula LTST y Ls con SPICE en una serie de
     instantes y los escribe en web/src/mars/ephemeris-reference.json.
  2. `node web/scripts/check-mars24.mjs`, en cualquier máquina con node:
     corre el mars24.ts de verdad y lo compara contra ese JSON.

La referencia se commitea: así el chequeo corre en CI y en la máquina de
cualquiera, sin kernels.

  .venv-pipeline/bin/python pipeline/check_mars24.py --site jezero
  .venv-pipeline/bin/python pipeline/check_mars24.py --site jezero --sols 3 --cada 2
"""
import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
SALIDA = ROOT / "web" / "src" / "mars" / "ephemeris-reference.json"


def cargar_sitio(site_id: str) -> dict:
    p = ROOT / "sites" / f"{site_id}.json"
    if not p.exists():
        sys.exit(f"No existe {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def kernels(carpeta: Path) -> list[Path]:
    patrones = ("naif*.tls", "pck*.tpc", "de4*.bsp", "mar*.bsp")
    encontrados = [p for pat in patrones for p in sorted(carpeta.glob(pat))]
    faltan = [pat for pat in patrones if not list(carpeta.glob(pat))]
    if faltan:
        sys.exit(
            f"Faltan kernels en {carpeta}: {', '.join(faltan)}.\n"
            "Se bajan con pipeline/download.py (están en sites/common.json). "
            "Sin kernels no se puede generar la referencia."
        )
    return encontrados


def main():
    ap = argparse.ArgumentParser(description="Referencia SPICE para validar el reloj marciano")
    ap.add_argument("--site", default="jezero", help="id del sitio (sites/<id>.json)")
    ap.add_argument("--desde", default=None, help="UTC inicial ISO; por defecto, ahora")
    ap.add_argument("--sols", type=int, default=2, help="cuántos soles cubrir")
    ap.add_argument("--cada", type=float, default=1.0, help="paso en horas")
    ap.add_argument("--kernels", type=Path, default=DATA_DIR / "raw" / "common")
    ap.add_argument("--out", type=Path, default=SALIDA)
    args = ap.parse_args()

    try:
        import spiceypy as sp
    except ImportError:
        sys.exit("Falta spiceypy: usá el venv del pipeline (.venv-pipeline).")

    from sun_geometry import SiteSun, solar_longitude_deg, utc_to_et

    sitio = cargar_sitio(args.site)
    centro = sitio["center"]
    ks = kernels(args.kernels)
    sp.furnsh([str(k) for k in ks])
    try:
        sol = SiteSun(centro["lat"], centro["lon"])
        inicio = (
            dt.datetime.fromisoformat(args.desde.replace("Z", "+00:00"))
            if args.desde
            else dt.datetime.now(dt.timezone.utc)
        ).replace(microsecond=0)

        # 1 sol marciano ≈ 24.6597 h.
        horas = int(args.sols * 24.6597 / args.cada)
        muestras = []
        for i in range(horas + 1):
            t = inicio + dt.timedelta(hours=i * args.cada)
            utc = t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            et = utc_to_et(utc)
            az, el = sol.az_el(et)
            muestras.append({
                "utc": utc,
                "ltst_s": round(sol.ltst_s(et), 3),
                "ls_deg": round(solar_longitude_deg(et), 4),
                "sun_az_deg": round(az, 3),
                "sun_el_deg": round(el, 3),
            })
    finally:
        sp.kclear()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "site": sitio["id"],
        "center": centro,
        "kernels": [k.name for k in ks],
        "source": "NAIF SPICE (spiceypy) vía pipeline/sun_geometry.py",
        "note": "Referencia para validar web/src/mars/mars24.ts. La compara "
                "node web/scripts/check-mars24.mjs.",
        "samples": muestras,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"{len(muestras)} muestras -> {args.out}")
    print("Ahora: node web/scripts/check-mars24.mjs")


if __name__ == "__main__":
    main()
