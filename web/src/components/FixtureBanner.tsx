import { usingFixtures } from "../api/client";
import { useT } from "../i18n";

/**
 * Cartel de datos de ejemplo. Si la app corre sin backend, el usuario tiene que
 * saberlo antes de mirar un número. No se puede silenciar.
 */
export function FixtureBanner() {
  const t = useT();
  if (!usingFixtures) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-alert/60 bg-alert/15 px-3 py-1.5 text-xs text-fg"
    >
      <span aria-hidden>▲</span>
      <strong className="font-semibold">{t.fixtureBanner.title}</strong>
      <span className="text-muted">
        {t.fixtureBanner.before} <code className="text-fg/90">web/.env.example</code>{" "}
        {t.fixtureBanner.middle} <code className="text-fg/90">web/.env.local</code>{" "}
        {t.fixtureBanner.after}
      </span>
    </div>
  );
}
