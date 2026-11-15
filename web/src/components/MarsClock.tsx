import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { MARS24 } from "../domain/provenance";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { useDismiss } from "./useDismiss";
import {
  formatMarsTime,
  localMeanSolarTime,
  localTrueSolarTime,
  marsTime,
  seasonFromLs,
  siteSol,
} from "../mars/mars24";

/**
 * Reloj marciano del sitio: hora solar local y Ls (Mars24, Allison & McEwen).
 * Se calcula en el cliente, sin backend. Es la entrada de tiempo del
 * planificador: el instante vive en el store.
 *
 * En la barra va solo lo que se mira seguido (LTST y sol); el resto, con su
 * procedencia, abre en un desplegable.
 */
interface Props {
  readonly lon: number;
}

export function MarsClock({ lon }: Props) {
  const instant = useStore((s) => s.instant);
  const setInstant = useStore((s) => s.setInstant);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  useEffect(() => {
    const t = setInterval(() => setInstant(new Date()), 1000);
    return () => clearInterval(t);
  }, [setInstant]);

  const mt = marsTime(instant);
  const lmst = localMeanSolarTime(mt.mtc, lon);
  const ltst = localTrueSolarTime(mt.mtc, lon, mt.eotHours);
  const sol = siteSol(mt.msd, lon).toLocaleString("es-AR");

  return (
    <div ref={ref} data-edu="clock" className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="Hora solar local verdadera del sitio (Mars24)"
        className="flex min-h-9 items-baseline gap-1.5 rounded-md border border-line bg-bg/60 px-2.5 py-1 hover:border-muted aria-expanded:border-rust"
      >
        <span className="text-[10px] font-semibold tracking-wide text-muted">LTST</span>
        <span className="font-mono text-sm text-rust tabular-nums">{formatMarsTime(ltst)}</span>
        <span className="hidden text-[11px] text-muted sm:inline">· sol {sol}</span>
      </button>

      {open ? (
        <div className="absolute top-full right-0 z-40 mt-1.5 w-72 rounded-lg border border-line bg-panel p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Reloj marciano</h2>
            {/* Un badge para todo el bloque: todos los valores salen de Mars24. */}
            <ProvenanceBadge source={MARS24} />
          </div>
          <dl className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted">Hora solar local (LTST)</dt>
            <dd className="font-mono text-base text-rust tabular-nums">{formatMarsTime(ltst)}</dd>

            <dt className="text-muted">Media local (LMST)</dt>
            <dd className="font-mono tabular-nums">{formatMarsTime(lmst)}</dd>

            <dt className="text-muted">Sol del sitio</dt>
            <dd className="font-mono">{sol}</dd>

            <dt className="text-muted">Ls</dt>
            <dd className="text-right font-mono">
              {mt.ls.toFixed(2)}°
              <span className="block text-[11px] text-muted">{seasonFromLs(mt.ls)}</span>
            </dd>

            <dt className="text-muted">MTC</dt>
            <dd className="font-mono tabular-nums">{formatMarsTime(mt.mtc)}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
