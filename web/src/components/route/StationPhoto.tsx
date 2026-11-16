import { lazy, Suspense, useEffect, useState } from "react";
import { fetchRoverPhotos } from "../../api/client";
import type { RoverComposition, RoverPhoto, RoverPhotos } from "../../api/schemas";
import type { SourceInfo } from "../../domain/provenance";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { formatDistanceM } from "./format";
import { tNow, useT, useTr } from "../../i18n/lang";

/**
 * "Lo que vas a ver al llegar": la foto real del rover más cercana a la
 * estación, con sol, cámara y crédito. Las fotos salen del backend (MAP-33);
 * si no hay, se dice que falta. Nunca una foto de ejemplo.
 *
 * Al lado se abre nuestro render del horizonte desde el mismo punto (MAP-43),
 * para comparar con la foto.
 */
interface Props {
  readonly siteId: string;
  readonly lat: number;
  readonly lon: number;
  /** Nombre de la estación, para el título del horizonte. */
  readonly title: string;
  /** Cuándo se está ahí: la llegada que calculó el planificador o la salida del plan. */
  readonly at: Date;
}

// Three.js pesa: se baja recién cuando alguien abre el horizonte.
const HorizonView = lazy(() =>
  import("../horizon/HorizonView").then((m) => ({ default: m.HorizonView })),
);

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly data: RoverPhotos }
  | { readonly kind: "error"; readonly message: string };

/** Crédito obligatorio por cámara, por si el server no lo manda. */
export function creditFor(camera: string): string {
  const c = camera.toLowerCase();
  if (c.includes("mastcam-z") || c.includes("mastcamz") || c.includes("mcz")) return "NASA/JPL-Caltech/ASU";
  if (c.includes("mastcam") || c.includes("mast")) return "NASA/JPL-Caltech/MSSS";
  return "NASA/JPL-Caltech";
}

function photoSource(p: RoverPhoto): SourceInfo {
  return {
    provenance: "OBSERVED",
    mission: p.mission,
    instrument: p.camera,
    source: tNow(`Imagen cruda de ${p.rover}, sol ${p.sol} (mars.nasa.gov)`, `Raw image from ${p.rover}, sol ${p.sol} (mars.nasa.gov)`),
    assumptions: [
      tNow(
        "Tomada desde donde estaba el rover, no desde el punto exacto de la estación",
        "Taken from where the rover was, not from the exact point of the stop",
      ),
    ],
  };
}

/**
 * Qué dato de subsuelo corresponde a cada sitio, según el brief: el radar
 * RIMFAX en Jezero y el dato grueso de campo magnético en Gale. Ninguno tiene
 * backend todavía: la ficha dice que falta y qué fuente se espera, sin badge
 * de procedencia (no hay dato del que declarar procedencia) y sin rellenar.
 */
const SUBSURFACE: Readonly<Record<string, { readonly title: string; readonly expected: string }>> = {
  jezero: {
    title: "Subsuelo bajo tus pies (RIMFAX)",
    expected: "el perfil del radar de subsuelo de Mars 2020 RIMFAX",
  },
  gale: {
    title: "Campo magnético del sitio",
    expected: "el dato grueso de campo magnético cortical (MGS MAG/ER)",
  },
};

export function StationPhoto({ siteId, lat, lon, title, at }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [shown, setShown] = useState(0);
  const [horizon, setHorizon] = useState(false);
  const t = useT();
  const tr = useTr();
  const photo = state.kind === "ok" ? (state.data.photos[shown] ?? state.data.photos[0] ?? null) : null;

  useEffect(() => {
    const ctl = new AbortController();
    // Respiro: si se está arrastrando el marcador, no pedir por cada movimiento.
    const t = setTimeout(() => {
      setState({ kind: "loading" });
      setShown(0);
      fetchRoverPhotos(siteId, { lat, lon }, ctl.signal)
        .then((data) => setState({ kind: "ok", data }))
        .catch((e: unknown) => {
          if (!ctl.signal.aborted) {
            setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
          }
        });
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [siteId, lat, lon]);

  return (
    <section className="mt-2 border-t border-line pt-2">
      <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {t("Lo que vas a ver al llegar", "What you will see when you arrive")}
      </h4>

      {state.kind === "loading" ? (
        <p className="text-xs text-muted">{t("Buscando la foto del rover más cercana…", "Looking for the nearest rover photo…")}</p>
      ) : state.kind === "error" ? (
        <p className="text-xs text-alert">
          {t("No se pudieron traer las fotos.", "Could not fetch the photos.")} {tr(state.message)}
        </p>
      ) : state.data.photos.length === 0 ? (
        <p className="rounded border border-warn/60 bg-warn/10 p-2 text-[11px] text-fg">
          <strong className="text-warn">{t("Sin foto.", "No photo.")}</strong>{" "}
          {state.data.note ? tr(state.data.note) : t("No hay fotos del rover cerca de este punto.", "There are no rover photos near this point.")}
        </p>
      ) : (
        <Photos photos={state.data.photos} shown={shown} onShow={setShown} />
      )}

      <button
        type="button"
        onClick={() => setHorizon(true)}
        className="mt-2 w-full rounded border border-rust px-2 py-1.5 text-xs font-semibold text-rust hover:bg-rust/10"
      >
        {t("⛰ Ver el horizonte desde acá", "⛰ See the horizon from here")}
        {photo ? t(" y comparar con la foto", " and compare with the photo") : ""}
      </button>
      {horizon ? (
        <Suspense fallback={<p className="mt-1 text-xs text-muted">{t("Cargando la vista 3D…", "Loading the 3D view…")}</p>}>
          <HorizonView
            siteId={siteId}
            title={title}
            lat={lat}
            lon={lon}
            at={at}
            photo={photo}
            onClose={() => setHorizon(false)}
          />
        </Suspense>
      ) : null}

      <StationData siteId={siteId} state={state} />
    </section>
  );
}

/**
 * Ficha de la estación: química medida y subsuelo. Son datos de la estación,
 * no de la foto que se esté mirando, así que se dibujan haya foto o no.
 */
function StationData({ siteId, state }: { readonly siteId: string; readonly state: State }) {
  // Las fotos vienen de la más cercana a la más lejana: la primera con
  // composición es el waypoint medido más cercano a la estación.
  const measured =
    state.kind === "ok" ? (state.data.photos.find((p) => p.composition) ?? null) : null;
  const subsurface = SUBSURFACE[siteId.toLowerCase()];
  const t = useT();
  const tr = useTr();

  return (
    <div className="mt-2 flex flex-col gap-2">
      <h4 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("Ficha de la estación", "Stop card")}</h4>

      <div className="rounded border border-line bg-panel/40 p-2">
        <p className="mb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
          {t("Composición elemental medida", "Measured elemental composition")}
        </p>
        {state.kind === "loading" ? (
          <p className="text-[11px] text-muted">
            {t("Buscando mediciones del rover cerca de esta estación…", "Looking for rover measurements near this stop…")}
          </p>
        ) : measured?.composition ? (
          <Composition photo={measured} composition={measured.composition} />
        ) : (
          <p className="text-[11px] text-fg">
            <strong className="text-warn">{t("Falta el dato.", "Missing data.")}</strong>{" "}
            {t(
              "El server todavía no reporta composición elemental medida por el rover cerca de esta estación.",
              "The server does not report elemental composition measured by the rover near this stop yet.",
            )}
          </p>
        )}
      </div>

      <div className="rounded border border-line bg-panel/40 p-2">
        <p className="mb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
          {subsurface ? tr(subsurface.title) : t("Subsuelo", "Subsurface")}
        </p>
        <p className="text-[11px] text-fg">
          <strong className="text-warn">{t("Falta el dato.", "Missing data.")}</strong>{" "}
          {subsurface
            ? t(
                `Todavía no hay backend para ${subsurface.expected}; no se muestra un perfil estimado.`,
                `There is no backend yet for ${tr(subsurface.expected)}; no estimated profile is shown.`,
              )
            : t("No hay dato de subsuelo previsto para este sitio.", "No subsurface data is planned for this site.")}
        </p>
      </div>
    </div>
  );
}

function Composition({
  photo,
  composition,
}: {
  readonly photo: RoverPhoto;
  readonly composition: RoverComposition;
}) {
  const t = useT();
  const tr = useTr();
  return (
    <>
      {composition.summary ? (
        <p className="mb-2 text-[11px] leading-snug text-muted">{tr(composition.summary)}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        {composition.elements.map((el, idx) => (
          <div key={`${el.element}-${idx}`} className="rounded border border-line bg-bg/60 px-1.5 py-1">
            <div className="flex items-start justify-between gap-1">
              <span className="text-[11px] font-semibold text-fg">{el.element}</span>
              <ProvenanceBadge source={el} align="left" />
            </div>
            <div className="mt-1">
              <Measure data={el} badge="none" size="sm" align="left" />
            </div>
            {el.note ? <div className="mt-1 text-[10px] text-muted">{tr(el.note)}</div> : null}
          </div>
        ))}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
        {t("Medida en el waypoint del sol", "Measured at the waypoint of sol")} <span className="font-mono">{photo.sol}</span>,{" "}
        {t("a", "")}
        <Measure data={{ ...photo.distance, unit: null }} format={formatDistanceM} align="left" />
        {t("de esta estación", "from this stop")}
      </p>
      {composition.note ? <p className="mt-1 text-[10px] text-muted">{tr(composition.note)}</p> : null}
    </>
  );
}

function Photos({
  photos,
  shown,
  onShow,
}: {
  readonly photos: readonly RoverPhoto[];
  readonly shown: number;
  readonly onShow: (i: number) => void;
}) {
  const p = photos[shown] ?? photos[0];
  const t = useT();
  if (!p) return null;
  const credit = p.credit.trim() || creditFor(p.camera);

  return (
    <figure className="flex flex-col gap-1.5">
      <a href={p.url_full ?? p.url} target="_blank" rel="noreferrer" title={t("Abrir la imagen completa", "Open the full image")}>
        <img
          src={p.url}
          alt={`${p.rover}, ${p.camera}, sol ${p.sol}`}
          loading="lazy"
          className="aspect-[4/3] w-full rounded border border-line bg-bg object-cover"
        />
      </a>
      <figcaption className="flex flex-col gap-1 text-[11px]">
        <span className="flex flex-wrap items-center justify-between gap-1.5">
          <span>
            <span className="font-semibold">{p.rover}</span> · {p.camera} · sol{" "}
            <span className="font-mono">{p.sol}</span>
          </span>
          <ProvenanceBadge source={photoSource(p)} align="left" />
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-muted">
          {t("Tomada a", "Taken")}
          <Measure data={{ ...p.distance, unit: null }} format={formatDistanceM} align="left" />
          {t("de esta estación", "from this stop")}
        </span>
        <span className="text-muted">
          {t("Crédito", "Credit")}: <span className="text-fg">{credit}</span>
        </span>
      </figcaption>

      {photos.length > 1 ? (
        <div className="flex gap-1.5" role="group" aria-label={t("Otras fotos cercanas", "Other nearby photos")}>
          {photos.slice(0, 4).map((ph, i) => (
            <button
              key={ph.url}
              type="button"
              onClick={() => onShow(i)}
              aria-pressed={i === shown}
              aria-label={`${t("Foto", "Photo")} ${i + 1}: ${ph.camera}, sol ${ph.sol}`}
              className={`overflow-hidden rounded border-2 ${i === shown ? "border-rust" : "border-line"}`}
            >
              <img src={ph.url} alt="" loading="lazy" className="size-12 object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </figure>
  );
}
