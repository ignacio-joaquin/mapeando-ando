import { localeNow, useT, useTr } from "../../i18n/lang";
import { useEffect } from "react";
import { fetchViewshed } from "../../api/client";
import type { ContactClass } from "../../api/schemas";
import { CONTACT_COLOR, CONTACT_LABEL, useContact } from "../../state/contact";
import { useFreshRoute, usePlan } from "../../state/plan";
import { useStore } from "../../state/store";
import { ProvenanceBadge } from "../ProvenanceBadge";

const ORDER: readonly ContactClass[] = ["contact", "no_contact", "unknown"];

/**
 * Pide la zona con contacto del hábitat cada vez que se mueve A. Va montado
 * siempre (en App), no dentro de un panel: la capa se tiene que poder ver
 * aunque el planificador esté en otra pestaña.
 *
 * Se prende sola cada vez que llega la zona de un hábitat nuevo: es lo que
 * explica un NO-GO por contacto. Si el usuario la apaga desde Capas, queda
 * apagada hasta que mueva el hábitat.
 */
export function useHabitatContact() {
  const siteId = useStore((s) => s.activeSiteId);
  const origin = usePlan((s) => s.waypoints[0]);
  const lat = origin?.lat;
  const lon = origin?.lon;

  useEffect(() => {
    const { setViewshed, setLoad, setVisible } = useContact.getState();
    setViewshed(null);
    if (lat === undefined || lon === undefined) {
      setLoad({ kind: "idle" });
      return;
    }
    setLoad({ kind: "loading" });
    const ctl = new AbortController();
    // Respiro: arrastrar el pin no dispara un pedido por cuadro.
    const t = setTimeout(() => {
      fetchViewshed(siteId, { lat, lon }, ctl.signal)
        .then((v) => {
          if (ctl.signal.aborted) return;
          setViewshed(v);
          setLoad(v ? { kind: "idle" } : { kind: "missing" });
          if (v) setVisible(true);
        })
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        });
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [siteId, lat, lon]);
}

/**
 * Qué dice la capa para el hábitat actual: estado del cálculo, cuánto del
 * área tiene vista y la procedencia. Lo usan el panel de capas y la pestaña
 * de seguridad.
 */
export function ContactStatus() {
  const origin = usePlan((s) => s.waypoints[0]);
  const viewshed = useContact((s) => s.viewshed);
  const load = useContact((s) => s.load);
  const fr = viewshed?.fractions;
  const t = useT();
  const tr = useTr();

  if (!origin) {
    return <p className="text-[11px] text-muted">{t("Aparece sola al marcar el hábitat (A).", "It appears on its own when you mark the habitat (A).")}</p>;
  }
  if (load.kind === "loading") {
    return (
      <p role="status" className="text-[11px] text-muted">
        {t("Calculando la línea de vista desde A…", "Calculating the line of sight from A…")}
      </p>
    );
  }
  if (load.kind === "missing") {
    return <p className="text-[11px] text-warn">{t("⚠ El server todavía no calcula la línea de vista.", "⚠ The server does not calculate the line of sight yet.")}</p>;
  }
  if (load.kind === "error") {
    return (
      <p className="text-[11px] text-alert">
        {t("✕ No se pudo calcular el contacto.", "✕ Could not calculate contact.")} {tr(load.message)}
      </p>
    );
  }
  if (viewshed?.note) return <p className="text-[11px] text-warn">⚠ {tr(viewshed.note)}</p>;
  if (!viewshed || !fr) return null;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <ul className="flex flex-col gap-0.5">
        {ORDER.map((k) => (
          <li key={k} className="flex items-center gap-2">
            <Swatch kind={k} />
            <span className="flex-1 text-[11px] text-muted">{tr(CONTACT_LABEL[k])}</span>
            <span className="font-mono text-[11px] text-muted">{Math.round((fr[k] ?? 0) * 100)} %</span>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        {t("Hasta", "Up to")} {((viewshed.radius_m ?? 0) / 1000).toLocaleString(localeNow())} {t("km de A", "km from A")}
        {viewshed.source ? <ProvenanceBadge source={viewshed.source} align="left" /> : null}
      </p>
    </div>
  );
}

/** Fila «Contacto con el hábitat» del panel de capas: toggle como cualquier otra capa. */
export function ContactLayerRow() {
  const visible = useContact((s) => s.visible);
  const origin = usePlan((s) => s.waypoints[0]);
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <label className="flex min-h-7 cursor-pointer items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => useContact.getState().setVisible(e.target.checked)}
          className="size-4 shrink-0 accent-rust"
        />
        <span>
          {t("Contacto con el hábitat", "Contact with the habitat")}
          <span className="ml-1 text-xs text-muted">{t("(línea de vista)", "(line of sight)")}</span>
        </span>
      </label>
      <div className="flex flex-col gap-1.5 pl-6.5">
        <p className="text-[11px] text-muted">
          {t(
            "Desde dónde la radio del traje ve la antena del hábitat, sin repetidores.",
            "Where the suit radio can see the habitat antenna, without repeaters.",
          )}
          {origin ? t(" Se prende sola cada vez que movés el hábitat.", " It turns on by itself every time you move the habitat.") : ""}
        </p>
        <ContactStatus />
      </div>
    </div>
  );
}

/** Tarjeta de la pestaña de seguridad: qué significa la zona para esta travesía. */
export function HabitatContact() {
  const origin = usePlan((s) => s.waypoints[0]);
  const visible = useContact((s) => s.visible);
  const result = useFreshRoute();
  const t = useT();
  if (!origin) return null;

  const limit = result?.route.verdict.limits?.find((l) => l.id === "contact");
  const capMin = limit?.limit.value ?? null;

  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{t("Contacto con el hábitat", "Contact with the habitat")}</h3>
        <button
          type="button"
          onClick={() => useContact.getState().setVisible(!visible)}
          aria-pressed={visible}
          className="min-h-7 rounded-md border border-line px-2 text-[11px] text-muted hover:text-fg aria-pressed:border-rust aria-pressed:text-fg"
        >
          {visible ? t("✓ en el mapa", "✓ on the map") : t("ver en el mapa", "see on the map")}
        </button>
      </div>
      <p className="text-[11px] text-muted">
        {t(
          "Desde dónde la radio del traje ve la antena del hábitat (A), sin repetidores.",
          "Where the suit radio can see the habitat antenna (A), without repeaters.",
        )}
        {capMin !== null
          ? t(
              ` Afuera de la zona con vista no podés estar más de ${Math.round(capMin)} min seguidos.`,
              ` Outside the line-of-sight zone you cannot spend more than ${Math.round(capMin)} min in a row.`,
            )
          : ""}
      </p>
      <ContactStatus />
    </section>
  );
}

function Swatch({ kind }: { readonly kind: ContactClass }) {
  const color = CONTACT_COLOR[kind];
  // Sin contacto va rayado también acá, como en el mapa.
  const background =
    kind === "no_contact"
      ? `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 5px)`
      : color;
  return (
    <span
      aria-hidden
      className={`inline-block size-3.5 rounded-sm border border-line ${kind === "contact" ? "opacity-60" : ""}`}
      style={{ background }}
    />
  );
}
