import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { formatLatLon, formatDistance, marsDistanceM } from "../mars/geo";
import type { LatLonDto, PointInfo } from "../api/schemas";
import { fetchPoint } from "../api/client";
import { LOCAL_GEOMETRY } from "../domain/provenance";
import { Measure } from "./Measure";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { useT, useTr } from "../i18n/lang";

/**
 * Inspector de punto, flotando sobre el mapa mientras haya un punto fijado
 * (modo «inspeccionar»). Muestra coordenadas y distancia al centro del sitio,
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
  const picked = useStore((s) => s.picked);
  const setPicked = useStore((s) => s.setPicked);
  const [point, setPoint] = useState<PointInfo | null>(null);
  const [cargando, setCargando] = useState(false);
  const t = useT();
  const tr = useTr();

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

  if (!picked) return null;

  const row = "flex items-center justify-between gap-3 py-1";
  const pending = (
    <span className="font-mono text-xs text-muted">{cargando ? t("consultando…", "querying…") : "—"}</span>
  );

  return (
    <section
      aria-label={t("Punto inspeccionado", "Inspected point")}
      data-edu="inspector"
      className="pointer-events-auto w-full rounded-lg border border-line bg-panel/95 p-3 text-sm shadow-2xl backdrop-blur sm:w-[26rem]"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">
          {t("Punto inspeccionado", "Inspected point")}
        </h2>
        <button
          type="button"
          onClick={() => setPicked(null)}
          aria-label={t("Cerrar el inspector", "Close the inspector")}
          className="grid size-7 place-items-center rounded text-muted hover:bg-line hover:text-fg"
        >
          ✕
        </button>
      </div>
      <dl className="flex flex-col divide-y divide-line/60 text-xs">
        <div className={row}>
          <dt className="text-muted">{t("Coordenadas", "Coordinates")}</dt>
          <dd className="flex flex-wrap items-center justify-end gap-1.5">
            <span className="font-mono">{formatLatLon(picked)}</span>
            <ProvenanceBadge source={LOCAL_GEOMETRY} />
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted">{t("Al centro del sitio", "To the site center")}</dt>
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
        <div className={row}>
          <dt className="text-muted">{t("Elevación", "Elevation")}</dt>
          <dd>{point ? <Measure data={point.elevation} /> : pending}</dd>
        </div>
        <div className={row}>
          <dt className="text-muted">{t("Pendiente", "Slope")}</dt>
          <dd>{point ? <Measure data={point.slope} /> : pending}</dd>
        </div>
        {point?.layers.map((capa) => (
          <div key={capa.id} className={row}>
            <dt className="text-muted">{tr(capa.label)}</dt>
            <dd>
              <Measure data={capa} />
            </dd>
          </div>
        ))}
      </dl>

      {/* Por qué falta el dato, siempre explicado. Nunca un valor inventado. */}
      {point?.note ? <p className="mt-2 text-[11px] text-warn">{tr(point.note)}</p> : null}
      {!point && !cargando ? (
        <p className="mt-2 text-[11px] text-warn">
          {t(
            "Sin backend conectado: no hay de dónde leer la elevación. No se muestra ningún valor estimado.",
            "No backend connected: there is nowhere to read the elevation from. No estimated value is shown.",
          )}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Coordenadas bajo el cursor, para la franja de abajo del mapa. Cálculo local,
 * con la misma procedencia que la barra de escala.
 */
export function CursorReadout({ badge }: { readonly badge: boolean }) {
  const cursor = useStore((s) => s.cursor);
  useT();
  if (!cursor) return null;
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] text-fg/90">
      {formatLatLon(cursor)}
      {/* Con la barra de escala a la vista, su badge ya cubre este cálculo. */}
      {badge ? (
        <span className="pointer-events-auto font-sans">
          <ProvenanceBadge source={LOCAL_GEOMETRY} align="left" side="top" />
        </span>
      ) : null}
    </span>
  );
}
