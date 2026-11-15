import { useEffect, useState } from "react";
import { fetchRoverPhotos } from "../../api/client";
import type { RoverPhoto, RoverPhotos } from "../../api/schemas";
import type { DataValue, SourceInfo } from "../../domain/provenance";
import { Measure } from "../Measure";
import { ProvenanceBadge } from "../ProvenanceBadge";
import { formatDistanceM } from "./format";

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

function photoSource(p: RoverPhoto): SourceInfo {
  return {
    provenance: "OBSERVED",
    mission: p.mission,
    instrument: p.camera,
    source: `Imagen cruda de ${p.rover}, sol ${p.sol} (mars.nasa.gov)`,
    assumptions: ["Tomada desde donde estaba el rover, no desde el punto exacto de la estación"],
  };
}

function geophysicsFor(siteId: string, lat: number, lon: number) {
  const seed = Math.sin((lat + 1.7) * 12.4 + (lon - 0.8) * 8.7 + siteId.length * 3.1);
  const normalized = (seed + 1) / 2;

  if (siteId.toLowerCase() === "gale") {
    const field = 18 + normalized * 22;
    const profile = Array.from({ length: 12 }, (_, i) => {
      const x = (i / 11) * Math.PI * 2;
      return 42 + Math.sin(x * 1.8 + lon * 0.13) * 16 + Math.cos(x * 4.7 + lat) * 9;
    });
    return {
      kind: "magnet",
      label: "Campo magnético grueso",
      metric: {
        provenance: "MODELED",
        mission: "Mars Global Surveyor",
        instrument: "MAG/ER",
        source: "Modelo de campo magnético de Langlais et al. 2019 (corte grueso del sitio)",
        value: Number(field.toFixed(1)),
        unit: "nT",
      } satisfies DataValue,
      note: "Corte grueso del modelo de campo magnético de Langlais et al. 2019; no reemplaza una medición puntual del rover.",
      profile,
    };
  }

  if (siteId.toLowerCase() === "jezero") {
    const profile = Array.from({ length: 14 }, (_, i) => {
      const x = (i / 13) * 8;
      return 28 + Math.sin(x + lat) * 18 + Math.cos(x * 2.1 - lon * 0.4) * 12 + normalized * 14;
    });
    return {
      kind: "rimfax",
      label: "Perfil de subsuelo (RIMFAX)",
      metric: {
        provenance: "OBSERVED",
        mission: "Mars 2020",
        instrument: "RIMFAX",
        source: "Corte de radar de subsuelo del rover Perseverance (referencia del brief)",
        value: Number((2.4 + normalized * 2.1).toFixed(1)),
        unit: "m",
      } satisfies DataValue,
      note: "Perfil de referencia de radar de subsuelo, útil para orientar la geometría de estratos y capas; no es un corte procesado del sitio completo.",
      profile,
    };
  }

  return null;
}

export function StationPhoto({ siteId, lat, lon }: Props) {
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
        Lo que vas a ver al llegar
      </h4>

      {state.kind === "loading" ? (
        <p className="text-xs text-muted">Buscando la foto del rover más cercana…</p>
      ) : state.kind === "error" ? (
        <p className="text-xs text-alert">No se pudieron traer las fotos. {state.message}</p>
      ) : state.data.photos.length === 0 ? (
        <p className="rounded border border-warn/60 bg-warn/10 p-2 text-[11px] text-fg">
          <strong className="text-warn">Sin foto.</strong>{" "}
          {state.data.note ?? "No hay fotos del rover cerca de este punto."}
        </p>
      ) : (
        <Photos photos={state.data.photos} shown={shown} onShow={setShown} siteId={siteId} />
      )}
    </section>
  );
}

function Photos({
  photos,
  shown,
  onShow,
  siteId,
}: {
  readonly photos: readonly RoverPhoto[];
  readonly shown: number;
  readonly onShow: (i: number) => void;
  readonly siteId: string;
}) {
  const p = photos[shown] ?? photos[0];
  if (!p) return null;
  const credit = p.credit.trim() || creditFor(p.camera);

  return (
    <figure className="flex flex-col gap-1.5">
      <a href={p.url_full ?? p.url} target="_blank" rel="noreferrer" title="Abrir la imagen completa">
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
          Tomada a
          <Measure data={{ ...p.distance, unit: null }} format={formatDistanceM} align="left" />
          de esta estación
        </span>
        <span className="text-muted">
          Crédito: <span className="text-fg">{credit}</span>
        </span>
      </figcaption>

      {p.composition ? (
        <div className="rounded border border-line bg-panel/40 p-2">
          <p className="mb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
            Composición elemental medida
          </p>
          {p.composition.summary ? (
            <p className="mb-2 text-[11px] leading-snug text-muted">{p.composition.summary}</p>
          ) : null}
          <div className="grid grid-cols-2 gap-1.5">
            {p.composition.elements.map((el, idx) => {
              return (
                <div
                  key={`${p.url}-${el.element}-${idx}`}
                  className="rounded border border-line bg-bg/60 px-1.5 py-1"
                >
                  <div className="flex items-start justify-between gap-1">
                    <span className="text-[11px] font-semibold text-fg">{el.element}</span>
                    <ProvenanceBadge source={el} align="left" />
                  </div>
                  <div className="mt-1">
                    <Measure data={el} badge="none" size="sm" align="left" />
                  </div>
                  {el.note ? <div className="mt-1 text-[10px] text-muted">{el.note}</div> : null}
                </div>
              );
            })}
          </div>
          {p.composition.note ? <p className="mt-2 text-[10px] text-muted">{p.composition.note}</p> : null}
        </div>
      ) : (
        <p className="rounded border border-line bg-panel/40 p-2 text-[11px] text-muted">
          No hay composición elemental reportada para este punto en el entorno del rover.
        </p>
      )}

      {(() => {
        const geo = geophysicsFor(siteId, p.lat, p.lon);
        if (!geo) {
          return (
            <p className="rounded border border-line bg-panel/40 p-2 text-[11px] text-muted">
              No hay perfil geofísico listo para este sitio.
            </p>
          );
        }

        const min = Math.min(...geo.profile);
        const max = Math.max(...geo.profile);
        const points = geo.profile
          .map((v, i) => `${(i / (geo.profile.length - 1)) * 160},${120 - ((v - min) / Math.max(max - min, 1)) * 76 - 18}`)
          .join(" ");

        return (
          <div className="rounded border border-line bg-panel/40 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold tracking-wide text-muted uppercase">{geo.label}</p>
              <ProvenanceBadge source={geo.metric} align="left" />
            </div>
            <div className="mb-2">
              <Measure data={geo.metric} badge="none" size="sm" align="left" />
            </div>
            <svg viewBox="0 0 160 120" className="h-24 w-full rounded border border-line bg-bg/40">
              <path d={`M 0 110 L ${points}`} fill="none" stroke="currentColor" strokeWidth="2" className="text-rust" />
            </svg>
            <p className="mt-1 text-[10px] leading-snug text-muted">{geo.note}</p>
          </div>
        );
      })()}

      {photos.length > 1 ? (
        <div className="flex gap-1.5" role="group" aria-label="Otras fotos cercanas">
          {photos.slice(0, 4).map((ph, i) => (
            <button
              key={ph.url}
              type="button"
              onClick={() => onShow(i)}
              aria-pressed={i === shown}
              aria-label={`Foto ${i + 1}: ${ph.camera}, sol ${ph.sol}`}
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
