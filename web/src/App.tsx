import { useEffect, useState } from "react";
import { MapView } from "./map/MapView";
import { LAYERS, tileUrl } from "./map/layers";
import { LayerStack } from "./components/LayerStack";
import { Inspector } from "./components/Inspector";
import { MarsClock } from "./components/MarsClock";
import { ScaleBar } from "./components/ScaleBar";
import { FixtureBanner } from "./components/FixtureBanner";
import { ProvenanceBadge } from "./components/ProvenanceBadge";
import { MARS24 } from "./domain/provenance";
import { RoutePlanner } from "./components/route/RoutePlanner";
import { CuffChecklist } from "./components/route/CuffChecklist";
import { fetchHealth, fetchSites, tileExists, usingFixtures } from "./api/client";
import type { Health, SiteSummary } from "./api/schemas";
import { useStore } from "./state/store";

export function App() {
  const [sites, setSites] = useState<readonly SiteSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeSiteId = useStore((s) => s.activeSiteId);
  const setActiveSite = useStore((s) => s.setActiveSite);
  const setAvailable = useStore((s) => s.setAvailable);
  const view = useStore((s) => s.view);

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

  // Una capa se puede prender solo si su salida existe en el server.
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const spec of LAYERS) {
        const ok = await tileExists(tileUrl(spec, activeSiteId));
        if (!alive) return;
        setAvailable(spec.id, ok);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeSiteId, setAvailable]);

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
            <span className="ml-2 font-normal text-muted">mapa de supervivencia EVA</span>
          </h1>

          <nav className="flex gap-1" aria-label="Sitio">
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
              <span className="text-alert">API: {error}</span>
            ) : health ? (
              <>
                commit {health.commit ?? "?"} · datos{" "}
                <span className={health.data_ready ? "text-ok" : "text-warn"}>
                  {health.data_ready ? "listos" : "descargándose"}
                </span>
              </>
            ) : (
              "consultando el server…"
            )}
          </p>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            aria-label="Planificador de travesía"
            className="w-96 shrink-0 overflow-y-auto border-r border-line bg-panel/40 p-3"
          >
            <RoutePlanner />
          </aside>

          <main className="relative min-w-0 flex-1">
            {site ? (
              <>
                <MapView center={site.center} bbox={site.bbox} siteId={site.id} />
                <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-bg/80 px-2 py-1">
                  <ScaleBar lat={view?.lat ?? site.center.lat} zoom={view?.zoom ?? 12} />
                </div>
                <div className="pointer-events-none absolute top-3 left-3 max-w-xs rounded border border-line bg-bg/85 px-2 py-1 text-[11px] text-muted">
                  {site.name} · {site.rover} · {site.files_ok}/{site.files_total} archivos
                  {site.files_ok === 0 ? (
                    <span className="block text-warn">
                      Sin datos descargados: el mapa muestra el recuadro del sitio,
                      no imagen real.
                    </span>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="p-6 text-sm text-muted">
                {error ? "No se pudo leer el inventario de sitios." : "Cargando sitios…"}
              </p>
            )}
          </main>

          <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel/40 p-3">
            <section className="mb-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Reloj marciano
                </h2>
                {/* Un badge para todo el bloque: todos los valores salen de Mars24. */}
                <ProvenanceBadge source={MARS24} />
              </div>
              {site ? (
                <MarsClock lon={site.center.lon} />
              ) : (
                <p className="text-xs text-muted">—</p>
              )}
            </section>

            <section className="mb-4 border-t border-line pt-4">
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                Inspector
              </h2>
              {site ? (
                <Inspector center={site.center} />
              ) : (
                <p className="text-xs text-muted">—</p>
              )}
            </section>

            <section className="border-t border-line pt-4">
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                Capas
              </h2>
              <LayerStack />
            </section>

            <p className="mt-4 border-t border-line pt-3 text-[10px] leading-relaxed text-muted">
              Prototipo educativo, no software de vuelo.
              {usingFixtures ? " Corriendo con datos de ejemplo." : null}
            </p>
          </aside>
        </div>
      </div>
    </>
  );
}
