"""Sombras sobre terrenos sintéticos con resultado conocido."""
import math

import numpy as np
import pytest

import terrain_shadows as ts

# Grilla de 1 m, columnas hacia el este y filas hacia el sur.
JAC_1M = np.array([[1.0, 0.0], [0.0, -1.0]])


def lit_mask(z, jac, az, el):
    """Arma la máscara completa a partir de los bloques de sweep_lit."""
    plan = ts.sweep_plan(jac, az)
    tan_el = math.tan(math.radians(el))
    z = np.where(np.isfinite(z), z, -np.inf).astype(np.float32)
    out = np.zeros(z.shape, dtype=bool)
    if plan.axis == 0:
        for i0, i1, lit in ts.sweep_lit(lambda a, b: z[a:b], z.shape[0], z.shape[1], plan, tan_el, block=7):
            out[i0:i1] = lit
    else:
        for i0, i1, lit in ts.sweep_lit(lambda a, b: np.ascontiguousarray(z[:, a:b].T), z.shape[1],
                                        z.shape[0], plan, tan_el, block=7):
            out[:, i0:i1] = lit.T
    return out


def ridge(n=100, col=50, h=10.0):
    z = np.zeros((n, n), dtype=np.float32)
    z[:, col] = h
    return z


class TestNearShadows:
    def test_flat_terrain_is_all_lit(self):
        assert lit_mask(np.zeros((40, 40)), JAC_1M, 123.0, 5.0).all()

    def test_ridge_with_sun_from_east_shadows_west(self):
        # Cresta de 10 m, Sol al este a 30°: sombra de 10 / tan 30° = 17.3 m hacia el oeste.
        lit = lit_mask(ridge(), JAC_1M, 90.0, 30.0)
        row = lit[50]
        assert not row[33:50].any()
        assert row[:33].all() and row[50:].all()

    def test_ridge_with_sun_from_west_shadows_east(self):
        lit = lit_mask(ridge(), JAC_1M, 270.0, 30.0)
        row = lit[50]
        assert not row[51:68].any()
        assert row[68:].all() and row[:51].all()

    def test_pillar_with_diagonal_sun(self):
        # Pilar de 20 m, Sol al noreste a 45°: la sombra va al suroeste, 20 m sobre el suelo.
        z = np.zeros((80, 80), dtype=np.float32)
        z[30, 50] = 20.0
        lit = lit_mask(z, JAC_1M, 45.0, 45.0)
        for k in range(1, 14):  # k·√2 < 20
            assert not lit[30 + k, 50 - k]
        assert lit[30 + 16, 50 - 16]
        assert lit[30 - 5, 50 + 5]  # del lado del Sol, al sol

    def test_anisotropic_pixels(self):
        # Píxeles de 0.5 m en el eje este: la misma sombra de 17.3 m ocupa el doble de columnas.
        jac = np.array([[0.5, 0.0], [0.0, -1.0]])
        lit = lit_mask(ridge(n=120, col=80), jac, 90.0, 30.0)
        row = lit[60]
        assert not row[46:80].any()
        assert row[:45].all()

    def test_sun_below_horizon_is_handled_by_caller_and_low_sun_shadows_more(self):
        low = lit_mask(ridge(), JAC_1M, 90.0, 5.0)
        high = lit_mask(ridge(), JAC_1M, 90.0, 60.0)
        assert low.sum() < high.sum()

    def test_nodata_does_not_cast_shadow(self):
        z = ridge()
        z[:, 50] = np.nan
        assert lit_mask(z, JAC_1M, 90.0, 10.0)[50, :50].all()

    def test_sun_facing_slope_lit_and_steep_back_slope_self_shadowed(self):
        # Rampa que sube hacia el este a 20°: la cara mira al oeste. Con Sol al oeste a 10°
        # está al sol; con Sol al este a 10° (menos que la pendiente) queda en sombra propia.
        x = np.arange(60, dtype=np.float32)
        z = np.tile(x * math.tan(math.radians(20)), (30, 1))
        assert lit_mask(z, JAC_1M, 270.0, 10.0)[15].all()
        assert not lit_mask(z, JAC_1M, 90.0, 10.0)[15, :-1].any()


class TestGeometry:
    def test_curvature_drop(self):
        drop = ts.curvature_drop(np.array([0.0]), np.array([1000.0]), JAC_1M, (0.0, 0.0))
        assert drop[0] == pytest.approx(1000.0 ** 2 / (2 * ts.MARS_RADIUS_M))

    def test_ground_jacobian_equirectangular(self):
        # Equirectangular con lat_ts=0 a 60° de latitud: el píxel este-oeste mide la mitad.
        deg_per_m = math.degrees(1 / ts.MARS_RADIUS_M)

        def pix_to_lonlat(cols, rows):
            return cols * deg_per_m, 60.0 - rows * deg_per_m

        jac = ts.ground_jacobian(pix_to_lonlat, 0.0, 0.0)
        assert jac[0, 0] == pytest.approx(0.5, rel=1e-3)
        assert jac[1, 1] == pytest.approx(-1.0, rel=1e-6)

    def test_destination_east_along_equator(self):
        lat, lon = ts.destination(np.array([0.0]), np.array([0.0]), 90.0, np.array([1000.0]))
        assert lat[0, 0] == pytest.approx(0.0, abs=1e-9)
        assert lon[0, 0] == pytest.approx(math.degrees(1000.0 / ts.MARS_RADIUS_M))


class TestFarHorizon:
    def test_wall_outside_dtm(self):
        # Pared de 500 m entre 0.10° y 0.11° de longitud al este; el resto, sin DEM.
        def sample_dem(lat, lon):
            return np.where((lon >= 0.10) & (lon <= 0.11), 500.0, np.nan)

        def covered(lat, lon):
            return np.zeros(lat.shape, dtype=bool)

        dist = np.arange(50.0, 20000.0, 50.0)
        tan, dstar = ts.far_horizon_tan(np.array([0.0]), np.array([0.0]), np.array([0.0]),
                                        sample_dem, covered, 90.0, dist)
        d_wall = math.radians(0.10) * ts.MARS_RADIUS_M
        assert dstar[0] == pytest.approx(d_wall, abs=50.0)
        assert tan[0] == pytest.approx((500.0 - dstar[0] ** 2 / (2 * ts.MARS_RADIUS_M)) / dstar[0], rel=1e-9)
        tan_w, _ = ts.far_horizon_tan(np.array([0.0]), np.array([0.0]), np.array([0.0]),
                                      sample_dem, covered, 270.0, dist)
        assert tan_w[0] == -np.inf

    def test_terrain_covered_by_dtm_is_ignored(self):
        def sample_dem(lat, lon):
            return np.full(lat.shape, 500.0)

        def covered(lat, lon):
            return np.ones(lat.shape, dtype=bool)

        tan, dstar = ts.far_horizon_tan(np.array([0.0]), np.array([0.0]), np.array([0.0]),
                                        sample_dem, covered, 0.0, np.arange(100.0, 1000.0, 100.0))
        assert tan[0] == -np.inf and dstar[0] == np.inf

    def test_height_correction_and_azimuth_interpolation(self):
        def sample_dem(lat, lon):
            return np.where(lon >= 0.10, 500.0, np.nan)

        dist = np.arange(100.0, 10000.0, 100.0)
        fh = ts.build_far_horizon(np.zeros(1), np.zeros(1), np.zeros(1), (1, 1), np.array([0.0]),
                                  np.array([0.0]), sample_dem, lambda la, lo: np.zeros(la.shape, bool),
                                  dist, az_step_deg=1.0)
        a, b = fh.at_azimuth(90.0)
        z = np.array([[100.0]])
        t = fh.tan_at(a, b, np.array([0.0]), np.array([0.0]), z)
        d = dist[dist >= math.radians(0.10) * ts.MARS_RADIUS_M][0]  # primera muestra sobre la pared
        # Un observador 100 m más alto ve la pared 100/d más baja.
        assert t[0, 0] == pytest.approx((500.0 - 100.0 - d * d / (2 * ts.MARS_RADIUS_M)) / d, rel=1e-3)
