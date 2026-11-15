import { useEffect } from "react";
import { fetchViewshed } from "../../api/client";
import type { ContactClass } from "../../api/schemas";
import { CONTACT_COLOR, CONTACT_LABEL, useContact } from "../../state/contact";
import { useFreshRoute, usePlan } from "../../state/plan";
import { useStore } from "../../state/store";
import { ProvenanceBadge } from "../ProvenanceBadge";

const ORDER: readonly ContactClass[] = ["contact", "no_contact", "unknown"];

/**
 * Pide la zona con contacto del hábitat cada vez que se mueve A y muestra la
 * leyenda. El mapa la dibuja desde el mismo store (map/MapView.tsx, capa
 * `habitat-contact`).
 */
export function HabitatContact() {
  const siteId = useStore((s) => s.activeSiteId);
  const origin = usePlan((s) => s.waypoints[0]);
  const visible = useContact((s) => s.visible);
  const viewshed = useContact((s) => s.viewshed);
  const load = useContact((s) => s.load);
  const result = useFreshRoute();
  const lat = origin?.lat;
  const lon = origin?.lon;

  useEffect(() => {
    const { setViewshed, setLoad } = useContact.getState();
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

  if (!origin) return null;

  const limit = result?.route.verdict.limits?.find((l) => l.id === "contact");
  const capMin = limit?.limit.value ?? null;
  const fr = viewshed?.fractions;

  return (
    <section className="rounded border border-line p-2 text-xs">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => useContact.getState().setVisible(e.target.checked)}
          className="mt-0.5 size-4 accent-rust"
        />
        <span>
          <span className="text-fg">Contacto con el hábitat</span>
          <span className="block text-[11px] text-muted">
            Desde dónde la radio del traje ve la antena del hábitat (A), sin repetidores.
            {capMin !== null
              ? ` Afuera de la zona con vista no podés estar más de ${Math.round(capMin)} min seguidos.`
              : ""}
          </span>
        </span>
      </label>

      {load.kind === "loading" ? (
        <p role="status" className="mt-1.5 text-muted">
          Calculando la línea de vista desde A…
        </p>
      ) : load.kind === "missing" ? (
        <p className="mt-1.5 text-warn">⚠ El server todavía no calcula la línea de vista: la capa no se dibuja.</p>
      ) : load.kind === "error" ? (
        <p className="mt-1.5 text-alert">✕ No se pudo calcular el contacto. {load.message}</p>
      ) : viewshed?.note ? (
        <p className="mt-1.5 text-warn">⚠ {viewshed.note}</p>
      ) : viewshed && fr ? (
        <div className="mt-1.5 flex flex-col gap-1">
          <ul className="flex flex-col gap-0.5">
            {ORDER.map((k) => (
              <li key={k} className="flex items-center gap-2">
                <Swatch kind={k} />
                <span className="flex-1">{CONTACT_LABEL[k]}</span>
                <span className="font-mono text-muted">{Math.round((fr[k] ?? 0) * 100)} %</span>
              </li>
            ))}
          </ul>
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            Hasta {((viewshed.radius_m ?? 0) / 1000).toLocaleString("es-AR")} km de A
            {viewshed.source ? <ProvenanceBadge source={viewshed.source} align="left" /> : null}
          </p>
        </div>
      ) : null}
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
