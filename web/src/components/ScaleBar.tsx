import { useEffect, useState } from "react";
import { MARS_RADIUS_M, MARS_RADIUS_PROJECTION_M } from "../mars/constants";
import { formatDistance, marsMetersPerPixel } from "../mars/geo";

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
  10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000,
];

export function ScaleBar({ lat, zoom, maxPx = 140 }: Props) {
  const [mpp, setMpp] = useState(() => marsMetersPerPixel(lat, zoom));
  useEffect(() => setMpp(marsMetersPerPixel(lat, zoom)), [lat, zoom]);

  const maxMeters = mpp * maxPx;
  const meters = NICE.filter((n) => n <= maxMeters).pop() ?? NICE[0] ?? 10;
  const px = Math.round(meters / mpp);

  return (
    <div
      className="pointer-events-none select-none"
      title={`Radio usado: ${(MARS_RADIUS_M / 1000).toFixed(1)} km (proyección del DTM: ${(MARS_RADIUS_PROJECTION_M / 1000).toFixed(2)} km)`}
    >
      <div className="text-[10px] text-muted">{formatDistance(meters)}</div>
      <div
        className="h-1.5 border-x border-b border-fg/70"
        style={{ width: `${px}px` }}
      />
      <div className="mt-0.5 text-[10px] text-muted">
        escala marciana · R {(MARS_RADIUS_M / 1000).toFixed(1)} km
      </div>
    </div>
  );
}
