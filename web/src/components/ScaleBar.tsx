import { MARS_RADIUS_M } from "../mars/constants";
import { formatDistance, marsMetersPerPixel } from "../mars/geo";
import { LOCAL_GEOMETRY } from "../domain/provenance";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { useT } from "../i18n/lang";

/**
 * Barra de escala con el radio de Marte, no el de la Tierra.
 * El valor se calcula en src/mars/geo.ts; MapLibre no interviene.
 */
interface Props {
  readonly lat: number;
  readonly zoom: number;
  readonly maxPx?: number;
}

const NICE = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000,
  200_000, 500_000,
];

export function ScaleBar({ lat, zoom, maxPx = 140 }: Props) {
  const t = useT();
  const mpp = marsMetersPerPixel(lat, zoom);

  const maxMeters = mpp * maxPx;
  const meters = NICE.filter((n) => n <= maxMeters).pop() ?? NICE[0] ?? 10;
  const px = Math.round(meters / mpp);

  return (
    <div
      className="pointer-events-none select-none"
      title={t(
        `Esfera IAU Mars 2000, radio ${(MARS_RADIUS_M / 1000).toFixed(2)} km: el mismo de los DTM y de api/terrain.py`,
        `IAU Mars 2000 sphere, radius ${(MARS_RADIUS_M / 1000).toFixed(2)} km: the same as the DTMs and api/terrain.py`,
      )}
    >
      <div className="text-[10px] text-muted">{formatDistance(meters)}</div>
      <div
        className="h-1.5 border-x border-b border-fg/70"
        style={{ width: `${px}px` }}
      />
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
        <span className="hidden sm:inline">
          {t("escala marciana", "Mars scale")} · R {(MARS_RADIUS_M / 1000).toFixed(1)} km
        </span>
        {/* El badge recibe eventos aunque la barra no, para poder ver el tooltip. */}
        <span className="pointer-events-auto">
          <ProvenanceBadge source={LOCAL_GEOMETRY} align="left" side="top" />
        </span>
      </div>
    </div>
  );
}
