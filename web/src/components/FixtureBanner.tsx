import { usingFixtures } from "../api/client";
import { useT } from "../i18n/lang";

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
      className="flex items-center gap-2 bg-alert px-3 py-1 text-xs text-bg"
    >
      <span aria-hidden>▲</span>
      <strong className="shrink-0 font-bold whitespace-nowrap">{t("Datos de ejemplo:", "Sample data:")}</strong>
      <span>
        {t(
          "no hay backend conectado, ningún valor de esta pantalla es una medición.",
          "no backend connected; no value on this screen is a measurement.",
        )}
      </span>
      <span className="hidden opacity-80 lg:inline">
        {t(
          <>
            Para datos reales, copiá <code>web/.env.example</code> a <code>web/.env.local</code> con la
            IP del server.
          </>,
          <>
            For real data, copy <code>web/.env.example</code> to <code>web/.env.local</code> with the
            server IP.
          </>,
        )}
      </span>
    </div>
  );
}
