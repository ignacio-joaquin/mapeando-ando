import { useEffect, useRef, useState } from "react";
import { EDU_TARGET } from "../edu/lessons";
import { useLessonShows } from "../edu/useLessonShows";
import { LAYERS, type LayerGroup } from "../map/layers";
import { pipelineError, readyTiles, terrainLayer } from "../map/terrain";
import { useStore } from "../state/store";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { PLACE_KIND_STYLE, PLACE_KINDS } from "../map/places";
import { KIND_LABEL } from "../domain/places";
import { LEG_CLASS_COLOR, LEG_CLASS_LABEL } from "../map/route";
import { useDismiss } from "./useDismiss";
import { ContactLayerRow } from "./route/HabitatContact";
import { useContact } from "../state/contact";

const GROUP_LABEL: Record<LayerGroup, string> = {
  relieve: "Relieve",
  supervivencia: "Supervivencia",
};

/** Cuántas capas hay prendidas (y con salida del pipeline). */
function useLayersOn(): number {
  const layers = useStore((s) => s.layers);
  const contact = useContact((s) => s.visible && s.viewshed !== null);
  return (
    LAYERS.filter((l) => !l.hidden && layers[l.id]?.visible && layers[l.id]?.available).length +
    (contact ? 1 : 0)
  );
}

/**
 * Las capas tienen su propia columna, a la derecha y separada del
 * planificador: lo que se ve en el mapa se elige acá y en ningún otro lado.
 * Solo en pantallas anchas; en las demás, LayersButton abre el mismo panel.
 */
export function LayersPanel() {
  const on = useLayersOn();
  return (
    <aside
      aria-label="Capas del mapa"
      data-edu="right"
      className="hidden w-80 shrink-0 flex-col border-l border-line bg-panel md:order-3 lg:flex"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <h2 className="text-base font-bold">Capas</h2>
        <span className="text-[11px] text-muted">{on} prendidas</span>
      </header>
      <div data-edu="layers" className="min-h-0 flex-1 overflow-y-auto p-3">
        <LayerStack />
      </div>
    </aside>
  );
}

/**
 * Botón «Capas» sobre el mapa para pantallas sin la columna de la derecha.
 * Abre el mismo stack en un desplegable.
 */
export function LayersButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const on = useLayersOn();
  // Sin la columna de la derecha, una lección que señala las capas abre el desplegable.
  const lessonShows = useLessonShows([EDU_TARGET.LAYERS]);
  useEffect(() => {
    if (lessonShows) setOpen(true);
  }, [lessonShows]);

  return (
    <div ref={ref} className="pointer-events-auto relative lg:hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-panel/95 px-2.5 text-sm font-semibold shadow-lg backdrop-blur hover:border-muted aria-expanded:border-rust"
      >
        <span aria-hidden>▤</span>
        Capas
        <span className="hidden rounded-full bg-line px-1.5 text-[11px] font-normal text-muted tabular-nums sm:inline">
          {on}
        </span>
      </button>
      {open ? (
        <div className="absolute top-full left-0 z-40 mt-1.5 max-h-[min(70dvh,640px)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-line bg-panel p-3 shadow-2xl">
          <LayerStack />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Stack de capas: toggle, y para las prendidas leyenda, resolución y
 * opacidad. El badge de cada fila cubre los números de su leyenda (umbrales,
 * equidistancia). Una capa sin salida del pipeline no se puede prender y lo
 * dice: si todavía no corrió, o si corrió y falló (con el motivo, de terrain.json).
 */
export function LayerStack() {
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const setOpacity = useStore((s) => s.setOpacity);
  const terrain = useStore((s) => s.terrain);
  const terrainError = useStore((s) => s.terrainError);
  const zoom = useStore((s) => s.view?.zoom ?? null);

  return (
    <div className="flex flex-col gap-5">
      {terrainError ? (
        <p role="alert" className="rounded-md border border-alert bg-alert/10 p-2 text-xs text-fg">
          <strong className="text-alert">⚠ </strong>No se pudo leer el índice de capas: {terrainError}
        </p>
      ) : null}
      {(Object.keys(GROUP_LABEL) as LayerGroup[]).map((group) => (
        <section key={group}>
          <GroupTitle>{GROUP_LABEL[group]}</GroupTitle>
          <ul className="flex flex-col divide-y divide-line/60">
            {LAYERS.filter((l) => l.group === group && !l.hidden).map((spec) => {
              const state = layers[spec.id];
              if (!state) return null;
              const disabled = !state.available;
              const shown = state.visible && !disabled;
              const failed = pipelineError(terrain, spec.id);
              // La resolución medida por el pipeline le gana a la nominal.
              const piped = terrainLayer(terrain, spec.id);
              const resolution = piped?.resolution ?? spec.source.resolution;
              // El badge dice lo que usó la corrida (terrain.json), no lo que podría haber usado.
              const source = {
                ...spec.source,
                mission: piped?.mission !== undefined ? piped.mission : spec.source.mission,
                instrument: piped?.instrument !== undefined ? piped.instrument : spec.source.instrument,
              };
              // Por debajo del zoom mínimo de sus tiles la capa no dibuja nada: sin este
              // aviso, prenderla de lejos (Gale abre en zoom ~9) parece no hacer nada.
              // Solo vectoriales: las raster van con tileSize 256 y MapLibre ya las dibuja
              // desde un zoom antes de su minzoom, así que el aviso mentiría por uno.
              const minzoom = spec.kind === "vector" ? readyTiles(terrain, spec.id)?.minzoom : undefined;
              const tooFar = shown && minzoom !== undefined && zoom !== null && zoom < minzoom;
              return (
                // Sin opacity en el <li>: atraparía el tooltip del badge. El z al
                // hover/foco deja el tooltip por encima de la fila siguiente.
                <li key={spec.id} className="relative py-2 focus-within:z-20 hover:z-20">
                  <label
                    className={`flex min-h-7 items-center gap-2.5 text-sm ${disabled ? "text-muted" : "cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      checked={shown}
                      disabled={disabled}
                      onChange={() => toggleLayer(spec.id)}
                      className="size-4 shrink-0 accent-rust"
                    />
                    <span>
                      {spec.label}
                      {spec.unit ? <span className="ml-1 text-xs text-muted">({spec.unit})</span> : null}
                    </span>
                  </label>
                  <div className="pl-6.5">
                    <ProvenanceBadge source={{ ...source, resolution }} align="left" />
                  </div>

                  {disabled ? (
                    <p className="mt-1 pl-6.5 text-[11px] text-warn" title={failed ?? undefined}>
                      {failed
                        ? `⚠ Falló en el pipeline: volver a correr ${spec.script ?? "precompute.py"}.`
                        : "Esperando la salida del pipeline."}
                    </p>
                  ) : null}

                  {tooFar ? (
                    <p role="status" className="mt-1 pl-6.5 text-[11px] text-warn">
                      🔍 Acercá el mapa para verla: aparece desde el zoom {minzoom} (ahora{" "}
                      {zoom.toFixed(1)}).
                    </p>
                  ) : null}

                  {shown ? (
                    <div className="mt-1.5 flex flex-col gap-1.5 pl-6.5">
                      <ul className="flex flex-wrap gap-x-3 gap-y-1">
                        {spec.legend.map((stop) => (
                          <li key={stop.label} className="flex items-center gap-1.5 text-[11px] text-muted">
                            <span
                              aria-hidden
                              className="inline-block size-2.5 rounded-sm border border-line"
                              style={{ background: stop.color }}
                            />
                            {stop.label}
                          </li>
                        ))}
                      </ul>
                      {resolution ? <p className="text-[10px] text-muted">{resolution}</p> : null}
                      <label className="flex items-center gap-2">
                        <span className="sr-only">Opacidad de {spec.label}</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={state.opacity}
                          onChange={(e) => setOpacity(spec.id, Number(e.target.value))}
                          className="h-1 flex-1 accent-rust"
                        />
                        <span className="w-9 text-right text-[10px] text-muted tabular-nums">
                          {Math.round(state.opacity * 100)}%
                        </span>
                      </label>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <section>
        <GroupTitle>Señal</GroupTitle>
        <ContactLayerRow />
      </section>
      <PlacePins />
      <RouteLegend />
    </div>
  );
}

function GroupTitle({ children }: { readonly children: string }) {
  return <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{children}</h3>;
}

/**
 * Pines de lugares en el mapa, por tipo. Un tipo sin lugares en este sitio
 * (o sin places.json todavía) no se puede prender y lo dice.
 */
function PlacePins() {
  const places = useStore((s) => s.places);
  const placesError = useStore((s) => s.placesError);
  const placeKinds = useStore((s) => s.placeKinds);
  const togglePlaceKind = useStore((s) => s.togglePlaceKind);
  const counts = new Map<string, number>();
  for (const p of places?.places ?? []) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);

  return (
    <section>
      <GroupTitle>Lugares en el mapa</GroupTitle>
      {places === null ? (
        <p className="text-[11px] text-warn">
          {placesError ? "No se pudo leer el índice de lugares." : "Esperando la salida del pipeline (places.json)."}
        </p>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-x-2">
            {PLACE_KINDS.map((kind) => {
              const n = counts.get(kind) ?? 0;
              const style = PLACE_KIND_STYLE[kind];
              return (
                <li key={kind}>
                  <label
                    className={`flex min-h-8 items-center gap-2 text-xs ${n === 0 ? "text-muted" : "cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      checked={placeKinds[kind] && n > 0}
                      disabled={n === 0}
                      onChange={() => togglePlaceKind(kind)}
                      className="size-4 accent-rust"
                    />
                    <span
                      aria-hidden
                      className="inline-grid size-5 shrink-0 place-items-center rounded-full border border-black text-[10px] font-bold text-black"
                      style={{ background: style.color }}
                    >
                      {style.glyph}
                    </span>
                    <span className="truncate first-letter:uppercase">{KIND_LABEL[kind]}</span>
                    <span className="ml-auto text-[11px] text-muted tabular-nums">{n}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-[11px] text-muted">Tocá un pin para ver su ficha y sumarlo a la travesía.</p>
        </>
      )}
    </section>
  );
}

/** Qué significa el color de cada tramo de la ruta dibujada. */
function RouteLegend() {
  return (
    <section>
      <GroupTitle>Tramos de la ruta</GroupTitle>
      <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
        {(Object.keys(LEG_CLASS_COLOR) as (keyof typeof LEG_CLASS_COLOR)[]).map((k) => (
          <li key={k} className="flex items-center gap-2 text-[11px] text-muted">
            <span
              aria-hidden
              className={`inline-block h-1 w-5 shrink-0 rounded ${k === "unknown" ? "opacity-70" : ""}`}
              style={{ background: LEG_CLASS_COLOR[k] }}
            />
            {LEG_CLASS_LABEL[k]}
            {k === "unknown" ? " (punteada)" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
