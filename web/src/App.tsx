import { useEffect, useState } from "react";
import { MapView } from "./map/MapView";
import { LAYERS, tileUrl } from "./map/layers";
import { LayersButton, LayersPanel } from "./components/LayerStack";
import { CursorReadout, Inspector } from "./components/Inspector";
import { ScaleBar } from "./components/ScaleBar";
import { FixtureBanner } from "./components/FixtureBanner";
import { TopBar } from "./components/TopBar";
import { CurrentConditions } from "./components/CurrentConditions";
import { ClickModeToggle, PlannerPanel } from "./components/route/PlannerPanel";
import { ElevationProfile } from "./components/route/ElevationProfile";
import { CuffChecklist } from "./components/route/CuffChecklist";
import { SunTimeline } from "./components/SunTimeline";
import { SHADOWS_LAYER_ID } from "./map/sun";
import {
  fetchCoverage,
  fetchHealth,
  fetchPlaces,
  fetchSites,
  fetchTerrain,
  fetchRouteSettings,
  tileExists,
} from "./api/client";
import { useSettings } from "./state/settings";
import type { Health, SiteSummary, TerrainIndex } from "./api/schemas";
import { availableFromTerrain } from "./map/terrain";
import { useStore } from "./state/store";
import { useFreshRoute, usePlan } from "./state/plan";
import { insideCoverage } from "./map/coverage";
import { EduOverlay } from "./edu/EduOverlay";
import { useHabitatContact } from "./components/route/HabitatContact";
import { tNow, useT } from "./i18n/lang";

export function App() {
  const [sites, setSites] = useState<readonly SiteSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeSiteId = useStore((s) => s.activeSiteId);
  const t = useT();
  const setAvailability = useStore((s) => s.setAvailability);
  const setTerrain = useStore((s) => s.setTerrain);
  const setPlaces = useStore((s) => s.setPlaces);
  const setCoverage = useStore((s) => s.setCoverage);
  const plan = useFreshRoute();
  // La zona de contacto del hábitat se pide acá: la capa vive aunque el
  // planificador esté en otra pestaña.
  useHabitatContact();
  const waypoints = usePlan((s) => s.waypoints.length);

  // Estado del server e inventario de sitios.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [h, s] = await Promise.all([fetchHealth(), fetchSites()]);
        if (!alive) return;
        setHealth(h);
        setSites(s.sites);
        // Un enlace con un ?site= que no existe: se cae al primero y la travesía
        // del enlace se descarta (sus puntos eran de otro lugar).
        const wanted = useStore.getState().activeSiteId;
        const first = s.sites[0];
        if (first && !s.sites.some((x) => x.id === wanted)) {
          useStore.getState().setActiveSite(first.id);
          const plan = usePlan.getState();
          // switchSite (no clear) deja el plan ya en el sitio nuevo: si no, el efecto de
          // RoutePlanner lo ve distinto, resetea la travesía y borra este aviso.
          plan.switchSite(first.id);
          plan.setNotice(
            tNow(
              `El enlace pedía el sitio "${wanted}", que no existe: abrí ${first.name}.`,
              `The link asked for site "${wanted}", which does not exist: opened ${first.name}.`,
            ),
          );
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Una capa se puede prender solo si su salida existe en el server. Las de
  // relieve las describe terrain.json; para el resto, solo se pregunta por las
  // que son un archivo (una plantilla {z}/{x}/{y} no se puede pedir con HEAD).
  useEffect(() => {
    let alive = true;
    setTerrain(null);
    setAvailability({});
    setCoverage(null);
    void (async () => {
      let terrain: TerrainIndex | null = null;
      try {
        terrain = await fetchTerrain(activeSiteId);
        if (alive) setTerrain(terrain);
      } catch (e) {
        if (alive) setTerrain(null, e instanceof Error ? e.message : String(e));
      }
      // La huella del DTM, para rechazar destinos sin terreno de 1 m. Si falla,
      // el planificador sigue y avisa que no pudo verificar.
      try {
        const coverage = await fetchCoverage(activeSiteId, terrain);
        if (alive) {
          setCoverage(coverage);
          if (coverage) usePlan.getState().dropOutside((p) => insideCoverage(coverage, p));
        }
      } catch {
        if (alive) setCoverage(null);
      }
      const available: Record<string, boolean> = {};
      for (const spec of LAYERS) {
        // Las sombras dependen del sol elegido: su disponibilidad la decide SunTimeline.
        if (spec.id === SHADOWS_LAYER_ID) {
          available[spec.id] = useStore.getState().layers[spec.id]?.available ?? false;
          continue;
        }
        const url = tileUrl(spec, activeSiteId);
        available[spec.id] =
          availableFromTerrain(spec, terrain) ?? (!url.includes("{z}") && (await tileExists(url)));
      }
      if (alive) setAvailability(available);
    })();
    return () => {
      alive = false;
    };
  }, [activeSiteId, setAvailability, setTerrain, setCoverage]);

  // Qué ajustes del planificador acepta el server (pestaña Ajustes).
  useEffect(() => {
    fetchRouteSettings()
      .then((s) => useSettings.getState().setSchema(s, s ? "ready" : "missing"))
      .catch(() => useSettings.getState().setSchema(null, "error"));
  }, []);

  // Lugares del sitio para el buscador de destinos (pipeline/places.py).
  useEffect(() => {
    let alive = true;
    setPlaces(null);
    fetchPlaces(activeSiteId)
      .then((p) => {
        if (alive) setPlaces(p);
      })
      .catch((e: unknown) => {
        if (alive) setPlaces(null, e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [activeSiteId, setPlaces]);

  const site = sites.find((s) => s.id === activeSiteId) ?? sites[0];
  const hasRoute = waypoints >= 2;

  return (
    <>
      {/* Solo en impresión: la tira de la travesía (CuffChecklist). */}
      <CuffChecklist />
      <EduOverlay />
      <div className="flex h-dvh flex-col print:hidden">
        <FixtureBanner />
        <TopBar sites={sites} site={site} health={health} error={error} />

        {/* Tres columnas en pantalla ancha: planificador, mapa y capas. En
            pantalla chica el mapa ocupa todo, las capas abren desde un botón
            y el planificador es una hoja que sube desde abajo, por encima del
            mapa (así el mapa no cambia de tamaño). */}
        <div className="relative flex min-h-0 flex-1 md:flex-row">
          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col pb-12 md:order-2 md:pb-0">
            {site ? <CurrentConditions siteId={site.id} /> : null}
            <div data-edu="map" className="relative min-h-0 flex-1">
              {site ? (
                <>
                  <MapView center={site.center} bbox={site.bbox} siteId={site.id} />
                  <MapOverlays site={site} />
                </>
              ) : (
                <p className="p-6 text-sm text-muted">
                  {error ? t("No se pudo leer el inventario de sitios.", "Could not read the site inventory.") : t("Cargando sitios…", "Loading sites…")}
                </p>
              )}
            </div>
            {site ? <SunTimeline siteId={site.id} lat={site.center.lat} lon={site.center.lon} /> : null}
            {/* El perfil va debajo del mapa: se lee junto con la ruta dibujada. */}
            {hasRoute ? (
              <div data-edu="profile">
                <ElevationProfile profile={plan?.route.profile} />
              </div>
            ) : null}
          </main>

          <PlannerPanel />
          <LayersPanel />
        </div>
      </div>
    </>
  );
}

/**
 * Lo que flota sobre el mapa: modo de clic (y capas, sin la columna de la
 * derecha) arriba, el inspector cuando hay un punto fijado, escala y cursor abajo.
 */
function MapOverlays({ site }: { readonly site: SiteSummary }) {
  const view = useStore((s) => s.view);
  const pitched = (view?.pitch ?? 0) > 0.5;
  const t = useT();
  return (
    <>
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col items-start gap-2 pr-12">
        <div className="flex flex-wrap items-start gap-2">
          <LayersButton />
          <ClickModeToggle />
        </div>
        {site.files_ok === 0 ? (
          <p className="pointer-events-auto max-w-xs rounded-md border border-warn/60 bg-panel/95 px-2 py-1 text-[11px] text-warn shadow-lg">
            {t(
              `Sin datos descargados de ${site.name}: el mapa muestra el recuadro del sitio, no imagen real.`,
              `No data downloaded for ${site.name}: the map shows the site box, not a real image.`,
            )}
          </p>
        ) : null}
        <Inspector center={site.center} siteId={site.id} />
      </div>

      <div className="pointer-events-none absolute bottom-8 left-3 flex flex-col items-start gap-1 rounded-md bg-bg/80 px-2 py-1.5 backdrop-blur">
        <CursorReadout badge={pitched} />
        {/* Con la cámara inclinada la escala cambia de punta a punta de la
            pantalla: una barra fija mentiría. */}
        {pitched ? (
          <span className="text-[10px] text-muted">{t("sin barra de escala en 3D", "no scale bar in 3D")}</span>
        ) : (
          <ScaleBar lat={view?.lat ?? site.center.lat} zoom={view?.zoom ?? 12} maxPx={110} />
        )}
      </div>
    </>
  );
}
