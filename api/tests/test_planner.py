"""POST /api/route: planificador 4D (api/planner.py) con rasters sintéticos."""
import heapq
import math
from pathlib import Path

import numpy as np
import pytest

from api import planner
from api.planner import Grid, astar

from .rasters import N, band_time, iso, latlon, manifest, write_shadow_stack, write_terrain

ROW = 100
A, B = latlon(ROW, 40), latlon(ROW, 160)   # ~570 m en línea recta, de oeste a este


def request(depart: float, waypoints=None) -> dict:
    wps = waypoints or [A, B]
    return {"site": "jezero", "depart_utc": iso(depart),
            "waypoints": [{"lat": la, "lon": lo, "task": None, "dwell_min": 0} for la, lo in wps]}


def path_rows(leg: dict) -> list[int]:
    """Fila de la grilla de cada punto de la ruta (inverso de latlon)."""
    from .rasters import LAT0, PX, R, Y0
    return [round((Y0 - R * math.radians(lat)) / PX - 0.5) for _, lat in leg["coordinates"]]


@pytest.fixture
def site(data_dir, write_manifest):
    write_manifest(manifest())
    return data_dir


def flat(value=2.0):
    return np.full((N, N), value, dtype=np.float32)


class TestSinDatos:
    def test_sin_manifest_responde_404_para_que_web_use_el_ejemplo(self, client, data_dir):
        res = client.post("/api/route", json=request(band_time(13)))
        assert res.status_code == 404

    def test_sitio_desconocido_responde_404(self, client, site):
        body = request(band_time(13)) | {"site": "olympus"}
        assert client.post("/api/route", json=body).status_code == 404

    def test_sin_pendiente_va_en_linea_recta_y_lo_dice(self, client, site):
        res = client.post("/api/route", json=request(band_time(13)))
        assert res.status_code == 200
        body = res.json()
        leg = body["legs"][0]
        assert leg["class"] == "unknown"
        assert len(leg["coordinates"]) == 2
        assert leg["max_slope"]["value"] is None
        assert "terreno no se evaluó" in body["verdict"]["summary"]
        assert "no se evaluó la luz" in body["verdict"]["summary"]
        assert "profile" not in body

    def test_fecha_invalida_responde_422(self, client, site):
        body = request(band_time(13)) | {"depart_utc": "mañana a la tarde"}
        assert client.post("/api/route", json=body).status_code == 422

    def test_sin_cuerpo_responde_422(self, client, site):
        assert client.post("/api/route").status_code == 422


class TestTerreno:
    def test_terreno_plano_va_derecho_y_es_go(self, client, site):
        write_terrain(site, flat(), dtm=np.zeros((N, N), dtype=np.float32))
        write_shadow_stack(site)
        body = client.post("/api/route", json=request(band_time(13))).json()
        leg = body["legs"][0]
        assert leg["class"] == "ok"
        assert set(path_rows(leg)) == {ROW}
        assert leg["distance"]["value"] == pytest.approx(120 * 5 * math.cos(math.radians(18.44)), rel=0.02)
        assert leg["distance"]["provenance"] == "DERIVED"
        assert leg["duration"]["provenance"] == "MODELED"
        assert leg["max_slope"]["value"] == pytest.approx(2.0)
        assert body["verdict"]["status"] == "GO"
        assert body["stops"][0]["arrive_utc"] is None
        assert body["stops"][-1]["depart_utc"] is None
        assert body["stops"][-1]["dose_accumulated"]["mission"] == "MSL"
        assert "profile" in body
        assert "Ojo" not in body["verdict"]["summary"]

    def test_esquiva_una_pared_por_el_hueco(self, client, site):
        slope = flat()
        slope[:, 100] = 40.0          # pared de norte a sur
        slope[60:64, 100] = 2.0       # con un paso angosto al norte
        write_terrain(site, slope)
        leg = client.post("/api/route", json=request(band_time(13))).json()["legs"][0]
        assert leg["class"] == "ok"
        assert min(path_rows(leg)) <= 63

    def test_pared_completa_es_no_go_por_terreno(self, client, site):
        slope = flat()
        slope[:, 100] = 40.0
        write_terrain(site, slope)
        body = client.post("/api/route", json=request(band_time(13))).json()
        assert body["legs"][0]["class"] == "blocked"
        assert body["verdict"]["status"] == "NO_GO"
        assert body["verdict"]["limiting_factor"] == "terrain"

    def test_pendiente_sin_dato_marca_el_tramo_unknown(self, client, site):
        slope = flat()
        slope[:, 90:110] = -9999.0
        write_terrain(site, slope)
        leg = client.post("/api/route", json=request(band_time(13))).json()["legs"][0]
        assert leg["class"] == "unknown"

    def test_punto_fuera_del_dtm_degrada_a_linea_recta(self, client, site):
        write_terrain(site, flat())
        far = latlon(ROW, N + 50)
        body = client.post("/api/route", json=request(band_time(13), [A, far])).json()
        leg = body["legs"][0]
        assert leg["class"] == "unknown"
        assert any("fuera del DTM" in a for a in leg["distance"]["assumptions"])


class TestCuatroD:
    """La sombra pesa según la hora a la que se llega a cada celda."""

    @pytest.fixture
    def sombra_al_mediodia(self, site):
        write_terrain(site, flat())
        shadow = np.ones((N, N), dtype=np.uint8)
        shadow[90:111, 80:121] = 0    # mancha de sombra sobre la línea recta, solo en la banda 13
        write_shadow_stack(site, {13: shadow})
        return site

    def test_a_la_hora_de_la_sombra_la_rodea(self, client, sombra_al_mediodia):
        leg = client.post("/api/route", json=request(band_time(13))).json()["legs"][0]
        assert min(path_rows(leg)) < 90 or max(path_rows(leg)) > 110
        assert leg["shadow_fraction"]["value"] == 0

    def test_una_hora_despues_va_derecho(self, client, sombra_al_mediodia):
        leg = client.post("/api/route", json=request(band_time(14))).json()["legs"][0]
        assert set(path_rows(leg)) == {ROW}

    def test_sombra_sin_dato_no_se_cuenta_como_sombra(self, client, site):
        write_terrain(site, flat())
        write_shadow_stack(site, {13: np.full((N, N), 255, dtype=np.uint8)})
        leg = client.post("/api/route", json=request(band_time(13))).json()["legs"][0]
        assert set(path_rows(leg)) == {ROW}
        assert leg["shadow_fraction"]["value"] is None

    def test_salir_antes_del_amanecer_es_no_go(self, client, site):
        write_terrain(site, flat())
        write_shadow_stack(site)
        body = client.post("/api/route", json=request(band_time(4))).json()
        assert body["verdict"]["status"] == "NO_GO"
        assert body["verdict"]["limiting_factor"] == "daylight"

    def test_ignora_la_carpeta_de_trabajo_del_pipeline(self, client, site):
        write_terrain(site, flat())
        write_shadow_stack(site)
        (site / "output" / "jezero" / "illumination" / "_work").mkdir()
        body = client.post("/api/route", json=request(band_time(13))).json()
        assert "shadow_fraction" in body["legs"][0]


def test_astar_reevalua_sombra_en_el_punto_medio_del_paso():
    grid = Grid(np.zeros((3, 3), dtype=np.float32), np.zeros((3, 3), dtype=np.int8), None, None, 5.0, 5.0)

    class FakeShadow:
        def at(self, t, v):
            r, c = divmod(v, 3)
            if (r, c) in {(1, 0), (1, 1), (1, 2)} and t < 3600.0:
                return planner.SHADOW
            return 1

    found = planner.astar(grid, (1, 0), (1, 2), 0.0, speed=0.001, shadow=FakeShadow())
    assert found is not None
    assert all((r, c) != (1, 1) for r, c in found[0][1:-1])


class TestEstaciones:
    def test_la_espera_consume_y_corre_el_reloj(self, client, site):
        write_terrain(site, flat())
        mid = latlon(ROW, 100)
        req = request(band_time(13), [A, mid, B])
        sin = client.post("/api/route", json=req).json()
        req["waypoints"][1]["dwell_min"] = 30
        con = client.post("/api/route", json=req).json()
        assert sin["stops"][1]["arrive_utc"] == con["stops"][1]["arrive_utc"]
        assert con["stops"][2]["arrive_utc"] > sin["stops"][2]["arrive_utc"]
        assert con["stops"][2]["o2_remaining"]["value"] < sin["stops"][2]["o2_remaining"]["value"]


def test_route_consumables_usa_dwell_min_para_reducir_o2(client):
    mid = latlon(ROW, 100)
    base = {
        "site_id": "jezero",
        "points": [
            {"lat": A[0], "lon": A[1], "elev_m": 0.0},
            {"lat": mid[0], "lon": mid[1], "elev_m": 0.0, "dwell_min": 30.0},
            {"lat": B[0], "lon": B[1], "elev_m": 0.0},
        ],
        "speed_m_s": 1.0,
        "cargo_kg": 0.0,
        "sample_step_m": 10.0,
    }
    sin = client.post("/api/route/consumables", json={**base, "points": [
        {"lat": A[0], "lon": A[1], "elev_m": 0.0},
        {"lat": mid[0], "lon": mid[1], "elev_m": 0.0},
        {"lat": B[0], "lon": B[1], "elev_m": 0.0},
    ]}).json()
    con = client.post("/api/route/consumables", json=base).json()
    assert con["totals"]["duration_s"] > sin["totals"]["duration_s"]
    assert con["totals"]["o2_kg"] > sin["totals"]["o2_kg"]


def test_plan_route_advertencia_si_o2_no_llega_al_objetivo(site):
    write_terrain(site, flat())
    write_shadow_stack(site)
    out = planner.plan_route(
        "jezero",
        iso(band_time(13)),
        [{"lat": A[0], "lon": A[1], "task": None, "dwell_min": 0},
         {"lat": B[0], "lon": B[1], "task": None, "dwell_min": 0}],
        site,
        Path(__file__).resolve().parents[2],
        params=planner.SuitParams(o2_capacity_kg=1e-6, battery_capacity_wh=1e9),
    )
    assert any("O2" in w and "objetivo" in w.lower() for w in out["verdict"]["warnings"])


def _dijkstra_cost(grid: Grid, start, goal, speed=planner.SPEED_M_S) -> float:
    """Referencia sin heurística, con el mismo costo que astar() sin sombra."""
    rows, cols = grid.cls.shape
    fac = np.array(planner.SLOPE_FACTOR + (planner.UNKNOWN_SLOPE_FACTOR,))[grid.cls]
    stretch = 1 / np.cos(np.radians(np.nan_to_num(grid.slope)))
    dd = math.hypot(grid.dx_m, grid.dy_m)
    moves = [(0, 1, grid.dx_m), (0, -1, grid.dx_m), (1, 0, grid.dy_m), (-1, 0, grid.dy_m),
             (1, 1, dd), (1, -1, dd), (-1, 1, dd), (-1, -1, dd)]
    best = {start: 0.0}
    heap = [(0.0, start)]
    while heap:
        g, (r, c) = heapq.heappop(heap)
        if (r, c) == goal:
            return g
        if g > best[(r, c)]:
            continue
        for dr, dc, L in moves:
            v = (r + dr, c + dc)
            if not (0 <= v[0] < rows and 0 <= v[1] < cols):
                continue
            f = fac[v]
            if f == math.inf:
                if v != goal:
                    continue
                f = planner.SLOPE_FACTOR[2]
            ng = g + L * stretch[v] / speed * f
            if ng < best.get(v, math.inf):
                best[v] = ng
                heapq.heappush(heap, (ng, v))
    return math.inf


def _path_cost(grid: Grid, path, speed=planner.SPEED_M_S) -> float:
    fac = np.array(planner.SLOPE_FACTOR + (planner.UNKNOWN_SLOPE_FACTOR,))[grid.cls]
    stretch = 1 / np.cos(np.radians(np.nan_to_num(grid.slope)))
    total = 0.0
    for (r0, c0), (r1, c1) in zip(path, path[1:]):
        L = math.hypot((r1 - r0) * grid.dy_m, (c1 - c0) * grid.dx_m)
        f = fac[r1, c1] if fac[r1, c1] != math.inf else planner.SLOPE_FACTOR[2]
        total += L * stretch[r1, c1] / speed * f
    return total


@pytest.mark.parametrize("seed", range(5))
def test_astar_da_el_costo_optimo(seed):
    rng = np.random.default_rng(seed)
    slope = rng.uniform(0, 35, size=(40, 40))
    slope[rng.random((40, 40)) < 0.05] = np.nan
    cls = np.full(slope.shape, -1, dtype=np.int8)
    known = np.isfinite(slope)
    cls[known] = np.searchsorted(planner.SLOPE_CUTS, slope[known], side="right")
    grid = Grid(slope, cls, None, None, 4.7, 5.0)
    start, goal = (0, 0), (39, 39)
    found = astar(grid, start, goal, 0.0)
    ref = _dijkstra_cost(grid, start, goal)
    if ref == math.inf:
        assert found is None
    else:
        assert _path_cost(grid, found[0]) == pytest.approx(ref)
