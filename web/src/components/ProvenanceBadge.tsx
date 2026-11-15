import { useId } from "react";
import { PROVENANCE_LABEL, type Provenance, type SourceInfo } from "../domain/provenance";

/**
 * Badge de procedencia: "MRO HiRISE · DERIVED".
 *
 * El color distingue OBSERVED / DERIVED / MODELED / ASSUMED, pero la etiqueta va siempre
 * escrita: nada crítico se comunica solo por color (casco, guantes, luz dura).
 * Tooltip con fuente, resolución y supuestos al pasar el mouse, con foco de
 * teclado o con un toque en pantalla táctil (un toque da foco pero no
 * `focus-visible`, por eso el tooltip abre con `focus` a secas).
 */
const TONE: Record<Provenance, string> = {
  OBSERVED: "border-observed/60 bg-observed/15 text-observed",
  DERIVED: "border-derived/60 bg-derived/15 text-derived",
  MODELED: "border-modeled/60 bg-modeled/15 text-modeled",
  ASSUMED: "border-assumed/60 bg-assumed/15 text-assumed",
};

interface Props {
  readonly source: SourceInfo;
  /** Hacia dónde abre el tooltip, para que no se corte contra un borde. */
  readonly align?: "left" | "right";
  /** Arriba para badges pegados al borde inferior (barra de escala). */
  readonly side?: "top" | "bottom";
}

export function ProvenanceBadge({ source, align = "right", side = "bottom" }: Props) {
  const tipId = useId();
  const who = [source.mission, source.instrument].filter(Boolean).join(" ");

  return (
    <span
      tabIndex={0}
      aria-describedby={tipId}
      className="group relative inline-flex shrink-0 cursor-help items-center gap-1 rounded border border-line bg-bg/60 px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap text-muted outline-none focus-visible:ring-1 focus-visible:ring-fg/60"
    >
      <span className="font-medium text-fg/80">{who || "cálculo local"}</span>
      <span
        className={`rounded-sm border px-1 py-px text-[9px] font-semibold tracking-wide ${TONE[source.provenance]}`}
      >
        {source.provenance}
      </span>

      <span
        id={tipId}
        role="tooltip"
        className={`invisible absolute z-30 w-60 rounded border border-line bg-panel p-2 text-left text-[11px] leading-snug font-normal whitespace-normal text-fg opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 ${align === "right" ? "right-0" : "left-0"} ${side === "bottom" ? "top-full mt-1" : "bottom-full mb-1"}`}
      >
        <span className="block font-semibold">
          {PROVENANCE_LABEL[source.provenance]}
          {who ? ` · ${who}` : " · cálculo local del frontend"}
        </span>
        {source.resolution ? (
          <span className="block text-muted">Resolución: {source.resolution}</span>
        ) : null}
        {source.source ? (
          <span className="mt-1 block text-muted">Fuente: {source.source}</span>
        ) : null}
        {source.assumptions && source.assumptions.length > 0 ? (
          <span className="mt-1 block">
            <span className="block text-muted">Supuestos:</span>
            {source.assumptions.map((a) => (
              <span key={a} className="block">
                · {a}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </span>
  );
}
