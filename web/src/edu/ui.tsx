import type { ReactNode } from "react";
import { useT } from "../i18n/lang";

/** Piezas chicas para el texto de las lecciones. */

export function P({ children }: { readonly children: ReactNode }) {
  return <p className="leading-relaxed">{children}</p>;
}

export function Facts({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="flex flex-col gap-1 rounded border border-line bg-bg/60 p-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-mono font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Aviso de honestidad: qué número es un supuesto, qué falta. */
export function Caveat({ children }: { readonly children: ReactNode }) {
  return (
    <p className="rounded border border-assumed/50 bg-assumed/10 p-2 leading-relaxed">
      <strong aria-hidden>ⓘ </strong>
      {children}
    </p>
  );
}

export function List({ items }: { readonly items: readonly ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/** Sin ruta real todavía: la lección no tiene qué leer. */
export function NeedRoute() {
  const t = useT();
  return (
    <p className="text-muted">
      {t(
        "Cuando tengas una ruta calculada por el planificador, acá aparecen sus números.",
        "Once the planner has computed a route, its numbers show up here.",
      )}
    </p>
  );
}
