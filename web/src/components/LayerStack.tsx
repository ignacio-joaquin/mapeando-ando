import { LAYERS, type LayerGroup } from "../map/layers";
import { pipelineError, terrainLayer } from "../map/terrain";
import { useStore } from "../state/store";
import { ProvenanceBadge } from "./ProvenanceBadge";

const GROUP_LABEL: Record<LayerGroup, string> = {
  relieve: "Relieve",
  supervivencia: "Supervivencia",
};

/**
 * Stack de capas: toggle, opacidad, leyenda con unidad y badge de procedencia.
 * El badge de la tarjeta cubre los números de la leyenda (umbrales, equidistancia).
 * Una capa sin salida del pipeline no se puede prender y lo dice: si todavía
 * no corrió, o si corrió y falló (con el motivo, de terrain.json).
 */
export function LayerStack() {
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const setOpacity = useStore((s) => s.setOpacity);
  const terrain = useStore((s) => s.terrain);
  const terrainError = useStore((s) => s.terrainError);

  return (
    <div className="flex flex-col gap-4">
      {terrainError ? (
        <p role="alert" className="rounded border border-alert p-2 text-xs text-alert">
          ⚠ No se pudo leer el índice de capas del pipeline: {terrainError}
        </p>
      ) : null}
      {(Object.keys(GROUP_LABEL) as LayerGroup[]).map((group) => (
        <section key={group}>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
            {GROUP_LABEL[group]}
          </h3>
          <ul className="flex flex-col gap-3">
            {LAYERS.filter((l) => l.group === group).map((spec) => {
              const state = layers[spec.id];
              if (!state) return null;
              const disabled = !state.available;
              const failed = pipelineError(terrain, spec.id);
              // La resolución medida por el pipeline le gana a la nominal.
              const resolution = terrainLayer(terrain, spec.id)?.resolution ?? spec.source.resolution;
              return (
                <li
                  key={spec.id}
                  // Sin opacity en el <li>: atraparía el tooltip del badge. El z al
                  // hover/foco deja el tooltip por encima de la tarjeta siguiente.
                  className="relative rounded border border-line p-2 focus-within:z-20 hover:z-20"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <label
                      className={`flex items-center gap-2 text-sm ${disabled ? "opacity-60" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={state.visible && state.available}
                        disabled={disabled}
                        onChange={() => toggleLayer(spec.id)}
                        className="accent-rust"
                      />
                      <span>{spec.label}</span>
                      {spec.unit ? (
                        <span className="text-xs text-muted">({spec.unit})</span>
                      ) : null}
                    </label>
                    <ProvenanceBadge source={spec.source} />
                  </div>

                  {disabled ? (
                    <p className="mt-1.5 text-xs text-warn" title={failed ?? undefined}>
                      {failed
                        ? `⚠ El pipeline no pudo generarla. Hay que volver a correr ${spec.script ?? "precompute.py"}.`
                        : "Esperando la salida del pipeline (MAP-9)."}
                    </p>
                  ) : (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[10px] text-muted">opacidad</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={state.opacity}
                        onChange={(e) => setOpacity(spec.id, Number(e.target.value))}
                        className="h-1 flex-1 accent-rust"
                        aria-label={"Opacidad de " + spec.label}
                      />
                      <span className="w-8 text-right text-[10px] text-muted">
                        {Math.round(state.opacity * 100)}%
                      </span>
                    </div>
                  )}

                  {resolution ? <p className="mt-1 text-[10px] text-muted">{resolution}</p> : null}

                  <ul
                    className={`mt-2 flex flex-wrap gap-x-3 gap-y-1 ${disabled ? "opacity-60" : ""}`}
                  >
                    {spec.legend.map((stop) => (
                      <li
                        key={stop.label}
                        className="flex items-center gap-1.5 text-[11px] text-muted"
                      >
                        <span
                          aria-hidden
                          className="inline-block size-2.5 rounded-sm border border-line"
                          style={{ background: stop.color }}
                        />
                        {stop.label}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
