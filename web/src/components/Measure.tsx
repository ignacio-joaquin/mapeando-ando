import type { DataValue } from "../domain/provenance";
import { ProvenanceBadge } from "./ProvenanceBadge";

/**
 * Número visible con su procedencia. Es la forma de mostrar cualquier valor
 * en la UI: leyendas, inspector, panel de ruta, veredicto y fichas.
 *
 * - `value: null` muestra que el dato falta; nunca se rellena.
 * - `format` decide cómo se escribe el número (decimales, hh:mm, km vs m).
 * - `badge="none"` solo cuando un badge de sección ya cubre todos los valores
 *   de ese bloque (ej. el reloj, todo Mars24). Nunca para esconder la fuente.
 */
interface Props {
  readonly data: DataValue;
  readonly format?: (value: number) => string;
  readonly badge?: "inline" | "none";
  readonly size?: "sm" | "lg";
  readonly align?: "left" | "right";
}

const defaultFormat = (v: number) => v.toLocaleString("es-AR", { maximumFractionDigits: 2 });

export function Measure({
  data,
  format = defaultFormat,
  badge = "inline",
  size = "sm",
  align = "right",
}: Props) {
  const missing = data.value === null;

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <span
        className={`font-mono ${size === "lg" ? "text-base" : "text-xs"} ${missing ? "text-warn" : ""}`}
      >
        {data.value === null ? "falta el dato" : format(data.value)}
        {data.value !== null && data.unit ? (
          <span className="ml-0.5 text-muted">{data.unit}</span>
        ) : null}
      </span>
      {badge === "inline" ? <ProvenanceBadge source={data} align={align} /> : null}
    </span>
  );
}
