import { Fragment } from "react";
import type { Direction, MeasuredValue } from "../../api/schemas";
import { LANDMARK_CATALOG_LABEL, isFallback } from "../../domain/landmarks";
import { MARS24_LTST, sourceLabel, type SourceInfo } from "../../domain/provenance";
import { useFreshRoute, usePlan } from "../../state/plan";
import { useStore } from "../../state/store";
import { stopLabel } from "../../map/route";
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
  // Solo la ruta vigente: imprimir mientras se recalcula no tiene que mezclar
  // los datos de la ruta anterior con los puntos de ahora.
  const result = useFreshRoute();
  const waypoints = usePlan((s) => s.waypoints);
  const departAt = usePlan((s) => s.departAt);
  const roundTrip = usePlan((s) => s.roundTrip);
  const siteId = useStore((s) => s.activeSiteId);
  if (!result) {
    // Ctrl+P sin travesía: que el papel lo diga en vez de salir en blanco.
    return (
      <article className="hidden font-sans text-[12pt] text-black print:block">
        <strong>Mapa Marciano · tira de EVA</strong>
        <p className="mt-2">
          No hay una travesía calculada para imprimir. Marcá salida y llegada en el mapa y
          esperá el veredicto.
        </p>
        <p className="mt-2 text-[9pt]">Prototipo educativo, no software de vuelo.</p>
      </article>
    );
  }
  const { route, example } = result;
  const verdictWord = { GO: "✓ GO", CAUTION: "⚠ CAUTION", NO_GO: "✕ NO-GO" }[route.verdict.status];
  const score = route.verdict.score?.value;
  const robust = route.verdict.robustness;
  const origin = route.stops[0];

  // Fuentes de cada columna, una vez al pie: en papel no hay tooltip.
  const sources = collectSources([
    ["Horas (LLEGA / SALE)", [MARS24_LTST]],
    ["RUMBO y DIST", route.legs.flatMap((l) => [l.bearing, l.distance])],
    ["O2", route.stops.map((s) => s.o2_remaining)],
    ["MARGEN y reserva", [...route.stops.map((s) => s.margin), route.verdict.margin]],
  ]);

  return (
    <article className="hidden font-mono text-[10pt] leading-tight text-black print:block">
      <header className="border-2 border-black p-2">
        <div className="flex items-baseline justify-between">
          <strong className="text-[12pt] tracking-wide">MAPA MARCIANO · TIRA DE EVA</strong>
          <span>{siteId.toUpperCase()}</span>
        </div>
        <div className="mt-1 flex flex-wrap justify-between gap-x-4">
          <span>
            SALIDA {origin ? ltstShort(departAt, origin.lon) : "—"} LTST ({earthShort(departAt)} hora Tierra,{" "}
            {departAt.toLocaleDateString("es-AR")})
          </span>
          <span>
            {route.stops.length} PUNTOS{roundTrip ? " (IDA Y VUELTA)" : " (SOLO IDA)"} · {totalDistance(route.legs.map((l) => l.distance))}
          </span>
        </div>
        <div className="mt-1.5 border-t-2 border-black pt-1.5 text-[13pt] font-bold">
          {verdictWord} — {route.verdict.summary}
        </div>
        {score !== undefined || robust ? (
          <div>
            {score !== undefined ? `Puntaje ${score === null ? "falta el dato" : Math.round(score)}/100 (límites ASSUMED)` : ""}
            {robust ? ` · Robusta en ${robust.passed} de ${robust.evaluated} escenarios` : ""}
          </div>
        ) : null}
        <div>
          Reserva al llegar:{" "}
          {route.verdict.margin.value === null ? "falta el dato" : formatMinutes(route.verdict.margin.value)}
        </div>
        {example ? (
          <div className="mt-1 border-2 border-black p-1 font-bold">
            EJEMPLO — calculado sin /api/route, en línea recta y con parámetros supuestos. NO USAR PARA DECIDIR.
          </div>
        ) : null}
      </header>

      <table className="mt-2 w-full border-collapse [&_td]:py-1 [&_td]:pr-2 [&_th]:pr-2">
        <thead>
          <tr className="border-b-2 border-black text-left text-[8.5pt]">
            <th className="py-1">#</th>
            <th>LLEGA</th>
            <th>SALE</th>
            <th>RUMBO</th>
            <th>DIST</th>
            <th>TAREA</th>
            <th className="text-right">O2</th>
            <th className="text-right">MARGEN</th>
          </tr>
        </thead>
        <tbody>
          {route.stops.map((s, i) => {
            const label = stopLabel(i, route.stops.length, roundTrip);
            const next = route.legs[i];
            const wp = waypoints[i];
            const directions = next?.directions ?? [];
            return (
              <Fragment key={s.index}>
                <tr className={`break-inside-avoid align-top ${directions.length ? "" : "border-b border-black"}`}>
                  <td className="font-bold">{label.short}</td>
                  <td>{s.arrive_utc ? ltstShort(s.arrive_utc, s.lon) : "—"}</td>
                  <td>{s.depart_utc ? ltstShort(s.depart_utc, s.lon) : "—"}</td>
                  <td>{next ? value(next.bearing, formatBearing) : "—"}</td>
                  <td>{next ? value(next.distance, formatDistanceM) : "—"}</td>
                  <td className="font-sans">
                    {/* La tarea de ahora: editarla no recalcula la ruta (ver planKey). */}
                    {wp?.task.trim() || s.task || label.long}
                    {(label.kind === "station" || (roundTrip && label.kind === "destination")) && wp
                      ? ` (${wp.dwellMin} min)`
                      : ""}
                  </td>
                  <td className="text-right">{value(s.o2_remaining, (v) => v.toFixed(1))}</td>
                  <td className="text-right">{value(s.margin, formatMinutes)}</td>
                </tr>
                {directions.length ? (
                  // Lo que se sigue con el casco puesto: la indicación hacia el punto siguiente.
                  <tr className="break-inside-avoid border-b border-black">
                    <td />
                    <td colSpan={7} className="pb-1 font-sans text-[10.5pt] leading-snug">
                      {directions.map((d, k) => (
                        <div key={k} className="break-inside-avoid">
                          → {d.text} <span className="text-[8pt]">({directionNote(d)})</span>
                          {/* En papel no hay tooltip: confirmaciones y parada, en una línea cada una. */}
                          {(d.checks ?? []).map((c, j) => (
                            <div key={j} className="pl-4 text-[9pt]">
                              ✓ {c.text}
                            </div>
                          ))}
                          {d.until ? <div className="pl-4 text-[9pt] font-bold">■ {d.until.text}</div> : null}
                        </div>
                      ))}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 text-[8pt]">
        RUMBO y DIST: hacia el punto siguiente. Horas en hora solar local (LTST) de cada punto.
      </p>

      <footer className="mt-2 border-t border-black pt-1 text-[7.5pt] leading-snug">
        <div className="font-bold">FUENTES</div>
        <ul>
          {sources.map(([col, labels]) => (
            <li key={col}>
              {col}: {labels.join(" / ")}
            </li>
          ))}
        </ul>
        <div className="mt-1">Prototipo educativo, no software de vuelo.</div>
      </footer>
    </article>
  );
}

/** Al pie de cada indicación: de dónde sale el landmark y cuánto se ve, o que es respaldo. */
function directionNote(d: Direction): string {
  if (isFallback(d.kind) || !d.landmark) return "RESPALDO";
  const vis = d.visible_fraction.value;
  const seen = vis === null ? "visibilidad: falta el dato" : `visible ${Math.round(vis * 100)} % del tramo`;
  return `${LANDMARK_CATALOG_LABEL[d.landmark.source]} · ${seen}`;
}

function value(v: MeasuredValue, fmt: (n: number) => string): string {
  if (v.value === null) return "falta";
  return `${fmt(v.value)}${v.unit && !["m", "min", "°"].includes(v.unit) ? ` ${v.unit}` : ""}`;
}

function totalDistance(ds: readonly MeasuredValue[]): string {
  if (ds.some((d) => d.value === null)) return "distancia total: falta el dato";
  return `${formatDistanceM(ds.reduce((a, d) => a + (d.value ?? 0), 0))} en total`;
}

/** Fuentes distintas por columna, como "MRO HiRISE · DERIVED". */
function collectSources(
  cols: readonly (readonly [string, readonly SourceInfo[]])[],
): [string, string[]][] {
  return cols.map(([col, values]) => {
    const uniq: SourceInfo[] = [];
    for (const v of values) if (!uniq.some((u) => sameSource(u, v))) uniq.push(v);
    return [col, uniq.map(sourceLabel)];
  });
}
