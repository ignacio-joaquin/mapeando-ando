#!/usr/bin/env python3
"""Capa de dosis de radiación (MSL RAD · MODELED) y datos para el presupuesto de dosis.

Modelo:
  dosis(celda) = D0 × sky_view(celda)
  D0       = dosis absorbida en superficie medida por MSL RAD en Gale (reference/rad_surface_dose.json)
  sky_view = fracción del ángulo sólido del cielo que no tapa el terreno
           = 1 − promedio_azimut( sin(ángulo del horizonte) )
  Supone radiación (GCR) isótropa desde el cielo. El horizonte se busca en 32 direcciones
  hasta ~60 km, con el DTM cerca y el DEM global de 200 m lejos, y con la curvatura de Marte.

Salidas en /data/output/<sitio>/:
  skyview.tif     fracción de cielo visible (0-1), grilla de 100 m
  dose_rate.tif   dosis absorbida, mGy/día, grilla de 100 m (para el planificador)
  radiation.json  rango real de valores, decisión de visualización (capa o presupuesto),
                  tasa por hora para el presupuesto de la travesía, método y limitaciones.

Uso:
  python pipeline/radiation.py --site jezero
"""
import argparse
import json
import math
import os
import time
from pathlib import Path

import numpy as np
import rasterio #!!
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

RADIO_MARTE_M = 3_389_500        # radio medio (issue: distancias con 3389.5 km)
RES_M = 100                      # la dosis no varía a escala de metros
N_AZIMUTS = 32
DIST_MAX_M = 60_000              # hasta dónde se busca el horizonte
N_DISTANCIAS = 200               # muestras por dirección (espaciadas en forma geométrica)
BADGE = "MSL RAD · MODELED"


def sky_view(z_grande, filas, cols, res):
    """Fracción de cielo visible para las celdas (filas, cols) de z_grande (m, NaN = sin dato)."""
    z0 = z_grande[filas, cols]
    H, W = z_grande.shape
    pasos = np.unique(np.round(np.geomspace(1, DIST_MAX_M / res, N_DISTANCIAS)).astype(int)) #.astype?
    suma_sen = np.zeros(z0.shape) #.zeros?
    for k in range(N_AZIMUTS):
        az = 2 * math.pi * k / N_AZIMUTS             # 0 = norte, sentido horario
        dfil, dcol = -math.cos(az), math.sin(az)     # las filas crecen hacia el sur
        hmax = np.zeros(z0.shape)                    # horizonte mínimo: 0° (el plano)
        for p in pasos:
            f = np.round(filas + dfil * p).astype(int)
            c = np.round(cols + dcol * p).astype(int)
            dentro = (f >= 0) & (f < H) & (c >= 0) & (c < W)
            if not dentro.any(): #.any?
                break
            d = p * res
            zs = np.full(z0.shape, np.nan)
            zs[dentro] = z_grande[f[dentro], c[dentro]]
            caida = d * d / (2 * RADIO_MARTE_M)      # curvatura: el terreno lejano "baja"
            with np.errstate(invalid="ignore"):
                ang = np.arctan2(zs - caida - z0, d)
            hmax = np.fmax(hmax, ang)                # fmax ignora NaN
        suma_sen += np.sin(hmax)
    return 1 - suma_sen / N_AZIMUTS


def grilla_combinada(dtm_path, dem200_path, pad_m):
    """DEM de 100 m: DTM (promediado) donde hay, DEM global de 200 m alrededor."""
    with rasterio.open(dtm_path) as dtm:
        crs, b = dtm.crs, dtm.bounds
        x0, y1 = b.left - pad_m, b.top + pad_m
        W = int(math.ceil((b.right - b.left + 2 * pad_m) / RES_M))
        H = int(math.ceil((b.top - b.bottom + 2 * pad_m) / RES_M))
        t = from_origin(x0, y1, RES_M, RES_M)
        z_dtm = np.full((H, W), np.nan, dtype="float64")
        reproject(rasterio.band(dtm, 1), z_dtm, dst_transform=t, dst_crs=crs,
                  dst_nodata=np.nan, resampling=Resampling.average)
        # celdas del área de interés (donde hay DTM)
        roi = (int((b.top - y1) / -RES_M), int((b.left - x0) / RES_M))
        roi_hw = (int(math.ceil((b.top - b.bottom) / RES_M)), int(math.ceil((b.right - b.left) / RES_M)))
    z = z_dtm.copy()
    if dem200_path.exists():
        with rasterio.open(dem200_path) as dem:
            z_dem = np.full((H, W), np.nan, dtype="float64")
            reproject(rasterio.band(dem, 1), z_dem, dst_transform=t, dst_crs=crs,
                      dst_nodata=np.nan, resampling=Resampling.bilinear)
        z = np.where(np.isnan(z), z_dem, z)
    else:
        print(f"AVISO: no encuentro {dem200_path}; el horizonte lejano no se incluye", flush=True)
    return z, z_dtm, t, roi, roi_hw, crs


def procesar(site_id, out_base):
    t0 = time.time()
    site = json.loads((ROOT / "sites" / f"{site_id}.json").read_text())
    ref = json.loads((ROOT / "reference" / "rad_surface_dose.json").read_text())
    D0 = ref["absorbed_dose_mGy_per_day"]["value"]
    D0_err = ref["absorbed_dose_mGy_per_day"]["uncertainty"]
    H0 = ref["dose_equivalent_mSv_per_day"]["value"]

    carpeta = out_base / site_id
    dtm_path = carpeta / "dtm.tif"
    if not dtm_path.exists():
        raise SystemExit(f"Falta {dtm_path}. Corré antes pipeline/precompute.py --site {site_id}")
    dem200_path = DATA_DIR / "raw" / site_id / "dem200_crop.tif"
    pad_m = min(DIST_MAX_M, math.radians(site.get("horizon_pad_deg", 1.0)) * RADIO_MARTE_M)

    z, z_dtm, t, (r0, c0), (h, w), crs = grilla_combinada(dtm_path, dem200_path, pad_m)
    print(f"{site['name']}: grilla {z.shape[1]}x{z.shape[0]} celdas de {RES_M} m, "
          f"área de interés {w}x{h}", flush=True)

    filas, cols = np.mgrid[r0:r0 + h, c0:c0 + w]
    con_dato = ~np.isnan(z_dtm[filas, cols])
    svf = np.full((h, w), np.nan)
    svf[con_dato] = sky_view(z, filas[con_dato], cols[con_dato], RES_M)
    dosis = D0 * svf

    perfil = dict(driver="GTiff", width=w, height=h, count=1, dtype="float32", crs=crs,
                  transform=t * rasterio.Affine.translation(c0, r0), nodata=np.nan,
                  compress="deflate", tiled=True, blockxsize=256, blockysize=256)
    with rasterio.open(carpeta / "skyview.tif", "w", **perfil) as dst:
        dst.write(svf.astype("float32"), 1)
    with rasterio.open(carpeta / "dose_rate.tif", "w", **perfil) as dst:
        dst.write(dosis.astype("float32"), 1)

    v = dosis[con_dato]
    p1, p50, p99 = np.percentile(v, [1, 50, 99])
    variacion_rel = (p99 - p1) / p50
    incert_rel = D0_err / D0
    modo = "presupuesto" if variacion_rel < incert_rel else "capa"

    meta = {
        "badge": BADGE,
        "sitio": site["name"],
        "unidades": {"dose_rate.tif": "mGy/día (dosis absorbida)", "skyview.tif": "fracción 0-1"},
        "grilla_m": RES_M,
        "base": {"dosis_absorbida_mGy_dia": D0, "incertidumbre_mGy_dia": D0_err,
                 "dosis_equivalente_mSv_dia": H0, "fuente": ref["reference"], "periodo": ref["period"]},
        "rango_real": {
            "skyview_min": round(float(np.nanmin(svf)), 4), "skyview_mediana": round(float(np.nanmedian(svf)), 4),
            "dosis_p1_mGy_dia": round(float(p1), 4), "dosis_mediana_mGy_dia": round(float(p50), 4),
            "dosis_p99_mGy_dia": round(float(p99), 4),
            "variacion_relativa_p1_p99": round(float(variacion_rel), 4),
            "incertidumbre_relativa_medicion": round(incert_rel, 4),
        },
        "visualizacion": {
            "modo": modo,
            "regla": "presupuesto si la variación espacial (p1-p99) es menor que la incertidumbre de la medición RAD",
            "escala_colores": "si se muestra el raster, usar escala fija de 0 a D0 (no estirar al rango min-max)",
        },
        "presupuesto": {
            "tasa_mediana_uGy_h": round(float(p50) * 1000 / 24, 2),
            "tasa_equivalente_mediana_uSv_h": round(H0 * float(np.nanmedian(svf)) * 1000 / 24, 2),
            "formula": "dosis_travesía = Σ dose_rate(celda) × horas_en_celda / 24  (mGy)",
            "ejemplo_EVA_4h_uGy": round(float(p50) * 1000 / 24 * 4, 1),
        },
        "limitaciones": [
            "D0 se midió en el piso de Gale (con algo de horizonte propio): se usa como valor de cielo abierto; el error es de pocos %, menor que la incertidumbre de ±19 %.",
            "Supone radiación isótropa; en realidad cerca del horizonte llega menos (más atmósfera), así que el efecto del terreno está sobreestimado: es una cota superior del apantallamiento.",
            "No incluye eventos de partículas solares, ciclo solar ni variación estacional de presión (cambian D0 en el tiempo, no en el espacio).",
            "No incluye secundarios del suelo (neutrones de albedo), que no dependen del sky-view.",
        ],
    }
    (carpeta / "radiation.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    print(f"Listo en {(time.time() - t0) / 60:.1f} min -> {carpeta}")
    print(f"  sky-view: mín {meta['rango_real']['skyview_min']}  mediana {meta['rango_real']['skyview_mediana']}")
    print(f"  dosis (mGy/día): p1 {p1:.4f}  mediana {p50:.4f}  p99 {p99:.4f}")
    print(f"  variación espacial {variacion_rel * 100:.1f} % vs incertidumbre {incert_rel * 100:.0f} % -> modo: {modo.upper()}")
    print(f"  presupuesto: {meta['presupuesto']['tasa_mediana_uGy_h']} µGy/h -> EVA de 4 h ≈ {meta['presupuesto']['ejemplo_EVA_4h_uGy']} µGy")


def main():
    ap = argparse.ArgumentParser(description="Capa de dosis de radiación (MSL RAD · MODELED)")
    ap.add_argument("--site", required=True)
    ap.add_argument("--out", default=str(DATA_DIR / "output"), help="carpeta base de salidas (default /data/output)")
    args = ap.parse_args()
    procesar(args.site, Path(args.out).expanduser())


if __name__ == "__main__":
    main()