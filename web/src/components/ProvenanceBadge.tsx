import { useId } from "react";
import { HOW_WE_KNOW, INSTRUMENT_NOTE, PROVENANCE_LABEL, type Provenance, type SourceInfo } from "../domain/provenance";
import { useT, useTr } from "../i18n/lang";

/**
 * Badge de procedencia: "MRO HiRISE · DERIVED".
 *
 * El color distingue OBSERVED / DERIVED / MODELED / ASSUMED, pero la etiqueta va siempre
 * escrita: nada crítico se comunica solo por color (casco, guantes, luz dura).
 * Tooltip con fuente, resolución y supuestos al pasar el mouse, con foco de
 * teclado o con un toque en pantalla táctil (un toque da foco pero no
 * `focus-visible`, por eso el tooltip abre con `focus` a secas). Abre también
 * con `focus-within`, para poder llegar con Tab al enlace de adentro.
 *
 * Arriba de todo, "¿Cómo lo sabemos?": qué quiere decir este tipo de dato en
 * lenguaje llano, para cualquier edad.
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
  const t = useT();
  const tr = useTr();
  // Misión e instrumento suelen ser nombres propios; los que no ("geometría
  // esférica") pasan por el diccionario.
  const who = [source.mission, source.instrument].filter(Boolean).map((x) => tr(x)).join(" ");
  const local = t("cálculo local", "local calculation");

  return (
    <span
      tabIndex={0}
      aria-describedby={tipId}
      className="group relative inline-flex shrink-0 cursor-help items-center gap-1 rounded border border-line bg-bg/60 px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap text-muted outline-none focus-visible:ring-1 focus-visible:ring-fg/60"
    >
      <span className="font-medium text-fg/80">{who || local}</span>
      <span
        className={`rounded-sm border px-1 py-px text-[9px] font-semibold tracking-wide ${TONE[source.provenance]}`}
      >
        {source.provenance}
      </span>

      <span
        id={tipId}
        role="tooltip"
        className={`invisible absolute z-30 w-60 rounded border border-line bg-panel p-2 text-left text-[11px] leading-snug font-normal whitespace-normal text-fg opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 group-focus-within:visible group-focus-within:opacity-100 ${align === "right" ? "right-0" : "left-0"} ${side === "bottom" ? "top-full mt-1" : "bottom-full mb-1"}`}
      >
        <span className="block font-semibold">{t("¿Cómo lo sabemos?", "How do we know?")}</span>
        <span className="mt-0.5 block">{tr(HOW_WE_KNOW[source.provenance])}</span>
        {source.instrument && INSTRUMENT_NOTE[source.instrument] ? (
          <span className="mt-1 block text-muted">{tr(INSTRUMENT_NOTE[source.instrument])}</span>
        ) : null}
        <span className="mt-1.5 block border-t border-line pt-1.5 font-semibold">
          {tr(PROVENANCE_LABEL[source.provenance])}
          {who ? ` · ${who}` : t(" · cálculo local del frontend", " · local calculation in the browser")}
        </span>
        {source.resolution ? (
          <span className="block text-muted">
            {t("Resolución", "Resolution")}: {tr(source.resolution)}
          </span>
        ) : null}
        {source.source ? (
          <span className="mt-1 block text-muted">
            {t("Fuente", "Source")}: {tr(source.source)}
          </span>
        ) : null}
        {source.assumptions && source.assumptions.length > 0 ? (
          <span className="mt-1 block">
            <span className="block text-muted">{t("Supuestos", "Assumptions")}:</span>
            {source.assumptions.map((a) => (
              <span key={a} className="block">
                · {tr(a)}
              </span>
            ))}
          </span>
        ) : null}
        <a
          href={t("https://ciencia.nasa.gov/", "https://science.nasa.gov/")}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 block text-rust underline underline-offset-2"
        >
          {t("Más sobre Marte en ciencia.nasa.gov ↗", "More about Mars at science.nasa.gov ↗")}
        </a>
      </span>
    </span>
  );
}
