"""Procesa un GeoTIFF de sombra y arma una matriz 2D con paso de 5 m por píxel.

El archivo de salida de `pipeline/illumination.py` tiene una banda por hora LTST con
valores:

- 1 = iluminado
- 0 = sombra
- 255 = sin dato

Este módulo toma esa salida y la convierte en una matriz NumPy booleana donde cada
píxel representa un punto del terreno y dos puntos adyacentes están separados por
`pixel_size_m` metros (por defecto, 5 m).

Ejemplos:

    python pipeline/illumination_matrix.py \
        --tif /data/output/jezero/illumination/20261115T000000Z/shadow_hourly.tif \
        --band 13 \
        --out /data/output/jezero/illumination/20261115T000000Z/solar_12h_mask.npy

    python pipeline/illumination_matrix.py \
        --tif /data/output/jezero/illumination/20261115T000000Z/shadow_hourly.tif \
        --all-bands \
        --out /data/output/jezero/illumination/20261115T000000Z/shadow_stack.npz
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.transform import rowcol

DEFAULT_PIXEL_SIZE_M = 5.0
LIT_VALUE = 1
SHADOW_VALUE = 0
NODATA_VALUE = 255


def band_to_bool_mask(array: np.ndarray, nodata: int = NODATA_VALUE) -> np.ndarray:
    """Convierte una banda de raster a una máscara booleana.

    True = el punto está iluminado, False = no está iluminado o no hay dato.
    """
    mask = np.asarray(array)
    lit = mask == LIT_VALUE
    nodata = mask == nodata
    return np.where(nodata, False, lit)


def load_matrix_from_tif(
    tif_path: str | Path,
    band: int | None = None,
    pixel_size_m: float = DEFAULT_PIXEL_SIZE_M,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Lee una banda o la pila completa del TIFF y devuelve la matriz de iluminación.

    Returns
    -------
    (matrix, metadata)
        matrix: 2D bool para una banda, o 3D bool para todas las bandas.
        metadata: diccionario con tamaño de píxel en metros, forma, bandas, etc.
    """
    tif_path = Path(tif_path)
    with rasterio.open(tif_path) as ds:
        if band is not None:
            if band < 1 or band > ds.count:
                raise ValueError(f"band index out of range: {band} (count={ds.count})")
            data = ds.read(band)
            matrix = band_to_bool_mask(data)
            metadata = {
                "source": str(tif_path),
                "bands": [band],
                "shape": list(matrix.shape),
                "pixel_size_m": float(pixel_size_m),
                "adjacent_distance_m": float(pixel_size_m),
                "dtype": "bool",
                "count": 1,
            }
            return matrix, metadata

        data = ds.read()
        matrix = np.stack([band_to_bool_mask(band_data) for band_data in data], axis=0)
        metadata = {
            "source": str(tif_path),
            "bands": list(range(1, ds.count + 1)),
            "shape": list(matrix.shape),
            "pixel_size_m": float(pixel_size_m),
            "adjacent_distance_m": float(pixel_size_m),
            "dtype": "bool",
            "count": int(ds.count),
        }
        return matrix, metadata


def _normalize_point(point: tuple[float, float] | list[float] | dict[str, float]) -> tuple[float, float]:
    """Normaliza un punto de entrada a (lat, lon)."""
    if isinstance(point, dict):
        if "lat" not in point or "lon" not in point:
            raise ValueError("Un punto debe tener 'lat' y 'lon'.")
        return float(point["lat"]), float(point["lon"])
    if len(point) != 2:
        raise ValueError("Un punto debe ser (lat, lon) o {'lat': ..., 'lon': ...}.")
    return float(point[0]), float(point[1])


def rectangular_window_from_points(
    tif_path: str | Path,
    p1: tuple[float, float] | list[float] | dict[str, float],
    p2: tuple[float, float] | list[float] | dict[str, float],
    *,
    band: int = 1,
    pixel_size_m: float = DEFAULT_PIXEL_SIZE_M,
) -> dict[str, Any]:
    """Recorta una ventana rectangular entre dos puntos geográficos.

    El rectángulo se toma en coordenadas de la grilla del raster, sin importar el orden
    de los puntos. Cada píxel de la ventana representa `pixel_size_m` metros entre dos
    puntos adyacentes.
    """
    lat1, lon1 = _normalize_point(p1)
    lat2, lon2 = _normalize_point(p2)
    tif_path = Path(tif_path)

    with rasterio.open(tif_path) as ds:
        if band < 1 or band > ds.count:
            raise ValueError(f"band index out of range: {band} (count={ds.count})")
        arr = ds.read(band)
        r1, c1 = rowcol(ds.transform, lon1, lat1)
        r2, c2 = rowcol(ds.transform, lon2, lat2)

        r0, r1b = sorted((r1, r2))
        c0, c1b = sorted((c1, c2))
        r0 = max(0, r0)
        c0 = max(0, c0)
        r1b = min(arr.shape[0] - 1, r1b)
        c1b = min(arr.shape[1] - 1, c1b)

        crop = band_to_bool_mask(arr[r0:r1b + 1, c0:c1b + 1])
        return {
            "matrix": crop,
            "pixel_size_m": float(pixel_size_m),
            "adjacent_distance_m": float(pixel_size_m),
            "shape": [int(crop.shape[0]), int(crop.shape[1])],
            "window": {
                "row_start": int(r0),
                "row_end": int(r1b),
                "col_start": int(c0),
                "col_end": int(c1b),
            },
            "points": {
                "p1": {"lat": lat1, "lon": lon1},
                "p2": {"lat": lat2, "lon": lon2},
            },
            "values": crop.astype(bool).tolist(),
        }


def save_matrix(
    matrix: np.ndarray,
    out_path: str | Path,
    metadata: dict[str, Any],
    *,
    compressed: bool = True,
) -> None:
    """Guarda la matriz como `.npy` o `.npz` según la forma de la salida."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if matrix.ndim == 2:
        np.save(out_path, matrix.astype(np.bool_))
        meta_path = out_path.with_suffix(".json")
        meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        return

    if matrix.ndim == 3:
        if compressed:
            np.savez_compressed(out_path, stack=matrix.astype(np.bool_))
        else:
            np.save(out_path, matrix.astype(np.bool_))
        meta_path = out_path.with_suffix(".json")
        meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        return

    raise ValueError(f"No se puede guardar una matriz de dimensión {matrix.ndim}: solo 2D o 3D.")


def build_lit_matrix(
    tif_path: str | Path,
    *,
    band: int | None = None,
    pixel_size_m: float = DEFAULT_PIXEL_SIZE_M,
    out_path: str | Path | None = None,
    all_bands: bool = False,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Construye y opcionalmente guarda la matriz de iluminación.

    Si `band` se especifica, devuelve una matriz 2D de bool y el tamaño de píxel en
    metros. Si `all_bands` es True, devuelve una pila 3D con una máscara por banda.
    """
    if all_bands:
        matrix, metadata = load_matrix_from_tif(tif_path, band=None, pixel_size_m=pixel_size_m)
    else:
        matrix, metadata = load_matrix_from_tif(tif_path, band=band, pixel_size_m=pixel_size_m)

    if out_path is not None:
        save_matrix(matrix, out_path, metadata)

    return matrix, metadata


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tif", required=True, help="Ruta al GeoTIFF de salida de shadow_hourly.tif")
    parser.add_argument("--band", type=int, help="Número de banda a convertir a matriz 2D (1-indexado)")
    parser.add_argument("--all-bands", action="store_true", help="Guarda todas las bandas como una pila 3D")
    parser.add_argument("--out", required=True, help="Ruta del archivo .npy/.npz de salida")
    parser.add_argument("--pixel-size-m", type=float, default=DEFAULT_PIXEL_SIZE_M,
                        help="Distancia en metros entre dos puntos adyacentes del raster (default: 5.0)")
    args = parser.parse_args(argv)

    if args.band is not None and args.all_bands:
        parser.error("No uses --band y --all-bands a la vez")

    matrix, metadata = build_lit_matrix(
        args.tif,
        band=args.band,
        out_path=args.out,
        pixel_size_m=args.pixel_size_m,
        all_bands=args.all_bands,
    )

    print(f"matrix shape: {matrix.shape}")
    print(f"pixel_size_m: {metadata['pixel_size_m']}")
    print(f"adjacent_distance_m: {metadata['adjacent_distance_m']}")
    print(f"lit points: {int(matrix.sum())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
