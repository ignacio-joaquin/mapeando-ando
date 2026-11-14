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
      className="flex items-center gap-2 border-b border-alert/60 bg-alert/15 px-3 py-1.5 text-xs text-fg"
    >
      <span aria-hidden>▲</span>
      <strong className="font-semibold">Datos de ejemplo.</strong>
      <span className="text-muted">
        No hay backend conectado: ningún valor de esta pantalla es una medición.
        Para datos reales, copiá <code className="text-fg/90">web/.env.example</code> a{" "}
        <code className="text-fg/90">web/.env.local</code> con la IP del server.
      </span>
    </div>
  );
}
