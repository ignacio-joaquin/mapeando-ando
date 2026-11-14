import type { Profile } from "../../api/schemas";
import { formatDistance } from "../../mars/geo";
import { SLOPE_CLASSES, slopeClass } from "../../map/layers";

/**
 * Perfil de elevación de la travesía, coloreado por pendiente.
 *
 * Los colores son los MISMOS que la capa de pendiente del mapa: si un tramo se
 * ve rojo acá, se ve rojo allá. Esa es la mitad del valor de este gráfico —
 * leer de un vistazo dónde el terreno deja de ser transitable.
 *
 * Sin perfil no dibuja una curva inventada: dice qué falta para tenerlo.
 */
interface Props {
  readonly profile: Profile | undefined;
  readonly height?: number;
}

const PAD = { top: 10, right: 8, bottom: 20, left: 44 };

export function ElevationProfile({ profile, height = 140 }: Props) {
  if (!profile || profile.distance_m.length < 2) {
    return (
      <div className="border-t border-line bg-panel/40 px-3 py-2">
        <h2 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
          Perfil de elevación
        </h2>
        <p className="text-[11px] text-warn">
          Falta el perfil. Lo devuelve el backend al muestrear el DTM sobre la
          ruta; mientras la ruta la calcule el planificador de ejemplo, o el DTM
          no esté descargado, acá no se dibuja nada. No se inventa una curva.
        </p>
      </div>
    );
  }

  const { distance_m: dist, elevation_m: elev, slope_deg: slope, leg_starts: legs } = profile;
  const w = 1000; // viewBox fijo; el SVG escala solo al ancho del contenedor
  const h = height;

  const dMax = dist[dist.length - 1] ?? 1;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const z of elev) {
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  // Un rango mínimo evita que una ruta casi plana se dibuje como una sierra.
  if (zMax - zMin < 5) {
    const medio = (zMax + zMin) / 2;
    zMin = medio - 2.5;
    zMax = medio + 2.5;
  }

  const x = (d: number) => PAD.left + (d / (dMax || 1)) * (w - PAD.left - PAD.right);
  const y = (z: number) =>
    PAD.top + (1 - (z - zMin) / (zMax - zMin)) * (h - PAD.top - PAD.bottom);

  // Un segmento por muestra, con el color de su clase de pendiente.
  const segmentos = [];
  for (let i = 1; i < dist.length; i++) {
    const d0 = dist[i - 1];
    const d1 = dist[i];
    const z0 = elev[i - 1];
    const z1 = elev[i];
    if (d0 === undefined || d1 === undefined || z0 === undefined || z1 === undefined) continue;
    segmentos.push({
      key: i,
      x1: x(d0),
      y1: y(z0),
      x2: x(d1),
      y2: y(z1),
      color: slopeClass(Math.abs(slope[i] ?? 0)).color,
    });
  }

  const ticksZ = [zMin, (zMin + zMax) / 2, zMax];

  return (
    <div className="border-t border-line bg-panel/40 px-3 py-2">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
          Perfil de elevación
        </h2>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {SLOPE_CLASSES.map((c) => (
            <li key={c.label} className="flex items-center gap-1.5 text-[10px] text-muted">
              <span
                aria-hidden
                className="inline-block h-0.5 w-3 rounded-full"
                style={{ background: c.color }}
              />
              {c.label}
            </li>
          ))}
        </ul>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-[140px] w-full"
        role="img"
        aria-label={`Perfil de elevación de la travesía: ${formatDistance(dMax)} y entre ${Math.round(zMin)} y ${Math.round(zMax)} metros de elevación`}
      >
        {ticksZ.map((z) => (
          <g key={z}>
            <line
              x1={PAD.left}
              x2={w - PAD.right}
              y1={y(z)}
              y2={y(z)}
              stroke="currentColor"
              className="text-line"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(z) + 3}
              textAnchor="end"
              className="fill-current text-muted"
              style={{ fontSize: 10 }}
            >
              {Math.round(z)}
            </text>
          </g>
        ))}

        {/* Dónde empieza cada tramo: ubica las estaciones en el perfil. */}
        {legs.slice(1, -1).map((i) => {
          const d = dist[i];
          return d === undefined ? null : (
            <line
              key={i}
              x1={x(d)}
              x2={x(d)}
              y1={PAD.top}
              y2={h - PAD.bottom}
              stroke="currentColor"
              className="text-muted"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
          );
        })}

        {segmentos.map((s) => (
          <line
            key={s.key}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={s.color}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        ))}

        <text x={PAD.left} y={h - 6} className="fill-current text-muted" style={{ fontSize: 10 }}>
          0
        </text>
        <text
          x={w - PAD.right}
          y={h - 6}
          textAnchor="end"
          className="fill-current text-muted"
          style={{ fontSize: 10 }}
        >
          {formatDistance(dMax)}
        </text>
        <text
          x={PAD.left - 6}
          y={PAD.top - 2}
          textAnchor="end"
          className="fill-current text-muted"
          style={{ fontSize: 9 }}
        >
          m
        </text>
      </svg>
    </div>
  );
}
