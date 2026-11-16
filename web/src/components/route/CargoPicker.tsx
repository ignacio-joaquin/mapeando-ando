import { localeNow, useT, useTr } from "../../i18n/lang";
import { useState } from "react";
import {
  cargoKg,
  EQUIPMENT,
  EXTRA_SOURCE,
  itemKg,
  itemSource,
  MAX_EXTRA_KG,
} from "../../domain/equipment";
import { usePlan } from "../../state/plan";
import { ProvenanceBadge } from "../ProvenanceBadge";

const kg = (v: number) => v.toLocaleString(localeNow(), { maximumFractionDigits: 1 });

/**
 * Qué equipo se lleva (MAP-50). Cada tilde suma su masa a `cargo_kg` y el
 * planificador recalcula: más carga, más O2, y el veredicto puede pasar a NO-GO.
 *
 * Botones grandes con el estado escrito (✓ / +), no solo pintado: se usa con
 * guantes y el estado no se comunica solo por color.
 */
export function CargoPicker() {
  const kit = usePlan((s) => s.kit);
  const extraKg = usePlan((s) => s.extraKg);
  const { toggleEquipment, setExtraKg } = usePlan.getState();
  const [open, setOpen] = useState(kit.length > 0 || extraKg > 0);
  const total = cargoKg(kit, extraKg);
  const t = useT();
  const tr = useTr();

  return (
    <section data-edu="cargo" className="rounded border border-line p-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left text-xs"
      >
        <span className="font-semibold tracking-wide text-muted uppercase">{t("Carga del equipo", "Equipment load")}</span>
        <span className="flex items-center gap-2">
          <span className={`font-mono text-sm ${total > 0 ? "text-rust" : "text-muted"}`}>
            {kg(total)} kg
          </span>
          <span aria-hidden className="text-muted">
            {open ? "▴" : "▾"}
          </span>
        </span>
      </button>

      {open ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <ul className="flex flex-col gap-1">
            {EQUIPMENT.map((e) => {
              const on = kit.includes(e.id);
              return (
                <li key={e.id} className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleEquipment(e.id)}
                    className={`flex min-h-10 flex-1 items-center gap-2 rounded border px-2 py-1 text-left ${
                      on ? "border-rust bg-rust/15" : "border-line hover:border-fg/40"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`w-4 shrink-0 text-center font-bold ${on ? "text-rust" : "text-muted"}`}
                    >
                      {on ? "✓" : "+"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-fg">{tr(e.name)}</span>
                      <span className="block text-[11px] leading-tight text-muted">{tr(e.use)}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-fg">{kg(itemKg(e))} kg</span>
                  </button>
                  <ProvenanceBadge source={itemSource(e)} />
                </li>
              );
            })}
          </ul>

          <label className="flex items-center gap-2 text-xs">
            <span className="flex-1 text-muted">{t("Otra carga (muestras juntadas, etc.)", "Other load (collected samples, etc.)")}</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_EXTRA_KG}
              step={0.5}
              // Vacío en vez de "0": si no, al borrar el campo vuelve un 0 y al
              // tipear queda "05".
              placeholder="0"
              value={extraKg > 0 ? extraKg : ""}
              onChange={(ev) => setExtraKg(ev.target.valueAsNumber)}
              className="w-20 rounded border border-line bg-bg px-2 py-1 text-right font-mono text-xs text-fg"
            />
            <span className="text-muted">kg</span>
            <ProvenanceBadge source={EXTRA_SOURCE} />
          </label>

          <p className="text-[11px] leading-snug text-muted">
            {t(
              "Masas en la Tierra: en Marte pesan el 38 %, y el modelo ya lo cuenta. La carga entra a Pandolf y sube el O2 que gastás caminando y parado. Con este modelo no cambia los tiempos (la velocidad es fija) ni la batería (no depende del esfuerzo).",
              "Masses on Earth: on Mars they weigh 38 %, and the model already accounts for it. The load goes into Pandolf and raises the O2 you use walking and standing. With this model it does not change the times (speed is fixed) or the battery (it does not depend on effort).",
            )}
          </p>
        </div>
      ) : null}
    </section>
  );
}
