import { useEffect, useState } from "react";
import { MapView } from "./map/MapView";
import { LAYERS, tileUrl } from "./map/layers";
import { LayerStack } from "./components/LayerStack";
import { Inspector } from "./components/Inspector";
import { MarsClock } from "./components/MarsClock";
import { ScaleBar } from "./components/ScaleBar";
import { FixtureBanner } from "./components/FixtureBanner";
import { ProvenanceBadge } from "./components/ProvenanceBadge";
import { mars24 } from "./domain/provenance";
import { LanguageToggle } from "./components/LanguageToggle";
import { useT } from "./i18n";
import { RoutePlanner } from "./components/route/RoutePlanner";
import { ElevationProfile } from "./components/route/ElevationProfile";
import { CuffChecklist } from "./components/route/CuffChecklist";
import { fetchHealth, fetchSites, fetchTerrain, tileExists, usingFixtures } from "./api/client";
import type { Health, SiteSummary, TerrainIndex } from "./api/schemas";
import { availableFromTerrain } from "./map/terrain";
import { useStore } from "./state/store";
import { useFreshRoute } from "./state/plan";

export function App() {
  const t = useT();
  const [sites, setSites] = useState<readonly SiteSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeSiteId = useStore((s) => s.activeSiteId);
  const setActiveSite = useStore((s) => s.setActiveSite);
  const setAvailability = useStore((s) => s.setAvailability);
  const setTerrain = useStore((s) => s.setTerrain);
  const view = useStore((s) => s.view);
  const plan = useFreshRoute();

  // Estado del server e inventario de sitios.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [h, s] = await Promise.all([fetchHealth(), fetchSites()]);
        if (!alive) return;
        setHealth(h);
        setSites(s.sites);
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
    void (async () => {
      let terrain: TerrainIndex | null = null;
      try {
        terrain = await fetchTerrain(activeSiteId);
        if (alive) setTerrain(terrain);
      } catch (e) {
        if (alive) setTerrain(null, e instanceof Error ? e.message : String(e));
      }
      const available: Record<string, boolean> = {};
      for (const spec of LAYERS) {
        const url = tileUrl(spec, activeSiteId);
        available[spec.id] =
          availableFromTerrain(spec, terrain) ?? (!url.includes("{z}") && (await tileExists(url)));
      }
      if (alive) setAvailability(available);
    })();
    return () => {
      alive = false;
    };
  }, [activeSiteId, setAvailability, setTerrain]);

  // Lectores de pantalla y separación en sílabas siguen al idioma elegido.
  useEffect(() => {
    document.documentElement.lang = t.htmlLang;
  }, [t.htmlLang]);

  const site = sites.find((s) => s.id === activeSiteId) ?? sites[0];

  return (
    <>
      {/* Solo en impresión: la tira de la travesía (CuffChecklist). */}
      <CuffChecklist />
      <div className="flex h-full flex-col print:hidden">
        <FixtureBanner />

        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2">
          <h1 className="text-sm font-semibold tracking-wide">
            Mapa Marciano
            <span className="ml-2 font-normal text-muted">{t.app.subtitle}</span>
          </h1>

          <nav className="flex gap-1" aria-label={t.app.siteNav}>
            {sites.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveSite(s.id)}
                className={
                  s.id === activeSiteId
                    ? "rounded border border-rust bg-rust/15 px-2 py-0.5 text-xs text-fg"
                    : "rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-fg"
                }
              >
                {s.name}
              </button>
            ))}
          </nav>

          <p className="ml-auto text-[11px] text-muted">
            {error ? (
              <span className="text-alert">{t.app.apiError(error)}</span>
            ) : health ? (
              <>
                {t.app.status} {health.commit ?? "?"} · {t.app.data}{" "}
                <span className={health.data_ready ? "text-ok" : "text-warn"}>
                  {health.data_ready ? t.app.dataReady : t.app.dataDownloading}
                </span>
              </>
            ) : (
              t.app.querying
            )}
          </p>

          <LanguageToggle />
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            aria-label={t.app.plannerAria}
            className="w-96 shrink-0 overflow-y-auto border-r border-line bg-panel/40 p-3"
          >
            <RoutePlanner />
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
            {site ? (
              <>
                <MapView center={site.center} bbox={site.bbox} siteId={site.id} />
                <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-bg/80 px-2 py-1">
                  <ScaleBar lat={view?.lat ?? site.center.lat} zoom={view?.zoom ?? 12} />
                </div>
                <div className="pointer-events-none absolute top-3 left-3 max-w-xs rounded border border-line bg-bg/85 px-2 py-1 text-[11px] text-muted">
                  {site.name} · {site.rover} · {t.app.files(site.files_ok, site.files_total)}
                  {site.files_ok === 0 ? (
                    <span className="block text-warn">{t.app.noData}</span>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="p-6 text-sm text-muted">
                {error ? t.app.sitesError : t.app.loadingSites}
              </p>
            )}
            </div>
            {/* El perfil va debajo del mapa, como pide el ticket: se lee junto
                con la ruta dibujada, no en otra pantalla. */}
            <ElevationProfile profile={plan?.route.profile} />
          </main>

          <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel/40 p-3">
            <section className="mb-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {t.app.marsClock}
                </h2>
                {/* Un badge para todo el bloque: todos los valores salen de Mars24. */}
                <ProvenanceBadge source={mars24(t)} />
              </div>
              {site ? (
                <MarsClock lon={site.center.lon} />
              ) : (
                <p className="text-xs text-muted">—</p>
              )}
            </section>

            <section className="mb-4 border-t border-line pt-4">
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                {t.app.inspector}
              </h2>
              {site ? (
                <Inspector center={site.center} siteId={site.id} />
              ) : (
                <p className="text-xs text-muted">—</p>
              )}
            </section>

            <section className="border-t border-line pt-4">
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                {t.app.layers}
              </h2>
              <LayerStack />
            </section>

            <p className="mt-4 border-t border-line pt-3 text-[10px] leading-relaxed text-muted">
              {t.app.disclaimer}
              {usingFixtures ? t.app.runningFixtures : null}
            </p>
          </aside>
        </div>
      </div>
    </>
  );
}
