"""Zona con contacto por radio con el hábitat: desde dónde hay línea de vista.

Lo consume GET /api/sites/{site}/viewshed y lo dibuja la capa `habitat-contact` de
web/. Es la misma geometría que el límite "minutos seguidos sin contacto" del
planificador (api/contact.py), evaluada en una grilla alrededor del hábitat en vez
de sobre la ruta: si una celda sale sin contacto acá, caminar por ahí suma minutos
a la racha.

No se precomputa en el pipeline porque depende de dónde pone el hábitat el usuario.
Una lectura promediada del DTM + ~60 000 rayos en numpy: medio segundo.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from .contact import ASSUMPTIONS as CONTACT_ASSUMPTIONS
from .contact import MAX_MARGIN_M, ContactField
from .terrain import MARS_LONGLAT

RADIUS_M = MAX_MARGIN_M   # el mismo alcance que la línea de vista del planificador
GRID_SIDE = 241           # celdas por lado: 6 km / 241 ≈ 25 m

# Clases de la grilla (0 = fuera del círculo, no se dibuja).
CONTACT, NO_CONTACT, UNKNOWN = 1, 2, 3
CLASS_NAME = {CONTACT: "contact", NO_CONTACT: "no_contact", UNKNOWN: "unknown"}


class HabitatOutsideDtm(ValueError):
    """El hábitat cae fuera del DTM o en un hueco: no hay desde dónde trazar rayos."""


def classify(field: ContactField, radius_m: float = RADIUS_M, side: int = GRID_SIDE):
    """Grilla `side` × `side` centrada en el hábitat, en el CRS del DTM.

    Devuelve (clases uint8, Affine de la grilla, tamaño de celda en m)."""
    from rasterio.transform import Affine

    cell_m = 2 * radius_m / side
    step_y = cell_m / field.unit_m
    # En un CRS en grados, un grado de longitud mide cos(lat) sobre el suelo.
    if field.crs is not None and not field.crs.is_projected:
        step_x = step_y / max(math.cos(math.radians(field.hy)), 0.1)
    else:
        step_x = step_y
    x0 = field.hx - side / 2 * step_x
    y0 = field.hy + side / 2 * step_y
    transform = Affine(step_x, 0, x0, 0, -step_y, y0)

    idx = np.arange(side) + 0.5
    xs = x0 + idx[None, :] * step_x + np.zeros((side, 1))
    ys = y0 - idx[:, None] * step_y + np.zeros((1, side))
    vis = field.visible_xy(xs, ys).reshape(side, side)

    out = np.where(vis == 1, CONTACT, np.where(vis == 0, NO_CONTACT, UNKNOWN)).astype(np.uint8)
    d = np.hypot((idx[None, :] - side / 2), (idx[:, None] - side / 2)) * cell_m
    out[d > radius_m] = 0
    return out, transform, cell_m


def polygons(classes: np.ndarray, transform, crs) -> dict:
    """GeoJSON en lon/lat de Marte, un Feature por polígono con su `class`."""
    from rasterio.features import shapes
    from rasterio.warp import transform_geom

    features = []
    for geom, value in shapes(classes, mask=classes > 0, transform=transform, connectivity=4):
        g = transform_geom(crs, MARS_LONGLAT, geom, precision=6)
        features.append({"type": "Feature", "properties": {"class": CLASS_NAME[int(value)]},
                         "geometry": g})
    return {"type": "FeatureCollection", "features": features}


def viewshed(dtm_path: Path, lat: float, lon: float, radius_m: float = RADIUS_M) -> dict:
    """Polígonos con y sin contacto, fracciones y procedencia.

    Levanta HabitatOutsideDtm si el hábitat no tiene elevación."""
    import rasterio

    with rasterio.open(dtm_path) as ds:
        field = ContactField.from_dtm(ds, (lat, lon), [(lat, lon)], margin_m=radius_m)
    if field is None:
        raise HabitatOutsideDtm("El hábitat cae fuera del DTM: no se puede calcular la línea de vista.")

    classes, transform, cell_m = classify(field, radius_m)
    inside = classes > 0
    total = int(inside.sum()) or 1
    fractions = {name: round(float((classes == k).sum()) / total, 3) for k, name in CLASS_NAME.items()}
    return {
        "radius_m": radius_m,
        "cell_m": round(cell_m, 1),
        "fractions": fractions,
        "geojson": polygons(classes, transform, field.crs),
        "source": {
            "provenance": "MODELED",
            "mission": "MRO",
            "instrument": "HiRISE DTM",
            "resolution": f"celdas de {cell_m:.0f} m sobre el {field.resolution}",
            "source": "Línea de vista al hábitat sobre el DTM (api/contact.py), la misma que usa el planificador",
            "assumptions": CONTACT_ASSUMPTIONS + [
                f"Se evalúa hasta {radius_m / 1000:g} km del hábitat",
                "Sin dato = no se sabe: el planificador no lo cuenta como límite roto, pero avisa",
            ],
        },
    }
