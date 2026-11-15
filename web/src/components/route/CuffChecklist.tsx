import type { MeasuredValue } from "../../api/schemas";
import { mars24Ltst, sourceLabel, type SourceInfo } from "../../domain/provenance";
import { useT, type Messages } from "../../i18n";
import { useFreshRoute, usePlan } from "../../state/plan";
import { useStore } from "../../state/store";
import { waypointLabel } from "../../map/route";
import { earthShort, formatBearing, formatDistanceM, formatMinutes, ltstShort, sameSource } from "./format";

/**
 * Tira de la travesía para imprimir, como los cuff checklists de Apollo: una
 * fila por punto con lo que hace falta mirar con el casco puesto.
 *
 * Solo existe en impresión (`hidden print:block`); en pantalla la app se
 * oculta con `print:hidden`. Blanco y negro, letra grande, sin depender del
 * color. Reemplaza la "tarjeta de supervivencia PDF": desde el diálogo de
 * impresión del navegador se guarda como PDF.
 */
export function CuffChecklist() {
  const t = useT();
  // Solo la ruta vigente: imprimir mientras se recalcula no tiene que mezclar
  // los datos de la ruta anterior con los puntos de ahora.
  const result = useFreshRoute();
  const waypoints = usePlan((s) => s.waypoints);
  const departAt = usePlan((s) => s.departAt);
  const siteId = useStore((s) => s.activeSiteId);
  if (!result) {
    // Ctrl+P sin travesía: que el papel lo diga en vez de salir en blanco.
    return (
      <article className="hidden font-sans text-[12pt] text-black print:block">
        <strong>{t.cuff.emptyTitle}</strong>
        <p className="mt-2">{t.cuff.empty}</p>
        <p className="mt-2 text-[9pt]">{t.app.disclaimer}</p>
      </article>
    );
  }
  const { route, example } = result;
  const go = route.verdict.status === "GO";
  const origin = route.stops[0];

  // Fuentes de cada columna, una vez al pie: en papel no hay tooltip.
  const sources = collectSources(
    [
      [t.cuff.sourceCols.hours, [mars24Ltst(t)]],
      [t.cuff.sourceCols.bearingDist, route.legs.flatMap((l) => [l.bearing, l.distance])],
      [t.cuff.sourceCols.o2, route.stops.map((s) => s.o2_remaining)],
      [t.cuff.sourceCols.margin, [...route.stops.map((s) => s.margin), route.verdict.margin]],
    ],
    t,
  );

  return (
    <article className="hidden font-mono text-[10pt] leading-tight text-black print:block">
      <header className="border-2 border-black p-2">
        <div className="flex items-baseline justify-between">
          <strong className="text-[12pt] tracking-wide">{t.cuff.title}</strong>
          <span>{siteId.toUpperCase()}</span>
        </div>
        <div className="mt-1 flex flex-wrap justify-between gap-x-4">
          <span>
            {t.cuff.departure(
              origin ? ltstShort(departAt, origin.lon) : "—",
              earthShort(departAt, t.locale),
              departAt.toLocaleDateString(t.locale),
            )}
          </span>
          <span>
            {t.cuff.points(route.stops.length)} · {totalDistance(route.legs.map((l) => l.distance), t)}
          </span>
        </div>
        <div className="mt-1.5 border-t-2 border-black pt-1.5 text-[13pt] font-bold">
          {go ? "✓ GO" : "✕ NO-GO"} — {route.verdict.summary}
        </div>
        <div>
          {t.cuff.reserve}{" "}
          {route.verdict.margin.value === null ? t.measure.missing : formatMinutes(route.verdict.margin.value)}
        </div>
        {example ? (
          <div className="mt-1 border-2 border-black p-1 font-bold">
            {t.cuff.example}
          </div>
        ) : null}
      </header>

      <table className="mt-2 w-full border-collapse [&_td]:py-1 [&_td]:pr-2 [&_th]:pr-2">
        <thead>
          <tr className="border-b-2 border-black text-left text-[8.5pt]">
            <th className="py-1">#</th>
            <th>{t.cuff.cols.arrive}</th>
            <th>{t.cuff.cols.depart}</th>
            <th>{t.cuff.cols.bearing}</th>
            <th>{t.cuff.cols.dist}</th>
            <th>{t.cuff.cols.task}</th>
            <th className="text-right">{t.cuff.cols.o2}</th>
            <th className="text-right">{t.cuff.cols.margin}</th>
          </tr>
        </thead>
        <tbody>
          {route.stops.map((s, i) => {
            const label = waypointLabel(i, route.stops.length, t);
            const next = route.legs[i];
            const wp = waypoints[i];
            return (
              <tr key={s.index} className="break-inside-avoid border-b border-black align-top">
                <td className="font-bold">{label.short}</td>
                <td>{s.arrive_utc ? ltstShort(s.arrive_utc, s.lon) : "—"}</td>
                <td>{s.depart_utc ? ltstShort(s.depart_utc, s.lon) : "—"}</td>
                <td>{next ? value(next.bearing, (v) => formatBearing(v, t), t) : "—"}</td>
                <td>{next ? value(next.distance, formatDistanceM, t) : "—"}</td>
                <td className="font-sans">
                  {/* La tarea de ahora: editarla no recalcula la ruta (ver planKey). */}
                  {wp?.task.trim() || s.task || label.long}
                  {label.kind === "station" && wp ? ` (${wp.dwellMin} min)` : ""}
                </td>
                <td className="text-right">{value(s.o2_remaining, (v) => v.toFixed(1), t)}</td>
                <td className="text-right">{value(s.margin, formatMinutes, t)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 text-[8pt]">
        {t.cuff.footnote}
      </p>

      <footer className="mt-2 border-t border-black pt-1 text-[7.5pt] leading-snug">
        <div className="font-bold">{t.cuff.sources}</div>
        <ul>
          {sources.map(([col, labels]) => (
            <li key={col}>
              {col}: {labels.join(" / ")}
            </li>
          ))}
        </ul>
        <div className="mt-1">{t.app.disclaimer}</div>
      </footer>
    </article>
  );
}

function value(v: MeasuredValue, fmt: (n: number) => string, t: Messages): string {
  if (v.value === null) return t.cuff.missing;
  return `${fmt(v.value)}${v.unit && !["m", "min", "°"].includes(v.unit) ? ` ${v.unit}` : ""}`;
}

function totalDistance(ds: readonly MeasuredValue[], t: Messages): string {
  if (ds.some((d) => d.value === null)) return t.cuff.totalMissing;
  return t.cuff.total(formatDistanceM(ds.reduce((a, d) => a + (d.value ?? 0), 0)));
}

/** Fuentes distintas por columna, como "MRO HiRISE · DERIVED". */
function collectSources(
  cols: readonly (readonly [string, readonly SourceInfo[]])[],
  t: Messages,
): [string, string[]][] {
  return cols.map(([col, values]) => {
    const uniq: SourceInfo[] = [];
    for (const v of values) if (!uniq.some((u) => sameSource(u, v))) uniq.push(v);
    return [col, uniq.map((u) => sourceLabel(u, t))];
  });
}
