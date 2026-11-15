"""Tablas de color de tiles.py: cortes netos, del lado que dice el pipeline, sin colores inventados."""
import numpy as np
import pytest

import tiles


def color_of(rampa: str, value: float) -> str:
    """Lo que hace gdaldem color-relief -nearest_color_entry con la tabla: la entrada más cercana."""
    entries = [line.split(maxsplit=1) for line in tiles.tabla_de_colores(rampa).splitlines()[1:]]
    values = np.array([float(v) for v, _ in entries])
    return entries[int(np.argmin(np.abs(values - value)))][1]


def rgba(rampa: str, i: int) -> str:
    rgb = tiles.RAMPAS[rampa][i][2]
    return rgb if len(rgb.split()) == 4 else f"{rgb} 255"


@pytest.mark.parametrize("value, tramo", [
    (0.75, 0),                     # shelter.py: fuerte con SVF ≤ 0,75
    (np.float32(0.75), 0),
    (0.7500001, 1),
    (0.85, 1),                     # refugio con ≤ 0,85
    (float(np.float32(0.85)), 1),  # el COG es float32: 0,85 queda en 0,85000002
    (0.8500011, 2),
    (0.0, 0),
])
def test_cielo_includes_the_upper_cut(value, tramo):
    assert color_of("cielo", value) == rgba("cielo", tramo)


@pytest.mark.parametrize("value, tramo", [(25.0, 3), (24.9999, 2), (10.0, 1), (9.9999, 0), (0.0, 0)])
def test_pendiente_includes_the_lower_cut(value, tramo):
    # 25° exactos ya es no transitable (terrain_layers.SLOPE_CUTS_DEG, api/planner.py)
    assert color_of("pendiente", value) == rgba("pendiente", tramo)


@pytest.mark.parametrize("rampa", sorted(tiles.RAMPAS))
def test_only_legend_colors(rampa):
    legend = {rgba(rampa, i) for i in range(len(tiles.RAMPAS[rampa]))}
    lo, hi = tiles.RAMPAS[rampa][0][0], tiles.RAMPAS[rampa][-1][1]
    for v in np.linspace(lo - 1, hi + 1, 5001):
        assert color_of(rampa, float(v)) in legend
