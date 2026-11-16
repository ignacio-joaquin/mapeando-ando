import type { Place } from "../../api/schemas";
import { KIND_LABEL } from "../../domain/places";
import { checkCoverage } from "../../map/coverage";
import { PLACE_KIND_STYLE } from "../../map/places";
import { formatLatLon } from "../../mars/geo";
import { usePlan } from "../../state/plan";
import { useStore } from "../../state/store";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { useT, useTr } from "../../i18n/lang";

/**
 * Ficha de un pin tocado en el mapa, como el globo de Google Maps: qué es, de
 * dónde sale el dato y qué hacer con él (hábitat, destino o parada). Pasa por
 * el mismo chequeo de cobertura que el buscador y el clic en el mapa.
 */
export function PlacePopup({ place, onClose }: { readonly place: Place; readonly onClose: () => void }) {
  const coverage = useStore((s) => s.coverage);
  const waypoints = usePlan((s) => s.waypoints);
  const style = PLACE_KIND_STYLE[place.kind];
  const check = checkCoverage(coverage, place);
  const outside = check.kind === "outside";
  const inRoute = waypoints.some((w) => w.placeId === place.id);
  const count = waypoints.length;
  const t = useT();
  const tr = useTr();

  const act = (as: "origin" | "destination" | "stop") => {
    const plan = usePlan.getState();
    if (as === "origin") plan.addPoint(place, place.id);
    else if (as === "stop") plan.addStop(place, place.id);
    else plan.setDestination(place, place.id);
    onClose();
  };

  const btn =
    "min-h-9 rounded border-2 px-2.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="w-64 text-xs text-fg">
      {/* pr-7: lugar para la cruz de cerrar del popup. */}
      <div className="flex items-start justify-between gap-2 pr-7">
        <p className="min-w-0 text-sm leading-tight font-semibold">{place.name}</p>
        <ProvenanceBadge source={place} />
      </div>
      <p className="mt-1 flex items-center gap-1 text-muted">
        <span
          aria-hidden
          className="inline-grid size-4 shrink-0 place-items-center rounded-full border border-black text-[9px] font-bold text-black"
          style={{ background: style.color }}
        >
          {style.glyph}
        </span>
        {tr(KIND_LABEL[place.kind])}
      </p>
      {place.detail ? <p className="mt-1.5 text-muted">{tr(place.detail)}</p> : null}
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

      {outside ? (
        <p className="mt-2 font-semibold text-alert">
          {t("✕ Sin terreno de 1 m real acá: no se puede ir.", "✕ No real 1 m terrain here: you cannot go.")}
        </p>
      ) : check.kind === "unverified" ? (
        <p className="mt-2 text-warn">
          {t("⚠ No se pudo verificar el terreno de 1 m (falta la huella del DTM).", "⚠ Could not verify the 1 m terrain (the DTM footprint is missing).")}
        </p>
      ) : null}
      {inRoute ? <p className="mt-2 text-ok">{t("✓ Ya está en la travesía", "✓ Already in the traverse")}</p> : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {count === 0 ? (
          <button
            type="button"
            disabled={outside}
            onClick={() => act("origin")}
            className={`${btn} border-ok bg-ok/20 hover:bg-ok/30`}
          >
            {t("Poner el hábitat acá", "Put the habitat here")}
          </button>
        ) : (
          <button
            type="button"
            disabled={outside}
            onClick={() => act("destination")}
            className={`${btn} border-rust bg-rust/20 hover:bg-rust/30`}
          >
            {count === 1 ? t("Ir acá", "Go here") : t("Cambiar destino", "Change destination")}
          </button>
        )}
        {count >= 2 ? (
          <button
            type="button"
            disabled={outside}
            onClick={() => act("stop")}
            className={`${btn} border-line hover:border-rust`}
          >
            {t("+ parada", "+ stop")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
