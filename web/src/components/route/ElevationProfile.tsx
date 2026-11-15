import { useEffect, useState } from "react";
import type { Profile } from "../../api/schemas";
import { EDU_TARGET } from "../../edu/lessons";
import { useLessonShows } from "../../edu/useLessonShows";
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

/**
 * Franja plegable debajo del mapa. Solo aparece con una travesía armada: sin
 * ruta no hay perfil que mostrar. En pantalla chica arranca plegada para no
 * comerle alto al mapa.
 */
export function ElevationProfile({ profile }: { readonly profile: Profile | undefined }) {
  const [open, setOpen] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  // Una lección que señala el perfil lo abre; después se puede volver a plegar.
  const lessonShows = useLessonShows([EDU_TARGET.PROFILE]);
  useEffect(() => {
    if (lessonShows) setOpen(true);
  }, [lessonShows]);
  const missing = (profile?.distance_m.length ?? 0) < 2;
  return (
    <section className="border-t border-line bg-panel">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-fg"
      >
        <span aria-hidden className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        Perfil de elevación
        {missing ? <span className="font-normal tracking-normal text-warn normal-case">· falta el dato</span> : null}
      </button>
      {open ? (
        <div className="px-3 pb-2">
          <ProfileChart profile={profile} />
        </div>
      ) : null}
    </section>
  );
}

// `top` deja lugar arriba para la unidad del eje Y: con menos, la "m" se pisa
// con la etiqueta de la elevación máxima.
const PAD = { top: 18, right: 8, bottom: 20, left: 44 };

function ProfileChart({ profile, height = 140 }: Props) {
  if (!profile || profile.distance_m.length < 2) {
    return (
      <p className="text-[11px] text-warn">
        Falta el perfil: lo devuelve el backend al muestrear el DTM sobre la ruta. Con el
        planificador de ejemplo, o sin el DTM descargado, no se dibuja nada; no se inventa una curva.
      </p>
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

  // Tramos sin camino: el planificador no encontró paso y el backend mandó la línea
  // recta A→B medida sobre el DTM. Se dibuja punteada y se avisa: no es una ruta, es
  // dónde está lo que bloquea. Los colores siguen la misma regla que el resto.
  const rectas = new Set(profile.straight_legs ?? []);
  const tramoDe = (i: number) => {
    let k = 0;
    while (k + 1 < legs.length && (legs[k + 1] ?? Infinity) < i) k++;
    return k;
  };

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
      recta: rectas.has(tramoDe(i)),
    });
  }

  const ticksZ = [zMin, (zMin + zMax) / 2, zMax];

  return (
    <div>
      <div className="mb-1 flex justify-end">
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

      {rectas.size > 0 ? (
        <p className="mb-1 text-[11px] text-warn">
          Sin camino en {[...rectas].map((k) => `el tramo ${k}→${k + 1}`).join(", ")}: se muestra
          la línea recta medida sobre el terreno (punteada). No es una ruta: marca dónde está lo
          que bloquea.
        </p>
      ) : null}

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-[110px] w-full sm:h-[140px]"
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
            strokeLinecap={s.recta ? "butt" : "round"}
            strokeDasharray={s.recta ? "6 4" : undefined}
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
          y={PAD.top - 9}
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
