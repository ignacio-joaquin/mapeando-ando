import { useId, useState, type KeyboardEvent } from "react";
import type { Place, PlacesIndex } from "../../api/schemas";
import { KIND_LABEL, searchPlaces } from "../../domain/places";
import { checkCoverage } from "../../map/coverage";
import { usePlan } from "../../state/plan";
import { useStore } from "../../state/store";
import { useT, useTr } from "../../i18n/lang";

/**
 * Elegir a dónde ir, como en Google Maps: buscar por nombre (IAU, cráter de
 * Robbins, sol del rover) o tocar un lugar sugerido. El clic en el mapa es la
 * tercera forma y vive en MapView. Todas pasan por el mismo chequeo de
 * cobertura: sin terreno de 1 m real, no hay destino.
 */
/** Cuántos sugeridos se ven antes de «más». */
const CHIPS = 6;

export function DestinationSearch() {
  const places = useStore((s) => s.places);
  const placesError = useStore((s) => s.placesError);
  const coverage = useStore((s) => s.coverage);
  const count = usePlan((s) => s.waypoints.length);
  const t = useT();
  const tr = useTr();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const listId = useId();

  const all = places?.places ?? [];
  const results = searchPlaces(all, query);
  const suggested = all.filter((p) => p.suggested);
  // Los sugeridos pueden ser una docena: de entrada, los primeros.
  const [allChips, setAllChips] = useState(false);
  const chips = allChips ? suggested : suggested.slice(0, CHIPS);
  const hasOrigin = count >= 1;
  const canStop = count >= 2;

  const pick = (place: Place, as: "destination" | "stop") => {
    const plan = usePlan.getState();
    const check = checkCoverage(coverage, place);
    if (check.kind === "outside") {
      plan.setNotice(`${place.name}: ${check.message}`);
      return;
    }
    if (as === "stop") plan.addStop(place, place.id);
    else plan.setDestination(place, place.id);
    setQuery("");
    setOpen(false);
  };

  const outside = (p: Place) => checkCoverage(coverage, p).kind === "outside";

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const p = results[active];
      if (p) {
        e.preventDefault();
        pick(p, e.shiftKey && canStop ? "stop" : "destination");
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <section className="flex flex-col gap-2" aria-label={t("Elegir destino", "Choose destination")}>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">
          {canStop ? t("Cambiar destino o sumar parada", "Change destination or add a stop") : t("Destino", "Destination")}
        </span>
        <div className="relative">
          <input
            type="search"
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls={listId}
            aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            disabled={!hasOrigin || all.length === 0}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKey}
            placeholder={
              !hasOrigin
                ? t("Primero marcá el hábitat en el mapa", "First mark the habitat on the map")
                : all.length === 0
                  ? t("Buscador sin lugares todavía", "Search has no places yet")
                  : t("Buscar: Belva, cráter 13-…, sol 120", "Search: Belva, crater 13-…, sol 120")
            }
            className="min-h-10 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg placeholder:text-muted/70 focus:border-rust focus:outline-none disabled:opacity-60"
          />
          {open && query && hasOrigin ? (
            <ul
              id={listId}
              role="listbox"
              className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-line bg-panel shadow-2xl"
            >
              {results.length === 0 ? (
                <li className="px-2 py-2 text-xs text-muted">
                  {t("Sin resultados para", "No results for")} “{query}”.
                </li>
              ) : (
                results.map((p, i) => {
                  const out = outside(p);
                  return (
                    <li
                      key={p.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      aria-disabled={out}
                      // mousedown, no click: el blur del input cerraría la lista antes.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(p, "destination");
                      }}
                      onMouseEnter={() => setActive(i)}
                      className={`flex cursor-pointer items-start justify-between gap-2 px-2 py-1.5 text-xs ${
                        i === active ? "bg-rust/15" : ""
                      } ${out ? "opacity-60" : ""}`}
                    >
                      <span className="min-w-0">
                        <span className="block font-semibold text-fg">{p.name}</span>
                        <span className="block text-muted">
                          {tr(KIND_LABEL[p.kind])} · {tr(p.detail)}
                        </span>
                        {out ? (
                          <span className="block font-semibold text-alert">
                            {t("✕ sin terreno de 1 m: no se puede elegir", "✕ no 1 m terrain: it cannot be chosen")}
                          </span>
                        ) : null}
                      </span>
                      {canStop && !out ? (
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            pick(p, "stop");
                          }}
                          className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:border-rust hover:text-fg"
                        >
                          + parada
                        </button>
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>
          ) : null}
        </div>
      </label>

      {canStop && query ? (
        <p className="text-[11px] text-muted">
          {t("Enter cambia el destino; Mayús+Enter lo suma como parada.", "Enter changes the destination; Shift+Enter adds it as a stop.")}
        </p>
      ) : null}

      {suggested.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">{t("Sugeridos", "Suggested")}</span>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((p) => {
              const out = outside(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!hasOrigin || out}
                  onClick={() => pick(p, "destination")}
                  title={out ? t("Sin terreno de 1 m real", "No real 1 m terrain") : `${tr(p.detail)} · ${tr(p.source ?? "")}`}
                  className="min-h-8 rounded-full border border-line px-3 text-xs text-fg hover:border-rust disabled:opacity-50"
                >
                  {p.name}
                  {out ? " ✕" : ""}
                </button>
              );
            })}
            {suggested.length > CHIPS ? (
              <button
                type="button"
                onClick={() => setAllChips(!allChips)}
                className="min-h-8 rounded-full px-2 text-xs text-rust hover:underline"
              >
                {allChips ? t("menos", "less") : t(`+${suggested.length - CHIPS} más`, `+${suggested.length - CHIPS} more`)}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {places === null ? (
        <p className="text-[11px] text-muted">
          {placesError
            ? `${t("No se pudo leer el índice de lugares", "Could not read the places index")}: ${tr(placesError)}`
            : t(
                "El buscador espera al pipeline (places.json). Mientras, elegí el destino con un clic en el mapa.",
                "Search is waiting for the pipeline (places.json). Meanwhile, choose the destination with a click on the map.",
              )}
        </p>
      ) : (
        <SourcesNote sources={places.sources} />
      )}
    </section>
  );
}

/** Qué fuentes alimentan el buscador y cuáles faltan: un índice a medias lo dice. */
function SourcesNote({
  sources,
}: {
  readonly sources: PlacesIndex["sources"];
}) {
  const missing = Object.values(sources).filter((s) => s.status !== "ok");
  const incomplete = Object.values(sources).filter((s) => s.status === "ok" && s.note);
  const t = useT();
  const tr = useTr();
  return (
    <details className="text-[11px] text-muted">
      <summary className="cursor-pointer">
        {t("De dónde salen los lugares", "Where the places come from")}
        {missing.length > 0 ? t(` · faltan ${missing.length} fuentes`, ` · ${missing.length} sources missing`) : ""}
        {incomplete.length > 0 ? t(` · ${incomplete.length} incompletas`, ` · ${incomplete.length} incomplete`) : ""}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5">
        {Object.entries(sources).map(([k, s]) => (
          <li key={k}>
            {s.status === "ok" ? (s.note ? "⚠" : "✓") : "✕"} {tr(s.desc)}
            {s.status === "ok"
              ? ` (${s.count ?? 0})`
              : s.status === "error"
                ? `${t(": falló al armar el índice", ": failed while building the index")}${s.error ? ` (${s.error})` : ""}`
                : t(": todavía no está", ": not there yet")}
            {s.note ? <span className="block pl-3 text-warn">{tr(s.note)}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
