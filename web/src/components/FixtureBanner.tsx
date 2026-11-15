import { usingFixtures } from "../api/client";

/**
 * Cartel de datos de ejemplo. Si la app corre sin backend, el usuario tiene que
 * saberlo antes de mirar un número. No se puede silenciar.
 */
export function FixtureBanner() {
  if (!usingFixtures) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 bg-alert px-3 py-1 text-xs text-bg"
    >
      <span aria-hidden>▲</span>
      <strong className="shrink-0 font-bold whitespace-nowrap">Datos de ejemplo:</strong>
      <span>no hay backend conectado, ningún valor de esta pantalla es una medición.</span>
      <span className="hidden opacity-80 lg:inline">
        Para datos reales, copiá <code>web/.env.example</code> a <code>web/.env.local</code> con la
        IP del server.
      </span>
    </div>
  );
}
