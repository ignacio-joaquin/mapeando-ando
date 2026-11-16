import { localeNow, useT, useTr } from "../../i18n/lang";
import { useState } from "react";
import type { RouteSettings as Schema, SettingsGroup } from "../../api/schemas";
import { usingFixtures } from "../../api/client";
import { countOverrides, useSettings } from "../../state/settings";

type Field = Schema["groups"][number]["fields"][number];

const GROUP_HINT: Record<SettingsGroup, string> = {
  limits: "Si la ruta rompe uno, es NO-GO.",
  weights: "Cuánto evita la ruta cada cosa al elegir el camino. 0 = no le importa.",
  suit: "Supuestos del traje y de lo que llevás encima.",
};

/**
 * Pestaña Ajustes: los números con los que decide el planificador del server.
 * Todo (default, rango, unidad, texto) sale de GET /api/route/params; acá no
 * hay ningún número copiado. Solo viaja lo que el usuario cambia, y el
 * veredicto lo declara: no es la ruta con los valores del equipo.
 */
export function RouteSettings() {
  const schema = useSettings((s) => s.schema);
  const state = useSettings((s) => s.schemaState);
  const overrides = useSettings((s) => s.overrides);
  const n = countOverrides(overrides);
  const t = useT();
  const tr = useTr();

  if (usingFixtures) {
    return (
      <p className="rounded-lg border border-warn/60 bg-warn/10 p-3 text-xs">
        {t(
          "Sin backend no hay ajustes: el planificador de ejemplo usa parámetros fijos.",
          "Without a backend there are no settings: the sample planner uses fixed parameters.",
        )}
      </p>
    );
  }
  if (state === "loading") return <p className="text-xs text-muted">{t("Consultando qué se puede ajustar…", "Checking what can be adjusted…")}</p>;
  if (!schema) {
    return (
      <p className="rounded-lg border border-warn/60 bg-warn/10 p-3 text-xs">
        {state === "error"
          ? t("No se pudo leer qué ajustes acepta el server.", "Could not read which settings the server accepts.")
          : t(
              "El server todavía no acepta ajustes (falta GET /api/route/params): la ruta usa los valores del equipo.",
              "The server does not accept settings yet (GET /api/route/params is missing): the route uses the team's values.",
            )}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] leading-snug text-muted">
          {t(
            "Los valores por defecto son del equipo y del traje EMU de la ISS; varios todavía no tienen fuente citable. Si cambiás alguno, el veredicto lo dice.",
            "The default values come from the team and from the ISS EMU suit; several still have no citable source. If you change any, the verdict says so.",
          )}
        </p>
        <button
          type="button"
          disabled={n === 0}
          onClick={() => useSettings.getState().reset()}
          className="min-h-8 shrink-0 rounded-md border border-line px-2.5 text-xs text-fg hover:border-rust disabled:opacity-40"
        >
          {t("Restablecer", "Reset")}
          {n > 0 ? ` (${n})` : ""}
        </button>
      </div>

      {schema.groups.map((g) => (
        <section key={g.id} className="flex flex-col gap-1">
          <h3 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{g.label ? tr(g.label) : g.id}</h3>
          <p className="mb-1 text-[11px] text-muted">{tr(GROUP_HINT[g.id])}</p>
          <ul className="flex flex-col divide-y divide-line/60 rounded-lg border border-line">
            {g.fields.map((f) => (
              <SettingRow key={f.id} group={g.id} field={f} value={overrides[g.id]?.[f.id]} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const fmt = (v: number) => v.toLocaleString(localeNow(), { maximumFractionDigits: 3 });

function SettingRow({
  group,
  field,
  value,
}: {
  readonly group: SettingsGroup;
  readonly field: Field;
  readonly value: number | undefined;
}) {
  const changed = value !== undefined;
  const shown = value ?? field.default;
  // Lo que se tipea vive acá y se guarda recién al salir del campo o con Enter:
  // si se guardara en cada tecla, tipear "0,25" mandaría primero una ruta con 0.
  const [draft, setDraft] = useState<string | null>(null);
  const unit = field.unit === "fracción" ? null : field.unit;
  const min = field.min ?? undefined;
  const max = field.max ?? undefined;

  /** El número tipeado si es válido y está en rango; si no, null. */
  const parse = (raw: string): number | null => {
    const v = Number(raw.replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(v)) return null;
    if ((min !== undefined && v < min) || (max !== undefined && v > max)) return null;
    return v;
  };
  // Un valor inválido no se guarda: al salir del campo vuelve al que estaba.
  const commit = () => {
    const v = draft === null ? null : parse(draft);
    if (v !== null) useSettings.getState().set(group, field.id, v === field.default ? null : v);
    setDraft(null);
  };
  const invalid = draft !== null && parse(draft) === null;
  const t = useT();
  const tr = useTr();

  return (
    <li className={`flex flex-col gap-1.5 p-2.5 ${changed ? "bg-rust/5" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`set-${group}-${field.id}`} className="min-w-0 text-sm">
          {changed ? (
            <span aria-hidden className="mr-1 text-rust">
              ●
            </span>
          ) : null}
          {tr(field.label)}
          {changed ? <span className="sr-only">{t(" (cambiado)", " (changed)")}</span> : null}
        </label>
        <span className="flex shrink-0 items-center gap-1">
          <input
            id={`set-${group}-${field.id}`}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={field.step ?? "any"}
            value={draft ?? String(shown)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setDraft(null);
            }}
            aria-invalid={invalid}
            aria-describedby={`set-${group}-${field.id}-help`}
            className={`min-h-8 w-24 rounded-md border bg-bg px-2 text-right font-mono text-xs text-fg ${
              invalid ? "border-alert" : changed ? "border-rust" : "border-line"
            }`}
          />
          {unit ? <span className="w-9 text-[11px] text-muted">{tr(unit)}</span> : <span className="w-9" />}
        </span>
      </div>
      <p id={`set-${group}-${field.id}-help`} className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        <span>{tr(field.help)}</span>
        {invalid ? (
          <span className="text-alert">
            {t("Entre", "Between")} {min !== undefined ? fmt(min) : "−∞"} {t("y", "and")} {max !== undefined ? fmt(max) : "∞"}.
          </span>
        ) : null}
        {changed ? (
          <button
            type="button"
            onClick={() => useSettings.getState().set(group, field.id, null)}
            className="text-rust hover:underline"
          >
            {t("volver a", "back to")} {fmt(field.default)}
          </button>
        ) : null}
      </p>
    </li>
  );
}
