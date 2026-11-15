import type { Health, SiteSummary } from "../api/schemas";
import { useStore } from "../state/store";
import { MarsClock } from "./MarsClock";
import { EduToggle } from "../edu/EduOverlay";

/**
 * Barra de arriba: marca, sitio, reloj y estado del server. El disclaimer va
 * siempre a la vista (también en pantalla chica): no se saca.
 */
interface Props {
  readonly sites: readonly SiteSummary[];
  readonly site: SiteSummary | undefined;
  readonly health: Health | null;
  readonly error: string | null;
}

export function TopBar({ sites, site, health, error }: Props) {
  const activeSiteId = useStore((s) => s.activeSiteId);
  const setActiveSite = useStore((s) => s.setActiveSite);

  return (
    <header className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 border-b border-line bg-panel px-3 py-2 sm:flex">
      <div className="flex min-w-0 flex-col leading-tight">
        <h1 className="text-sm font-bold tracking-wide">Mapa Marciano</h1>
        <p className="text-[10px] text-warn">
          Prototipo<span className="hidden sm:inline"> educativo</span> · no es software de vuelo
        </p>
      </div>

      <div className="flex items-center gap-1 sm:order-last sm:ml-auto sm:gap-2">
        <EduToggle />
        {site ? <MarsClock lon={site.center.lon} /> : null}
        <ServerStatus health={health} error={error} />
      </div>

      {sites.length > 0 ? (
        <nav
          aria-label="Sitio"
          className="col-span-2 flex rounded-md border border-line bg-bg/60 p-0.5"
        >
          {sites.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={s.id === activeSiteId}
              onClick={() => setActiveSite(s.id)}
              title={`${s.name} · ${s.rover} · ${s.files_ok}/${s.files_total} archivos descargados`}
              className="min-h-8 flex-1 rounded px-3 text-xs sm:flex-none text-muted hover:text-fg aria-pressed:bg-line aria-pressed:font-semibold aria-pressed:text-fg"
            >
              {s.name}
            </button>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

/** Punto + palabra: el estado no se comunica solo con el color. */
function ServerStatus({ health, error }: { readonly health: Health | null; readonly error: string | null }) {
  const [dot, label, title] = error
    ? ["bg-alert", "sin API", `La API no respondió: ${error}`]
    : !health
      ? ["bg-muted animate-pulse", "conectando", "Consultando el server…"]
      : health.data_ready
        ? ["bg-ok", "datos listos", `commit ${health.commit ?? "?"} · datos del pipeline listos`]
        : ["bg-warn", "bajando datos", `commit ${health.commit ?? "?"} · el pipeline todavía descarga`];
  return (
    <span
      role="status"
      title={title}
      className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted"
    >
      <span aria-hidden className={`size-2 rounded-full ${dot}`} />
      <span className={`sr-only sm:not-sr-only ${error ? "text-alert" : ""}`}>{label}</span>
    </span>
  );
}
