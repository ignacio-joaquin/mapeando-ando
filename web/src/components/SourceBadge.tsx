/**
 * Badge de procedencia. Toda capa y todo valor derivado muestra de qué misión e
 * instrumento sale, y con qué resolución. Regla del core value: si no hay
 * fuente, no se muestra el número.
 */
interface Props {
  readonly mission: string;
  readonly instrument: string;
  readonly resolution?: string;
  readonly estimated?: boolean;
}

export function SourceBadge({ mission, instrument, resolution, estimated }: Props) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-line bg-bg/60 px-1.5 py-0.5 text-[10px] leading-none text-muted"
      title={`${mission} · ${instrument}${resolution ? ` · ${resolution}` : ""}`}
    >
      <span className="font-medium text-fg/80">{mission}</span>
      <span aria-hidden>·</span>
      <span>{instrument}</span>
      {resolution ? <span className="text-muted/80">· {resolution}</span> : null}
      {estimated ? <span className="text-warn">· estimado</span> : null}
    </span>
  );
}
