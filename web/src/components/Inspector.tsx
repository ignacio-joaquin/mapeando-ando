import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { formatLatLon, formatDistance, marsDistanceM } from "../mars/geo";
import type { LatLonDto, PointInfo } from "../api/schemas";
import { fetchPoint } from "../api/client";
import { localGeometry } from "../domain/provenance";
import { useT } from "../i18n";
import { Measure } from "./Measure";
import { ProvenanceBadge } from "./ProvenanceBadge";

/**
 * Inspector de punto. Hoy muestra coordenadas y distancia al centro del sitio,
 * calculadas en el cliente con el radio marciano (badge DERIVED, cálculo local).
 *
 * Elevacion, pendiente y el valor de cada capa necesitan el point query de
 * FastAPI, que todavia no existe (api/main.py expone health/sites/sites/{id}).
 * Hasta que exista, esto dice que falta en vez de mostrar un numero inventado.
 */
interface Props {
  readonly center: LatLonDto;
  readonly siteId: string;
}

export function Inspector({ center, siteId }: Props) {
  const t = useT();
  const geometry = localGeometry(t);
  const cursor = useStore((s) => s.cursor);
  const picked = useStore((s) => s.picked);
  const setPicked = useStore((s) => s.setPicked);
  const [point, setPoint] = useState<PointInfo | null>(null);
  const [cargando, setCargando] = useState(false);

  // Al fijar un punto, preguntarle a la API qué hay ahí. Se cancela si el
  // usuario hace otro clic antes de que conteste.
  useEffect(() => {
    setPoint(null);
    if (!picked) return;
    const ctrl = new AbortController();
    setCargando(true);
    fetchPoint(siteId, picked.lat, picked.lon, ctrl.signal)
      .then(setPoint)
      .catch(() => setPoint(null))
      .finally(() => setCargando(false));
    return () => ctrl.abort();
  }, [picked, siteId]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t.inspector.cursor}
          </h3>
          <ProvenanceBadge source={geometry} />
        </div>
        <p className="font-mono text-xs">
          {cursor ? formatLatLon(cursor) : t.inspector.offMap}
        </p>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t.inspector.picked}
          </h3>
          {picked ? (
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="text-[11px] text-rust hover:underline"
            >
              {t.inspector.clear}
            </button>
          ) : null}
        </div>
        {picked ? (
          <dl className="flex flex-col gap-1 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted">{t.inspector.coordinates}</dt>
              <dd className="flex flex-wrap items-center justify-end gap-1.5">
                <span className="font-mono">{formatLatLon(picked)}</span>
                <ProvenanceBadge source={geometry} />
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">{t.inspector.distanceToCenter}</dt>
              <dd>
                <Measure
                  data={{
                    ...geometry,
                    value: marsDistanceM(picked, { lat: center.lat, lon: center.lon }),
                    unit: null,
                  }}
                  format={formatDistance}
                />
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">{t.inspector.elevation}</dt>
              <dd>
                {point ? (
                  <Measure data={point.elevation} />
                ) : (
                  <span className="font-mono text-xs text-muted">
                    {cargando ? t.inspector.querying : "—"}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">{t.inspector.slope}</dt>
              <dd>
                {point ? (
                  <Measure data={point.slope} />
                ) : (
                  <span className="font-mono text-xs text-muted">
                    {cargando ? t.inspector.querying : "—"}
                  </span>
                )}
              </dd>
            </div>

            {point?.layers.map((capa) => (
              <div key={capa.id} className="flex justify-between gap-2">
                <dt className="text-muted">{capa.label}</dt>
                <dd>
                  <Measure data={capa} />
                </dd>
              </div>
            ))}

            {/* Por qué falta el dato, siempre explicado. Nunca un valor inventado. */}
            {point?.note ? (
              <p className="mt-1 rounded border border-line bg-panel/60 p-2 text-[11px] text-warn">
                {point.note}
              </p>
            ) : null}
            {!point && !cargando ? (
              <p className="mt-1 rounded border border-line bg-panel/60 p-2 text-[11px] text-warn">
                {t.inspector.noBackend}
              </p>
            ) : null}
          </dl>
        ) : (
          <p className="text-xs text-muted">
            {t.inspector.hint}
          </p>
        )}
      </div>
    </div>
  );
}
