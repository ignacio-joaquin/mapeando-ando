import { useId, useState, type KeyboardEvent } from "react";
import type { Place } from "../../api/schemas";
import { KIND_LABEL, searchPlaces } from "../../domain/places";
import { checkCoverage } from "../../map/coverage";
import { usePlan } from "../../state/plan";
import { useStore } from "../../state/store";

/**
 * Elegir a dónde ir, como en Google Maps: buscar por nombre (IAU, cráter de
 * Robbins, sol del rover) o tocar un lugar sugerido. El clic en el mapa es la
 * tercera forma y vive en MapView. Todas pasan por el mismo chequeo de
 * cobertura: sin terreno de 1 m real, no hay destino.
 */
export function DestinationSearch() {
  const places = useStore((s) => s.places);
  const placesError = useStore((s) => s.placesError);
  const coverage = useStore((s) => s.coverage);
  const count = usePlan((s) => s.waypoints.length);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const listId = useId();

  const all = places?.places ?? [];
  const results = searchPlaces(all, query);
  const suggested = all.filter((p) => p.suggested);
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
    <section className="flex flex-col gap-2 rounded border border-line p-2" aria-label="Elegir destino">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted">{canStop ? "Cambiar destino o sumar parada" : "Destino"}</span>
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
                ? "Primero marcá el hábitat en el mapa"
                : all.length === 0
                  ? "Buscador sin lugares todavía"
                  : "Buscar: Belva, cráter 13-…, sol 120"
            }
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-sm text-fg placeholder:text-muted/70 disabled:opacity-60"
          />
          {open && query && hasOrigin ? (
            <ul
              id={listId}
              role="listbox"
              className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-y-auto rounded border border-line bg-panel shadow-lg"
            >
              {results.length === 0 ? (
                <li className="px-2 py-2 text-xs text-muted">Sin resultados para “{query}”.</li>
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
                          {KIND_LABEL[p.kind]} · {p.detail}
                        </span>
                        {out ? (
                          <span className="block font-semibold text-alert">
                            ✕ sin terreno de 1 m: no se puede elegir
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
        <p className="text-[11px] text-muted">Enter cambia el destino; Mayús+Enter lo suma como parada.</p>
      ) : null}

      {suggested.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Lugares sugeridos</span>
          <div className="flex flex-wrap gap-1.5">
            {suggested.map((p) => {
              const out = outside(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!hasOrigin || out}
                  onClick={() => pick(p, "destination")}
                  title={out ? "Sin terreno de 1 m real" : `${p.detail} · ${p.source ?? ""}`}
                  className="rounded-full border border-line px-2.5 py-1 text-xs text-fg hover:border-rust disabled:opacity-50"
                >
                  {p.name}
                  {out ? " ✕" : ""}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {places === null ? (
        <p className="text-[11px] text-muted">
          {placesError
            ? `No se pudo leer el índice de lugares: ${placesError}`
            : "El buscador espera al pipeline (places.json). Mientras, elegí el destino con un clic en el mapa."}
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
  readonly sources: Readonly<Record<string, { status: string; desc: string; count?: number | undefined }>>;
}) {
  const missing = Object.values(sources).filter((s) => s.status !== "ok");
  return (
    <details className="text-[11px] text-muted">
      <summary className="cursor-pointer">
        De dónde salen los lugares{missing.length > 0 ? ` · faltan ${missing.length} fuentes` : ""}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5">
        {Object.entries(sources).map(([k, s]) => (
          <li key={k}>
            {s.status === "ok" ? "✓" : "✕"} {s.desc}
            {s.status === "ok" ? ` (${s.count ?? 0})` : ": todavía no está"}
          </li>
        ))}
      </ul>
    </details>
  );
}
