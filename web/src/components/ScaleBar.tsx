import { MARS_RADIUS_M } from "../mars/constants";
import { formatDistance, marsMetersPerPixel } from "../mars/geo";
import { localGeometry } from "../domain/provenance";
import { useT } from "../i18n";
import { ProvenanceBadge } from "./ProvenanceBadge";

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
      title={t.scale.title((MARS_RADIUS_M / 1000).toFixed(2))}
    >
      <div className="text-[10px] text-muted">{formatDistance(meters)}</div>
      <div
        className="h-1.5 border-x border-b border-fg/70"
        style={{ width: `${px}px` }}
      />
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
        {t.scale.label((MARS_RADIUS_M / 1000).toFixed(1))}
        {/* El badge recibe eventos aunque la barra no, para poder ver el tooltip. */}
        <span className="pointer-events-auto">
          <ProvenanceBadge source={localGeometry(t)} align="left" side="top" />
        </span>
      </div>
    </div>
  );
}
