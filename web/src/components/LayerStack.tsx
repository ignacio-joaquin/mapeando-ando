import { LAYERS, type LayerGroup } from "../map/layers";
import { useStore } from "../state/store";
import { SourceBadge } from "./SourceBadge";

const GROUP_LABEL: Record<LayerGroup, string> = {
  relieve: "Relieve",
  supervivencia: "Supervivencia",
};

/**
 * Stack de capas: toggle, opacidad, leyenda con unidad y badge de procedencia.
 * Una capa sin salida del pipeline no se puede prender y lo dice.
 */
export function LayerStack() {
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const setOpacity = useStore((s) => s.setOpacity);

  return (
    <div className="flex flex-col gap-4">
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
              return (
                <li
                  key={spec.id}
                  className={disabled ? "rounded border border-line p-2 opacity-60" : "rounded border border-line p-2"}
                >
                  <div className="flex items-start justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm">
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
                    <SourceBadge
                      mission={spec.source.mission}
                      instrument={spec.source.instrument}
                      resolution={spec.resolution}
                    />
                  </div>

                  {disabled ? (
                    <p className="mt-1.5 text-xs text-warn">
                      Esperando la salida del pipeline (MAP-9).
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

                  <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
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
