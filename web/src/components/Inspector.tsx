import { useStore } from "../state/store";
import { formatLatLon, formatDistance, marsDistanceM } from "../mars/geo";
import type { LatLonDto } from "../api/schemas";
import { LOCAL_GEOMETRY } from "../domain/provenance";
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
}

export function Inspector({ center }: Props) {
  const cursor = useStore((s) => s.cursor);
  const picked = useStore((s) => s.picked);
  const setPicked = useStore((s) => s.setPicked);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            Cursor
          </h3>
          <ProvenanceBadge source={LOCAL_GEOMETRY} />
        </div>
        <p className="font-mono text-xs">
          {cursor ? formatLatLon(cursor) : "— fuera del mapa —"}
        </p>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            Punto fijado
          </h3>
          {picked ? (
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="text-[11px] text-rust hover:underline"
            >
              limpiar
            </button>
          ) : null}
        </div>
        {picked ? (
          <dl className="flex flex-col gap-1 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Coordenadas</dt>
              <dd className="flex flex-wrap items-center justify-end gap-1.5">
                <span className="font-mono">{formatLatLon(picked)}</span>
                <ProvenanceBadge source={LOCAL_GEOMETRY} />
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Distancia al centro</dt>
              <dd>
                <Measure
                  data={{
                    ...LOCAL_GEOMETRY,
                    value: marsDistanceM(picked, { lat: center.lat, lon: center.lon }),
                    unit: null,
                  }}
                  format={formatDistance}
                />
              </dd>
            </div>
            <p className="mt-1 rounded border border-line bg-panel/60 p-2 text-[11px] text-warn">
              Elevacion, pendiente y valor por capa: faltan el point query de la
              API y las salidas del pipeline. No se muestra ningun valor
              estimado.
            </p>
          </dl>
        ) : (
          <p className="text-xs text-muted">
            Con el modo «inspeccionar» del planificador, clic en el mapa para fijar un punto.
          </p>
        )}
      </div>
    </div>
  );
}
