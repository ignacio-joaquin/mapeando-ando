"""Refugios: sky-view, máscara, costo de Tobler, minutos y una corrida completa sintética."""
import json
import math

import numpy as np
import pytest

import shelter

JAC_10M = np.array([[10.0, 0.0], [0.0, -10.0]])   # píxel de 10 m, filas hacia el sur


def svf_of(z, radius_m=200.0, directions=16):
    rays = shelter.ray_offsets(JAC_10M, directions, radius_m)
    halo = max(abs(dr) for ray in rays for dr, _, _ in ray)
    zp = np.full((z.shape[0] + 2 * halo, z.shape[1]), -np.inf, dtype=np.float32)
    zp[halo:halo + z.shape[0]] = z
    return shelter.sky_view(zp, halo, rays)


class TestSkyView:
    def test_flat_sees_the_whole_sky(self):
        svf = svf_of(np.zeros((60, 60), np.float32))
        assert np.nanmin(svf) == pytest.approx(1.0)

    def test_border_has_no_value(self):
        svf = svf_of(np.zeros((60, 60), np.float32))
        assert np.isnan(svf[0, 30]) and np.isnan(svf[30, 0])   # el rayo sale del DTM
        assert np.isfinite(svf[30, 30])

    def test_hole_on_the_ray_leaves_no_value(self):
        z = np.zeros((60, 60), np.float32)
        z[30, 35] = -np.inf
        svf = svf_of(z)
        assert np.isnan(svf[30, 30])

    def test_foot_of_a_wall_sees_less_sky(self):
        # pared de 100 m al este de la columna 90; la columna 30 está a 600 m, fuera del radio
        z = np.zeros((60, 120), np.float32)
        z[:, 91:] = 100.0
        svf = svf_of(z)
        foot, far = svf[30, 90], svf[30, 30]
        assert foot < 0.75 < far
        # mitad del cielo tapada casi a 90°: 1 − (8 · sin ~84°)/16 ≈ 0,5; el horizonte ya está a 10 m
        assert foot == pytest.approx(0.55, abs=0.08)

    def test_rays_cover_every_direction_without_repeats(self):
        rays = shelter.ray_offsets(JAC_10M, 16, 500.0)
        assert len(rays) == 16
        for ray in rays:
            offs = [(dr, dc) for dr, dc, _ in ray]
            assert len(offs) == len(set(offs))
            assert max(d for *_, d in ray) == pytest.approx(500.0, rel=0.03)


class TestShelterMask:
    def test_needs_low_sky_walkable_slope_and_size(self):
        svf = np.ones((20, 20), np.float32)
        slope = np.zeros((20, 20), np.float32)
        svf[2:6, 2:6] = 0.7          # 16 celdas: queda
        svf[10, 10] = 0.7            # 1 celda: muy chica
        svf[14:18, 14:18] = 0.7
        slope[14:18, 14:18] = 40.0   # demasiado empinado para pararse
        m = shelter.shelter_mask(svf, slope, 0.85, 30.0, min_px=4)
        assert m[2:6, 2:6].all()
        assert not m[10, 10] and not m[14:18, 14:18].any()

    def test_by_strips_matches_whole_array(self):
        rng = np.random.default_rng(0)
        svf = rng.uniform(0.7, 1.0, (97, 40)).astype(np.float32)
        slope = rng.uniform(0, 40, (97, 40)).astype(np.float32)
        whole = shelter.shelter_mask(svf, slope, 0.85, 30.0, min_px=5)
        out = np.zeros_like(whole)
        shelter.shelter_mask_strips(svf, slope, out, 0.85, 30.0, 5, strip_rows=7)
        assert whole.any() and (out == whole).all()

    def test_nan_is_never_shelter(self):
        svf = np.full((5, 5), np.nan, np.float32)
        assert not shelter.shelter_mask(svf, np.zeros((5, 5)), 0.85, 30.0, 1).any()


def test_block_reduce():
    a = np.arange(36, dtype=np.float32).reshape(6, 6)
    a[0, 0] = -np.inf
    m = shelter.block_reduce(a, 3, np.mean)
    assert m.shape == (2, 2) and np.isneginf(m[0, 0]) and m[1, 1] == a[3:, 3:].mean()
    assert shelter.block_reduce(a > 34, 3, np.any).tolist() == [[False, False], [False, True]]


class TestWalkCost:
    def test_flat_pace_matches_walk_speed(self):
        assert shelter.walk_cost(np.array([0.0]), 30.0)[0] == pytest.approx(1 / shelter.WALK_SPEED_M_S, rel=0.01)

    def test_steeper_is_slower_and_too_steep_blocks(self):
        c = shelter.walk_cost(np.array([0.0, 10.0, 25.0, 31.0, np.nan]), 30.0)
        assert c[0] < c[1] < c[2]
        assert np.isinf(c[3]) and np.isinf(c[4])

    def test_tobler_peaks_slightly_downhill(self):
        v = shelter.tobler_speed(np.array([-0.05, 0.0, 0.05]))
        assert v[0] > v[1] > v[2]
        assert v[1] == pytest.approx(shelter.WALK_SPEED_M_S)


class TestMinutes:
    def test_flat_corridor(self):
        cost = np.full((5, 101), 1 / 0.8)           # 0,8 m/s en plano
        refuge = np.zeros_like(cost, bool)
        refuge[:, 0] = True
        mins = shelter.minutes_to_shelter(cost, refuge, (10.0, 10.0))
        assert mins[2, 0] == 0
        assert mins[2, 100] == pytest.approx(1000 / 0.8 / 60, rel=1e-6)   # 1 km a 0,8 m/s

    def test_wall_forces_a_detour_and_islands_are_unreachable(self):
        cost = np.ones((11, 11))
        cost[:, 5] = np.inf
        cost[10, 5] = 1.0                             # único paso, abajo
        refuge = np.zeros_like(cost, bool)
        refuge[0, 0] = True
        mins = shelter.minutes_to_shelter(cost, refuge, (1.0, 1.0))
        assert mins[0, 6] > mins[0, 4] + 10 / 60     # tiene que bajar y volver a subir
        cost[10, 5] = np.inf
        mins = shelter.minutes_to_shelter(cost, refuge, (1.0, 1.0))
        assert np.isnan(mins[0, 6])

    def test_no_shelter_means_no_minutes(self):
        mins = shelter.minutes_to_shelter(np.ones((3, 3)), np.zeros((3, 3), bool), (1.0, 1.0))
        assert np.isnan(mins).all()


class TestDataNotReady:
    def test_missing_dtm(self, tmp_path):
        assert shelter.main(["--dtm", str(tmp_path / "no.tif"), "--out", str(tmp_path)]) == 2

    def test_dtm_not_downloaded_yet(self, tmp_path, monkeypatch):
        import precompute
        monkeypatch.setattr(precompute, "DATA_DIR", tmp_path)
        monkeypatch.delenv("BUCKET", raising=False)
        monkeypatch.setattr(precompute, "bucket_name", lambda: None)
        (tmp_path / "manifest.json").write_text(json.dumps({"sites": {"jezero": {"files": [
            {"key": "dtm", "status": "error", "path": "raw/jezero/dtm.tif"}]}}}))
        assert shelter.main(["--site", "jezero", "--out", str(tmp_path / "out")]) == 2


def test_full_run_on_synthetic_crater(tmp_path):
    import rasterio
    from rasterio.transform import from_origin

    # Cráter de 1 km de diámetro y 120 m de profundidad, paredes de hasta ~26° (transitables), cerca de Jezero.
    r_m, n, px = 3396190.0, 600, 5.0
    lat0, lon0 = 18.45, 77.45
    yy, xx = np.mgrid[0:n, 0:n] * px
    rr = np.hypot(xx - n * px / 2, yy - n * px / 2)
    z = (-2500 - 120 * np.clip(1 - (rr / 500.0) ** 2, 0, None)).astype(np.float32)
    dtm = tmp_path / "crater.tif"
    x0, y0 = math.radians(lon0) * r_m, math.radians(lat0) * r_m
    with rasterio.open(dtm, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32",
                       crs="+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R=3396190 +units=m +no_defs",
                       transform=from_origin(x0, y0, px, px), nodata=-3.4028226550889045e38) as ds:
        ds.write(z, 1)

    out = tmp_path / "out"
    assert shelter.main(["--dtm", str(dtm), "--out", str(out), "--res", "2", "--walk-res", "4",
                         "--radius-m", "500", "--min-area-m2", "500", "--no-tiles"]) == 0
    d = out
    index = json.loads((d / "shelter.json").read_text())
    assert {k: v["status"] for k, v in index["layers"].items()} == {
        "survival-skyview": "ok", "survival-shelter": "ok", "survival-shelter-minutes": "ok"}
    assert index["layers"]["survival-skyview"]["provenance"] == "DERIVED"
    assert index["mode"] == "completo" and index["warnings"] == []      # forma de terrain.json
    assert not (out / ".shelter-run.work").exists()

    with rasterio.open(d / "skyview.tif") as s, rasterio.open(d / "shelter.tif") as r, \
            rasterio.open(d / "shelter_minutes.tif") as m:
        svf = s.read(1, masked=True)
        refuge = r.read(1, masked=True)
        mins = m.read(1, masked=True)
        assert m.height == s.height // 2                 # minutos en la grilla gruesa
        c = s.height // 2
        # fondo del cráter: el borde a 500 m y 120 m más arriba tapa el cielo, 1 − sin(13°) ≈ 0,77
        assert svf[c, c] == pytest.approx(0.77, abs=0.02)
        assert svf.mask[0, 0]                         # borde: sin horizonte completo
        assert refuge[c, c] == 1
        cm = m.height // 2
        assert mins[cm, cm] == 0
        # en el plano de afuera hace falta caminar: más minutos cuanto más lejos
        ring = cm + int(560 / 20)                     # ~60 m afuera del borde del cráter
        assert 0 < mins[cm, ring] < mins[cm, ring + 3]
