import type { Place } from "../../api/schemas";
import { KIND_LABEL } from "../../domain/places";
import { formatLatLon } from "../../mars/geo";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { useT, useTr } from "../../i18n/lang";

/**
 * Ficha de un lugar elegido con el buscador o un chip: nombre, coordenadas,
 * de qué catálogo sale y su badge de procedencia.
 */
export function PlaceCard({ place }: { readonly place: Place }) {
  const t = useT();
  const tr = useTr();
  return (
    <div className="mt-2 rounded border border-line bg-bg/40 p-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-fg">{place.name}</p>
          <p className="text-muted">
            {tr(KIND_LABEL[place.kind])} · {tr(place.detail)}
          </p>
        </div>
        <ProvenanceBadge source={place} />
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted">{formatLatLon(place)}</p>
      {place.source ? (
        <p className="mt-1 text-[11px] text-muted">
          {t("Fuente", "Source")}: {tr(place.source)}
        </p>
      ) : null}
      {place.link ? (
        <a
          href={place.link}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[11px] text-rust hover:underline"
        >
          {t("Ficha oficial del nomenclátor", "Official gazetteer entry")}
        </a>
      ) : null}
    </div>
  );
}
