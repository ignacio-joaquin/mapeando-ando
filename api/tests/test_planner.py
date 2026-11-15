"""POST /api/route: planificador 4D (api/planner.py) con rasters sintéticos."""
import heapq
import math
from datetime import datetime
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
        assert body["data_quality"] == {
            "terrain_evaluated": False,
            "terrain_source": "missing",
            "light_evaluated": False,
            "light_source": "missing",
        }
        assert body["path_model"] == {
            "algorithm": "A*",
            "cost_function": "Δt · (1 + w_slope·r_slope + w_shadow·r_shadow + w_contact·r_contact)",
            "variables": {
                "step_duration_s": "distancia real / velocidad",
                "slope_term": "pendiente media de la celda / máximo permitido",
                "shadow_term": "1 en sombra, 0 en sol o sin dato",
                "contact_term": "1 sin línea de vista, 0 con línea de vista",
                "weights": {"slope": 2.0, "shadow": 1.0, "contact": 1.0},
            },
        }
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


class TestEstaciones:
    def test_habitat_tres_estaciones_y_vuelta_al_habitat(self, client, site):
        """El "Listo cuando" de MAP-27: la travesía se calcula completa con permanencias."""
        # Con DTM llano: sin DTM el contacto no se evalúa y el veredicto es CAUTION, no GO.
        write_terrain(site, flat(), dtm=np.zeros((N, N), dtype=np.float32))
        write_shadow_stack(site)
        stations = [latlon(ROW, 80), latlon(ROW + 30, 120), latlon(ROW, 160)]
        dwells = [20, 30, 40]
        req = request(band_time(10), [A, *stations, A])
        for wp, (d, task) in zip(req["waypoints"][1:4], zip(dwells, ["muestra", "foto", "perfil"])):
            wp["dwell_min"], wp["task"] = d, task
        res = client.post("/api/route", json=req)
        assert res.status_code == 200
        body = res.json()
        stops = body["stops"]
        assert len(body["legs"]) == 4 and len(stops) == 5
        assert all(leg["class"] == "ok" for leg in body["legs"])
        assert stops[0]["arrive_utc"] is None and stops[-1]["depart_utc"] is None
        utc = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731
        # La salida del tramo siguiente es llegada + permanencia, y el reloj nunca vuelve atrás.
        for stop, d in zip(stops[1:4], dwells):
            assert (utc(stop["depart_utc"]) - utc(stop["arrive_utc"])).total_seconds() == pytest.approx(d * 60, abs=1)
        for prev, nxt in zip(stops[:-1], stops[1:]):
            assert utc(nxt["arrive_utc"]) > utc(prev["depart_utc"])
        # O2 y dosis por estación: el O2 baja y la dosis sube en cada parada.
        o2 = [s["o2_remaining"]["value"] for s in stops]
        assert all(a > b for a, b in zip(o2, o2[1:]))
        assert [s["task"] for s in stops[1:4]] == ["muestra", "foto", "perfil"]
        assert all(s["margin"]["unit"] == "min" for s in stops)
        assert body["verdict"]["status"] == "GO"


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


class TestVeredictoPorReserva:
    """Si un recurso no alcanza, el veredicto culpa al que se agota primero."""

    def plan(self, site, **suit):
        write_terrain(site, flat())
        write_shadow_stack(site)
        wps = [{"lat": la, "lon": lo, "task": None, "dwell_min": 0} for la, lo in (A, B)]
        return planner.plan_route("jezero", iso(band_time(13)), wps, site,
                                  Path(__file__).resolve().parents[2], params=planner.SuitParams(**suit))

    def test_se_agota_el_o2(self, site):
        v = self.plan(site, o2_capacity_kg=1e-6, battery_capacity_wh=1e9)["verdict"]
        assert (v["status"], v["limiting_factor"]) == ("NO_GO", "o2")
        assert "se agota antes de terminar" in v["summary"]

    def test_se_agotan_los_dos_y_la_bateria_primero(self, site):
        # Las dos capacidades no alcanzan; la batería dura mucho menos al ritmo de la travesía.
        v = self.plan(site, o2_capacity_kg=1e-6, battery_capacity_wh=1e-9)["verdict"]
        assert (v["status"], v["limiting_factor"]) == ("NO_GO", "battery")
        assert "se agota antes de terminar" in v["summary"]

    def test_alcanza_pero_sin_reserva(self, site):
        # Batería para la travesía + un 10 %: llega, pero se come la reserva del 20 %.
        full = planner.SuitParams().battery_capacity_wh
        left_pct = self.plan(site)["stops"][-1]["battery_remaining"]["value"]
        used = full * (1 - left_pct / 100)
        v = self.plan(site, o2_capacity_kg=1e9, battery_capacity_wh=used / 0.9)["verdict"]
        assert (v["status"], v["limiting_factor"]) == ("NO_GO", "battery")
        assert "reserva mínima" in v["summary"]
        assert "se agota" not in v["summary"]

    def test_el_veredicto_trae_los_campos_del_contrato(self, site):
        v = self.plan(site)["verdict"]
        assert {"status", "limiting_factor", "summary", "margin"} <= set(v)
        assert {"score", "limits", "robustness"} <= set(v)
        assert {r["id"] for r in v["limits"]} == {"terrain", "o2", "battery", "daylight", "contact",
                                                  "dose", "calories"}


def _costs(grid: Grid, weights: planner.CostWeights, max_slope: float):
    r_slope, r_contact, passable = planner.cell_terms(grid, max_slope)
    fac = 1.0 + weights.slope * r_slope + weights.contact * r_contact
    stretch = 1 / np.cos(np.radians(np.nan_to_num(grid.slope)))
    return fac, stretch, passable


def _dijkstra_cost(grid: Grid, start, goal, weights, max_slope, speed=planner.SPEED_M_S) -> float:
    """Referencia sin heurística, con el mismo costo que astar() sin sombra."""
    rows, cols = grid.cls.shape
    fac, stretch, passable = _costs(grid, weights, max_slope)
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
            if not passable[v] and v != goal:
                continue
            ng = g + L * stretch[v] / speed * fac[v]
            if ng < best.get(v, math.inf):
                best[v] = ng
                heapq.heappush(heap, (ng, v))
    return math.inf


def _path_cost(grid: Grid, path, weights, max_slope, speed=planner.SPEED_M_S) -> float:
    fac, stretch, _ = _costs(grid, weights, max_slope)
    total = 0.0
    for (r0, c0), (r1, c1) in zip(path, path[1:]):
        L = math.hypot((r1 - r0) * grid.dy_m, (c1 - c0) * grid.dx_m)
        total += L * stretch[r1, c1] / speed * fac[r1, c1]
    return total


@pytest.mark.parametrize("seed", range(5))
def test_astar_da_el_costo_optimo(seed):
    rng = np.random.default_rng(seed)
    slope = rng.uniform(0, 35, size=(40, 40))
    slope[rng.random((40, 40)) < 0.05] = np.nan
    cls = np.full(slope.shape, -1, dtype=np.int8)
    known = np.isfinite(slope)
    cls[known] = np.searchsorted(planner.SLOPE_CUTS, slope[known], side="right")
    contact = rng.choice(np.array([1, 0, -1], dtype=np.int8), size=(40, 40), p=[0.6, 0.3, 0.1])
    grid = Grid(slope, cls, None, None, 4.7, 5.0, contact)
    weights, max_slope = planner.CostWeights(slope=2.0, contact=1.5), 25.0
    start, goal = (0, 0), (39, 39)
    found = astar(grid, start, goal, 0.0, weights=weights, max_slope=max_slope)
    ref = _dijkstra_cost(grid, start, goal, weights, max_slope)
    if ref == math.inf:
        assert found is None
    else:
        assert _path_cost(grid, found[0], weights, max_slope) == pytest.approx(ref)


def loma(height=8.0):
    """DTM con una loma suave de norte a sur en la columna 100: tapa la vista al hábitat."""
    cols = np.arange(N)
    return np.tile(np.clip(height - np.abs(cols - 100) * 0.4, 0, None), (N, 1)).astype(np.float32)


class TestSeguridad:
    """Límites duros, puntaje, robustez y costo (api/safety.py, docs/seguridad.md)."""

    @pytest.fixture
    def con_loma(self, site):
        write_terrain(site, flat(), dtm=loma())
        write_shadow_stack(site)
        return site

    def test_trae_limites_con_su_procedencia(self, client, con_loma):
        v = client.post("/api/route", json=request(band_time(11))).json()["verdict"]
        ids = [lim["id"] for lim in v["limits"]]
        assert ids == ["terrain", "o2", "battery", "daylight", "contact", "dose", "calories"]
        prov = {lim["id"]: lim["limit"] for lim in v["limits"]}
        # ASSUMED solo si el número entero lo eligió el equipo.
        assert all(prov[k]["provenance"] == "ASSUMED" for k in ("terrain", "contact", "dose", "calories"))
        # O2, batería y luz salen de la capacidad del traje o del atardecer; la parte del equipo va declarada.
        for k, team_part in (("o2", "Reserva del 20 %"), ("battery", "Reserva del 20 %"),
                             ("daylight", "Margen de 30 min")):
            assert prov[k]["provenance"] == "MODELED"
            assert any(a.startswith(team_part) for a in prov[k]["assumptions"])
        assert prov["daylight"]["mission"] == "MRO"
        assert v["score"]["unit"] == "pts" and 0 <= v["score"]["value"] <= 100

    def test_la_loma_corta_el_contacto_y_limita(self, client, con_loma):
        v = client.post("/api/route", json=request(band_time(11))).json()["verdict"]
        contact = next(lim for lim in v["limits"] if lim["id"] == "contact")
        assert contact["used"]["value"] > 0
        assert v["limiting_factor"] == "contact"
        assert v["score"]["value"] == round(100 * contact["margin"])

    def test_en_llano_hay_contacto_todo_el_camino(self, client, site):
        write_terrain(site, flat(), dtm=np.zeros((N, N), dtype=np.float32))
        write_shadow_stack(site)
        v = client.post("/api/route", json=request(band_time(11))).json()["verdict"]
        contact = next(lim for lim in v["limits"] if lim["id"] == "contact")
        assert contact["used"]["value"] == 0

    def test_cambiar_la_hora_de_salida_cambia_el_veredicto(self, client, con_loma):
        """MAP-25 de punta a punta: atardecer plano en la banda 19 de la pila de prueba."""
        def status(t):
            return client.post("/api/route", json=request(t)).json()["verdict"]["status"]
        sunset = band_time(19)
        assert status(band_time(11)) == "GO"
        assert status(sunset - 30 * 60 - 40 * 60) == "CAUTION"   # saliendo 30 min tarde ya no llega
        assert status(sunset - 30 * 60 - 5 * 60) == "NO_GO"

    def test_robustez_cuenta_solo_escenarios_evaluables(self, client, con_loma):
        rob = client.post("/api/route", json=request(band_time(11))).json()["verdict"]["robustness"]
        assert rob["evaluated"] == 3
        st = {s["id"]: s["status"] for s in rob["scenarios"]}
        assert st["dust_storm"] == st["no_shelter"] == "not_evaluated"

    def test_desglose_del_costo_suma_el_total(self, client, con_loma):
        cost = client.post("/api/route", json=request(band_time(11))).json()["cost"]
        active = [f for f in cost["factors"] if f["active"]]
        assert {f["id"] for f in active} == {"slope", "shadow", "contact"}
        assert all(f["minutes"] is None and f["note"] for f in cost["factors"] if not f["active"])
        assert cost["total_minutes"] == pytest.approx(cost["base_minutes"] + sum(f["minutes"] for f in active),
                                                      abs=0.2)
        assert next(f for f in active if f["id"] == "contact")["minutes"] > 0

    def test_sin_dtm_el_contacto_no_se_evalua_y_es_caution(self, client, site):
        write_terrain(site, flat())
        write_shadow_stack(site)
        body = client.post("/api/route", json=request(band_time(11))).json()
        v = body["verdict"]
        assert v["status"] == "CAUTION"
        assert next(lim for lim in v["limits"] if lim["id"] == "contact")["status"] == "not_evaluated"
        assert not next(f for f in body["cost"]["factors"] if f["id"] == "contact")["active"]

    def test_pendiente_entre_el_limite_y_30_tampoco_se_pisa(self, client, site):
        slope = flat()
        slope[:, 100] = 27.0          # bajo el corte viejo de 30°, sobre el límite duro de 25°
        write_terrain(site, slope)
        body = client.post("/api/route", json=request(band_time(11))).json()
        assert body["legs"][0]["class"] == "blocked"
        assert body["verdict"]["status"] == "NO_GO"
        assert body["verdict"]["limiting_factor"] == "terrain"


class TestPendienteMaxima:
    """El límite duro usa el máximo de cada celda de trabajo, no la media (review del PR #14)."""

    @pytest.fixture
    def celdas_gruesas(self, site, monkeypatch):
        # Con celdas de 1 px no hay promedio que probar: se fuerza f > 1.
        monkeypatch.setattr(planner, "MAX_CELLS_SIDE", 50)
        return site

    def test_franja_angosta_empinada_no_se_diluye(self, client, celdas_gruesas):
        slope = flat()
        slope[:, 100] = 40.0          # 1 px de ancho: promediada en la celda quedaría bajo 25°
        write_terrain(celdas_gruesas, slope)
        body = client.post("/api/route", json=request(band_time(11))).json()
        assert body["legs"][0]["class"] == "blocked"
        assert body["verdict"]["status"] == "NO_GO"
        assert body["verdict"]["limiting_factor"] == "terrain"

    def test_reporta_el_maximo_de_la_celda(self, client, celdas_gruesas):
        slope = flat()
        slope[:, 100] = 20.0          # se puede pisar, pero el número tiene que ser 20, no la media
        write_terrain(celdas_gruesas, slope)
        body = client.post("/api/route", json=request(band_time(11))).json()
        leg = body["legs"][0]
        assert leg["max_slope"]["value"] == pytest.approx(20.0)
        terrain = next(lim for lim in body["verdict"]["limits"] if lim["id"] == "terrain")
        assert terrain["used"]["value"] == pytest.approx(20.0)
        assert terrain["margin"] == pytest.approx(1 - 20 / 25, abs=1e-3)

    @staticmethod
    def _grid(site, slope):
        import rasterio
        out = write_terrain(site, slope)
        with rasterio.open(out / "slope.tif") as ds:
            from .rasters import LAT0, LON0, R
            xa, ya = R * math.radians(LON0) - 300, R * math.radians(LAT0)
            return planner.build_grid(ds, (xa, ya), (xa + 600, ya), 600)

    def test_build_grid_guarda_media_y_maximo(self, celdas_gruesas):
        slope = flat()
        slope[:, 100] = 40.0
        grid = self._grid(celdas_gruesas, slope)
        assert np.nanmax(grid.peak) == pytest.approx(40.0)
        assert np.nanmax(grid.slope) < 25.0

    def test_un_pixel_suelto_no_es_la_pendiente_de_la_celda(self, celdas_gruesas):
        slope = flat()
        slope[101, 101] = 40.0        # una roca: se esquiva dentro de la celda
        grid = self._grid(celdas_gruesas, slope)
        assert np.nanmax(grid.peak) == pytest.approx(2.0)
        assert np.nanmax(grid.slope) > 2.0          # el costo sí la ve

    def test_rocas_sueltas_no_bloquean_celdas_gruesas(self, client, celdas_gruesas):
        """Review del PR #14: con el máximo, un píxel empinado en cada celda bloqueaba todo el tramo,
        y el mismo terreno partido en tramos más cortos (celdas más finas) daba GO."""
        slope = flat()
        slope[1::4, 1::4] = 40.0      # un píxel de 40° en cada celda de 4 × 4
        write_terrain(celdas_gruesas, slope)
        body = client.post("/api/route", json=request(band_time(11))).json()
        assert body["legs"][0]["class"] != "blocked"
        terrain = next(lim for lim in body["verdict"]["limits"] if lim["id"] == "terrain")
        assert terrain["status"] == "ok"


def test_la_vista_cubre_la_ventana_del_astar(data_dir, monkeypatch):
    """Review del PR #14: la ventana de visibilidad tiene que llegar al margen que usa el A*,
    medido sobre el suelo (en Jezero un metro de la proyección mide 0,95 m hacia el este)."""
    import rasterio

    from api import contact as contact_mod
    from .rasters import R
    monkeypatch.setattr(contact_mod, "MARGIN_M", 10.0)   # el raster de prueba mide 1 km
    out = write_terrain(data_dir, flat(), dtm=np.zeros((N, N), dtype=np.float32))
    mid = latlon(100, 100)
    with rasterio.open(out / "dtm.tif") as ds:
        field = contact_mod.ContactField.from_dtm(ds, mid, [mid], margin_m=300.0)
    x_mid = R * math.radians(mid[1])
    west_ground_m = (x_mid - field.transform.c) * math.cos(math.radians(mid[0]))
    assert west_ground_m >= 300.0
