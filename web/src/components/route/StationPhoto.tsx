import { useEffect, useState } from "react";
import { fetchRoverPhotos } from "../../api/client";
import type { RoverPhoto, RoverPhotos } from "../../api/schemas";
import type { SourceInfo } from "../../domain/provenance";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { formatDistanceM } from "./format";
import { useT, type Messages } from "../../i18n";

/**
 * "Lo que vas a ver al llegar": la foto real del rover más cercana a la
 * estación, con sol, cámara y crédito. Las fotos salen del backend (MAP-33);
 * si no hay, se dice que falta. Nunca una foto de ejemplo.
 *
 * M2: al lado va nuestro render del horizonte desde el mismo punto.
 */
interface Props {
  readonly siteId: string;
  readonly lat: number;
  readonly lon: number;
}

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

function photoSource(p: RoverPhoto, t: Messages): SourceInfo {
  return {
    provenance: "OBSERVED",
    mission: p.mission,
    instrument: p.camera,
    source: t.photo.source(p.rover, p.sol),
    assumptions: [t.photo.assumption],
  };
}

export function StationPhoto({ siteId, lat, lon }: Props) {
  const t = useT();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [shown, setShown] = useState(0);

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
        {t.photo.heading}
      </h4>

      {state.kind === "loading" ? (
        <p className="text-xs text-muted">{t.photo.loading}</p>
      ) : state.kind === "error" ? (
        <p className="text-xs text-alert">{t.photo.error(state.message)}</p>
      ) : state.data.photos.length === 0 ? (
        <p className="rounded border border-warn/60 bg-warn/10 p-2 text-[11px] text-fg">
          <strong className="text-warn">{t.photo.none}</strong>{" "}
          {state.data.note ?? t.photo.noneNear}
        </p>
      ) : (
        <Photos photos={state.data.photos} shown={shown} onShow={setShown} />
      )}
    </section>
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
  const t = useT();
  const p = photos[shown] ?? photos[0];
  if (!p) return null;
  const credit = p.credit.trim() || creditFor(p.camera);

  return (
    <figure className="flex flex-col gap-1.5">
      <a href={p.url_full ?? p.url} target="_blank" rel="noreferrer" title={t.photo.openFull}>
        <img
          src={p.url}
          alt={t.photo.alt(p.rover, p.camera, p.sol)}
          loading="lazy"
          className="aspect-[4/3] w-full rounded border border-line bg-bg object-cover"
        />
      </a>
      <figcaption className="flex flex-col gap-1 text-[11px]">
        <span className="flex flex-wrap items-center justify-between gap-1.5">
          <span>
            <span className="font-semibold">{p.rover}</span> · {p.camera} · {t.photo.sol}{" "}
            <span className="font-mono">{p.sol}</span>
          </span>
          <ProvenanceBadge source={photoSource(p, t)} align="left" />
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-muted">
          {t.photo.takenBefore}
          <Measure data={{ ...p.distance, unit: null }} format={formatDistanceM} align="left" />
          {t.photo.takenAfter}
        </span>
        <span className="text-muted">
          {t.photo.credit} <span className="text-fg">{credit}</span>
        </span>
      </figcaption>

      {photos.length > 1 ? (
        <div className="flex gap-1.5" role="group" aria-label={t.photo.others}>
          {photos.slice(0, 4).map((ph, i) => (
            <button
              key={ph.url}
              type="button"
              onClick={() => onShow(i)}
              aria-pressed={i === shown}
              aria-label={t.photo.thumb(i + 1, ph.camera, ph.sol)}
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
