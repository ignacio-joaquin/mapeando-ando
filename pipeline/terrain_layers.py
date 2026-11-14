#!/usr/bin/env python3
"""Capas de terreno para EVA: entradas de Pandolf + máscara de no transitable.

Script independiente: lee las salidas de precompute.py (dtm.tif, slope.tif) de un
sitio y escribe, en la misma carpeta, capas separadas y documentadas para que se
puedan combinar después con otras fuentes de datos:

  roughness.tif         rugosidad pura (m): desvío estándar de los residuos del DTM
                        en una ventana de 5 m, tras restar la tendencia local (15 m).
                        Es la medida física, sin umbrales.
  terrain_factor.tif    factor de terreno η de Pandolf (adimensional, 1.1 a 1.8),
                        SOLO por rugosidad. La pendiente NO está incluida: en Pandolf
                        entra aparte como el grado G, que se calcula sobre la ruta
                        (depende de la dirección de marcha) usando dtm.tif.
  impassable.tif        máscara 0/1: 1 = no transitable a pie (pendiente o rugosidad
                        por encima del umbral). Pandolf no modela lo imposible.
  terrain_layers.json   metadatos: unidades, umbrales, método, leyenda, badge, fuentes.

No incluye gravedad ni traje (eso se aplica en otra etapa).
Se procesa por bloques, así que funciona con DTMs grandes (Gale) sin llenar la memoria.

Uso:
  python pipeline/terrain_layers.py --site jezero                     # /data/output/jezero
  python pipeline/terrain_layers.py --dir ~/output/jezero_prueba      # cualquier carpeta

Como módulo (para combinar con otros datos):
  from terrain_layers import rugosidad_pura, factor_terreno, no_transitable
"""
import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.ndimage import uniform_filter

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

# --- Parámetros (documentados en el README y en terrain_layers.json) ---
VENTANA_TENDENCIA_M = 15        # escala de la "forma general" del terreno (se resta)
VENTANA_RUGOSIDAD_M = 5         # escala de bloques; ~resolución horizontal real del DTM HiRISE

# Rugosidad pura (m) -> η de Pandolf. Interpolación lineal entre anclas; fuera de rango se satura.
RUGOSIDAD_ANCLAS_M = [0.1, 0.3, 0.5, 1.0]
ETA_VALORES = [1.1, 1.2, 1.5, 1.8]   # tierra, matorral liviano, matorral denso, pantano

# No transitable a pie
NO_TRANSITABLE_PENDIENTE_DEG = 30.0
NO_TRANSITABLE_RUGOSIDAD_M = 1.0

BLOQUE = 2048                   # tamaño de bloque de procesamiento (px)
NODATA_MASCARA = 255


# ---------------------------------------------------------------------------
# Funciones de cálculo (reutilizables desde otros scripts)
# ---------------------------------------------------------------------------
def impar(n):
    n = max(int(round(n)), 1)
    return n if n % 2 == 1 else n + 1


def media_movil(a, validos, tam):
    """Promedio en ventana de tam x tam usando solo las celdas válidas.
    (uniform_filter con NaN contagiaría filas enteras: por eso se promedia con pesos.)"""
    num = uniform_filter(np.where(validos, a, 0.0), size=tam, mode="nearest")
    den = uniform_filter(validos.astype("float64"), size=tam, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den > 1e-9, num / den, np.nan)


def rugosidad_pura(z, tam_tendencia_px, tam_rugosidad_px):
    """Desvío estándar móvil de (z - promedio local). z en metros, NaN = sin dato."""
    validos = ~np.isnan(z)
    if not validos.any():
        return np.full(z.shape, np.nan)
    # Centrar en la media del bloque mejora la precisión numérica (alturas ~ -2500 m)
    z0 = z - np.nanmean(z)
    r = z0 - media_movil(z0, validos, tam_tendencia_px)
    m = media_movil(r, validos, tam_rugosidad_px)
    m2 = media_movil(r * r, validos, tam_rugosidad_px)
    rug = np.sqrt(np.clip(m2 - m * m, 0, None))
    return np.where(validos, rug, np.nan)


def factor_terreno(rugosidad_m):
    """η de Pandolf a partir de la rugosidad pura (m). NaN se mantiene NaN."""
    eta = np.interp(rugosidad_m, RUGOSIDAD_ANCLAS_M, ETA_VALORES)
    return np.where(np.isnan(rugosidad_m), np.nan, eta)


def no_transitable(pendiente_deg, rugosidad_m):
    """1 = no transitable, 0 = transitable, 255 = sin dato."""
    sin_dato = np.isnan(pendiente_deg) | np.isnan(rugosidad_m)
    malo = (np.nan_to_num(pendiente_deg) > NO_TRANSITABLE_PENDIENTE_DEG) | \
           (np.nan_to_num(rugosidad_m) > NO_TRANSITABLE_RUGOSIDAD_M)
    return np.where(sin_dato, NODATA_MASCARA, malo).astype("uint8")


# ---------------------------------------------------------------------------
# Procesamiento por bloques
# ---------------------------------------------------------------------------
def leer(src, ventana):
    return src.read(1, window=ventana, masked=True).astype("float64").filled(np.nan)


def procesar(carpeta):
    dtm_path, slope_path = carpeta / "dtm.tif", carpeta / "slope.tif"
    for p in (dtm_path, slope_path):
        if not p.exists():
            raise SystemExit(f"Falta {p}. Corré antes pipeline/precompute.py para ese sitio.")

    t0 = time.time()
    with rasterio.open(dtm_path) as dsrc, rasterio.open(slope_path) as ssrc:
        if (dsrc.width, dsrc.height) != (ssrc.width, ssrc.height):
            raise SystemExit("dtm.tif y slope.tif no tienen la misma grilla")
        px = abs(dsrc.transform.a)                      # tamaño de píxel en metros
        nt = impar(VENTANA_TENDENCIA_M / px)
        nr = impar(VENTANA_RUGOSIDAD_M / px)
        halo = nt // 2 + nr // 2 + 1                    # borde extra para que no haya costuras
        W, H = dsrc.width, dsrc.height
        print(f"DTM {W}x{H} px de {px:.2f} m | ventanas: tendencia {nt} px, rugosidad {nr} px", flush=True)

        base = dsrc.profile.copy()
        base.update(driver="GTiff", tiled=True, blockxsize=512, blockysize=512,
                    compress="deflate", BIGTIFF="IF_SAFER")
        perfil_f = {**base, "dtype": "float32", "nodata": np.nan, "predictor": 3}
        perfil_m = {**base, "dtype": "uint8", "nodata": NODATA_MASCARA, "predictor": 2}

        n_validos = n_imp = 0
        cortes = [1.1, 1.2, 1.5, 1.8]
        conteo_eta = np.zeros(len(cortes), dtype=np.int64)   # η en [1.1,1.2), [1.2,1.5), [1.5,1.8), =1.8
        total_bloques = ((H + BLOQUE - 1) // BLOQUE) * ((W + BLOQUE - 1) // BLOQUE)
        hechos = 0

        with rasterio.open(carpeta / "roughness.tif", "w", **perfil_f) as o_rug, \
             rasterio.open(carpeta / "terrain_factor.tif", "w", **perfil_f) as o_eta, \
             rasterio.open(carpeta / "impassable.tif", "w", **perfil_m) as o_imp:
            for fila in range(0, H, BLOQUE):
                for col in range(0, W, BLOQUE):
                    h, w = min(BLOQUE, H - fila), min(BLOQUE, W - col)
                    v = Window(col, fila, w, h)
                    r0, c0 = max(fila - halo, 0), max(col - halo, 0)
                    r1, c1 = min(fila + h + halo, H), min(col + w + halo, W)
                    z = leer(dsrc, Window(c0, r0, c1 - c0, r1 - r0))

                    rug = rugosidad_pura(z, nt, nr)[fila - r0:fila - r0 + h, col - c0:col - c0 + w]
                    pend = leer(ssrc, v)
                    eta = factor_terreno(rug)
                    imp = no_transitable(pend, rug)

                    o_rug.write(rug.astype("float32"), 1, window=v)
                    o_eta.write(eta.astype("float32"), 1, window=v)
                    o_imp.write(imp, 1, window=v)

                    ok = imp != NODATA_MASCARA
                    n_validos += int(ok.sum())
                    n_imp += int((imp == 1).sum())
                    e = eta[ok & ~np.isnan(eta)]
                    conteo_eta += np.array([((e >= 1.1) & (e < 1.2)).sum(), ((e >= 1.2) & (e < 1.5)).sum(),
                                            ((e >= 1.5) & (e < 1.8)).sum(), (e >= 1.8).sum()])
                    hechos += 1
                    if hechos % 20 == 0 or hechos == total_bloques:
                        print(f"  bloques {hechos}/{total_bloques}", flush=True)

    resumen = {
        "pixeles_validos": n_validos,
        "pct_no_transitable": round(100 * n_imp / max(n_validos, 1), 2),
        "pct_eta": {k: round(100 * int(c) / max(n_validos, 1), 2) for k, c in
                    zip(["1.1-1.2", "1.2-1.5", "1.5-1.8", "1.8"], conteo_eta)},
    }
    escribir_metadatos(carpeta, px, resumen)
    print(f"Listo en {(time.time() - t0) / 60:.1f} min -> {carpeta}")
    print(f"  No transitable: {resumen['pct_no_transitable']} % del terreno")
    for k, val in resumen["pct_eta"].items():
        print(f"  η {k:8s}: {val:6.2f} %")


def escribir_metadatos(carpeta, px, resumen):
    meta = {
        "badge": "MRO HiRISE · DERIVED",
        "fuente": "DTM HiRISE (MRO) del sitio, vía pipeline/precompute.py",
        "pixel_m": px,
        "notas": [
            "Solo geometría del terreno: no incluye gravedad, traje ni carga.",
            "La pendiente NO está en terrain_factor: en Pandolf entra como el grado G, que se calcula sobre la ruta con dtm.tif (G = 100·Δz/Δd, con signo).",
            "La rugosidad por debajo de ~0.1-0.3 m está en el nivel de ruido del DTM (precisión vertical de decenas de cm).",
            "El DTM no distingue el material (roca firme vs arena suelta): η mide solo irregularidad geométrica.",
            "Cerca de zonas sin dato, las ventanas usan solo las celdas válidas (menos muestras, algo menos confiable).",
        ],
        "capas": {
            "roughness": {
                "archivo": "roughness.tif", "unidad": "m", "tipo": "float32", "nodata": "NaN",
                "metodo": f"desvío estándar en ventana de {VENTANA_RUGOSIDAD_M} m de (z - promedio en ventana de {VENTANA_TENDENCIA_M} m)",
            },
            "terrain_factor": {
                "archivo": "terrain_factor.tif", "unidad": "adimensional (η de Pandolf)", "tipo": "float32", "nodata": "NaN",
                "metodo": "interpolación lineal de la rugosidad entre anclas, saturada en los extremos",
                "anclas_rugosidad_m": RUGOSIDAD_ANCLAS_M, "valores_eta": ETA_VALORES,
                "equivalente_pandolf": ["camino de tierra", "matorral liviano", "matorral denso", "pantano"],
                "leyenda": [
                    {"valor": 1.1, "color": "#1a9850", "etiqueta": "Liso (≈ camino de tierra)"},
                    {"valor": 1.2, "color": "#a6d96a", "etiqueta": "Algo irregular"},
                    {"valor": 1.5, "color": "#fdae61", "etiqueta": "Irregular, esquivar obstáculos"},
                    {"valor": 1.8, "color": "#d73027", "etiqueta": "Bloques / escalones ~1 m"},
                ],
            },
            "impassable": {
                "archivo": "impassable.tif", "unidad": "0/1", "tipo": "uint8", "nodata": NODATA_MASCARA,
                "regla": f"1 si pendiente > {NO_TRANSITABLE_PENDIENTE_DEG}° o rugosidad > {NO_TRANSITABLE_RUGOSIDAD_M} m",
                "leyenda": [
                    {"valor": 0, "color": "#00000000", "etiqueta": "Transitable"},
                    {"valor": 1, "color": "#7f0000", "etiqueta": "No transitable a pie"},
                ],
            },
        },
        "resumen": resumen,
    }
    (carpeta / "terrain_layers.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description="Capas de terreno para EVA (entradas de Pandolf)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--site", help="id del sitio: usa /data/output/<site>/")
    g.add_argument("--dir", help="carpeta con dtm.tif y slope.tif (también recibe las salidas)")
    args = ap.parse_args()
    carpeta = Path(args.dir).expanduser() if args.dir else DATA_DIR / "output" / args.site
    procesar(carpeta)


if __name__ == "__main__":
    main()