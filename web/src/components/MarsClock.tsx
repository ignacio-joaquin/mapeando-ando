import { useEffect } from "react";
import { useStore } from "../state/store";
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
 */
interface Props {
  readonly lon: number;
}

export function MarsClock({ lon }: Props) {
  const instant = useStore((s) => s.instant);
  const setInstant = useStore((s) => s.setInstant);

  useEffect(() => {
    const t = setInterval(() => setInstant(new Date()), 1000);
    return () => clearInterval(t);
  }, [setInstant]);

  const mt = marsTime(instant);
  const lmst = localMeanSolarTime(mt.mtc, lon);
  const ltst = localTrueSolarTime(mt.mtc, lon, mt.eotHours);

  return (
    <dl className="grid grid-cols-2 items-baseline gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted">Hora solar local (LTST)</dt>
      <dd className="font-mono text-base text-rust">{formatMarsTime(ltst)}</dd>

      <dt className="text-muted">Media local (LMST)</dt>
      <dd className="font-mono">{formatMarsTime(lmst)}</dd>

      <dt className="text-muted">Sol del sitio</dt>
      <dd className="font-mono">{siteSol(mt.msd, lon).toLocaleString("es-AR")}</dd>

      <dt className="text-muted">Ls</dt>
      <dd className="font-mono">
        {mt.ls.toFixed(2)}°{" "}
        <span className="text-muted">· {seasonFromLs(mt.ls)}</span>
      </dd>

      <dt className="text-muted">MTC</dt>
      <dd className="font-mono">{formatMarsTime(mt.mtc)}</dd>
    </dl>
  );
}
