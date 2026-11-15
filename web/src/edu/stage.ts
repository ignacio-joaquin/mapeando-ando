/**
 * Puesta en escena de una lección: qué se ve, qué capas van, a dónde va la
 * cámara, y el registro de intentos. Lo usa EduOverlay; ver docs/educacion.md.
 */
import { useEffect, useRef } from "react";
import { LAYERS } from "../map/layers";
import { useEdu, type Attempt } from "../state/edu";
import { useFreshRoute, usePlan } from "../state/plan";
import { useStore } from "../state/store";
import { useSun } from "../state/sun";
import type { Waypoint } from "../state/plan";
import type { Lesson, LessonContext, LessonNeed, LessonStep, Preset, StepSetup } from "./lessons";

export function useLessonContext(): { ctx: LessonContext; example: boolean; loading: boolean } {
  const fresh = useFreshRoute();
  const waypoints = usePlan((s) => s.waypoints);
  const loading = usePlan((s) => s.status.kind === "loading");
  const attempts = useEdu((s) => s.attempts);
  const places = useStore((s) => s.places);
  const example = fresh?.example ?? false;
  return {
    ctx: { route: fresh && !fresh.example ? fresh.route : null, waypoints, attempts, places },
    example,
    loading,
  };
}

/** Anota cada ruta real que llega mientras la lección está abierta. */
export function useRecordAttempts() {
  const fresh = useFreshRoute();
  const siteId = useStore((s) => s.activeSiteId);
  useEffect(() => {
    if (!fresh || fresh.example) return;
    const { waypoints, departAt, roundTrip } = usePlan.getState();
    const v = fresh.route.verdict;
    const attempt: Attempt = {
      // Con o sin vuelta al hábitat son rutas distintas: entra en la geometría.
      geometryKey: JSON.stringify([siteId, roundTrip, waypoints.map((w) => [w.lat, w.lon, w.dwellMin])]),
      departMs: departAt.getTime(),
      status: v.status,
      limiting: v.limiting_factor,
      passed: v.robustness?.passed ?? null,
      evaluated: v.robustness?.evaluated ?? null,
      daylightEvaluated: v.limits?.some((l) => l.id === "daylight" && l.status !== "not_evaluated" && l.complete) ?? false,
    };
    useEdu.getState().record(attempt);
  }, [fresh, siteId]);
}

/**
 * Muestra, resalta y tapa piezas de la interfaz con atributos en <body> (ver
 * index.css). Con data-edu-ui, lo que no está en data-edu-show se esconde.
 */
export function useStage(step: LessonStep, setup: StepSetup, revealed: boolean) {
  const show = [...setup.ui].join(" ");
  const focus = step.focus?.join(" ") ?? "";
  const hide = revealed ? "" : (step.hide?.join(" ") ?? "");
  useEffect(() => {
    const b = document.body;
    b.dataset.eduUi = "";
    b.dataset.eduShow = show;
    b.dataset.eduFocus = focus;
    b.dataset.eduHide = hide;
    return () => {
      delete b.dataset.eduUi;
      delete b.dataset.eduShow;
      delete b.dataset.eduFocus;
      delete b.dataset.eduHide;
    };
  }, [show, focus, hide]);
}

/** La base de imagen no la maneja la lección: es el piso de todo lo demás. */
const UNMANAGED = new Set(["base-ortho"]);

/**
 * Mientras dura la lección, las capas y los pines los decide el paso. Al
 * entrar se guarda cómo los tenía el usuario y al salir se le devuelven.
 */
export function useStepLayers(setup: StepSetup) {
  const saved = useRef<{ visible: Record<string, boolean>; kinds: ReturnType<typeof useStore.getState>["placeKinds"] } | null>(null);
  useEffect(() => {
    const st = useStore.getState();
    saved.current = {
      visible: Object.fromEntries(Object.entries(st.layers).map(([id, l]) => [id, l.visible])),
      kinds: st.placeKinds,
    };
    return () => {
      const s = saved.current;
      if (!s) return;
      const now = useStore.getState();
      for (const [id, l] of Object.entries(now.layers)) {
        if (s.visible[id] !== undefined && l.visible !== s.visible[id]) now.toggleLayer(id);
      }
      now.setPlaceKinds(s.kinds);
    };
  }, []);

  const wanted = setup.layers.join(",");
  // Una capa que llega tarde (disponibilidad) también se prende.
  const available = useStore((s) => LAYERS.map((l) => (s.layers[l.id]?.available ? "1" : "0")).join(""));
  useEffect(() => {
    const want = new Set(wanted.split(","));
    const { layers, toggleLayer } = useStore.getState();
    for (const spec of LAYERS) {
      if (UNMANAGED.has(spec.id)) continue;
      const l = layers[spec.id];
      if (!l) continue;
      const on = want.has(spec.id) && l.available;
      if (l.visible !== on) toggleLayer(spec.id);
    }
  }, [wanted, available]);

  useEffect(() => {
    const kinds = saved.current?.kinds ?? useStore.getState().placeKinds;
    useStore
      .getState()
      .setPlaceKinds(
        Object.fromEntries(Object.keys(kinds).map((k) => [k, setup.pins && kinds[k as keyof typeof kinds]])) as typeof kinds,
      );
  }, [setup.pins]);
}

/** Cámara y zoom: vuela al entrar al paso; si encuadra la ruta y todavía no hay, vuela cuando llega. */
export function useStepCamera(lesson: Lesson, stepIndex: number, setup: StepSetup, hasRoute: boolean) {
  const step = lesson.steps[stepIndex];
  const spec = step?.camera;
  const { requestCamera, setZoomLock } = useEdu.getState();
  useEffect(() => {
    setZoomLock(setup.lockZoom);
  }, [setup.lockZoom, setZoomLock]);
  useEffect(() => () => setZoomLock(false), [setZoomLock]);
  useEffect(() => {
    if (spec) requestCamera(spec);
    // Solo al entrar al paso (y cuando aparece la ruta que se quiere encuadrar).
  }, [lesson.id, stepIndex, spec?.kind === "route" && hasRoute]);
}

/** Capas que el paso quiere y el server todavía no tiene. */
export function useMissingLayers(setup: StepSetup): readonly string[] {
  const layers = useStore((s) => s.layers);
  return setup.layers
    .filter((id) => !UNMANAGED.has(id) && layers[id] && !layers[id].available)
    .map((id) => LAYERS.find((l) => l.id === id)?.label ?? id);
}


/**
 * Cada misión arranca con la travesía vacía: la consigna la cumple lo que hace
 * el alumno, no una ruta que ya estaba. Al salir vuelve la travesía que tenía:
 * lo que se hace en el entrenamiento no la pisa. La misión final (`keepRoute`)
 * deja la ruta armada, para imprimirla o compartirla.
 */
export function usePlanSandbox(keepRoute: boolean) {
  useEffect(() => {
    const before = usePlan.getState();
    const saved = {
      siteId: before.siteId,
      waypoints: before.waypoints,
      departAt: before.departAt,
      clickMode: before.clickMode,
      roundTrip: before.roundTrip,
    };
    before.clear();
    // Ida y vuelta, como en una salida de verdad: volver con reserva es parte de la regla.
    before.setRoundTrip(true);
    // El selector de modo se esconde en la lección: si quedó en "inspeccionar",
    // un clic en el mapa no sumaría puntos y el alumno no tendría cómo salir.
    before.setClickMode("add");
    return () => {
      const now = usePlan.getState();
      now.setClickMode(saved.clickMode);
      now.setRoundTrip(saved.roundTrip);
      if (keepRoute && now.waypoints.length >= 2) return;
      // Si cambió de sitio, los puntos guardados son de otro lugar: no se devuelven.
      if (now.siteId !== saved.siteId) return;
      usePlan.setState({
        waypoints: saved.waypoints,
        departAt: saved.departAt,
        result: null,
        resultKey: null,
        notice: null,
      });
    };
  }, [keepRoute]);
}

/**
 * Carga un escenario armado con las acciones normales del planificador: los
 * puntos son lugares reales de places.json, buscados por id. Devuelve por qué
 * no se pudo, o null si se cargó.
 */
export function applyPreset(preset: Preset): string | null {
  const { places, activeSiteId } = useStore.getState();
  if (activeSiteId !== preset.site) return `Este escenario es del sitio "${preset.site}".`;
  const find = (id: string) => places?.places.find((p) => p.id === id);
  const habitat = find(preset.habitat);
  const destination = find(preset.destination);
  if (!habitat || !destination) return "Los lugares de este escenario ya no están en el sitio.";
  const plan = usePlan.getState();
  plan.clear();
  plan.setRoundTrip(true);
  plan.addPoint({ lat: habitat.lat, lon: habitat.lon }, habitat.id);
  plan.addPoint({ lat: destination.lat, lon: destination.lon }, destination.id);
  const dest = usePlan.getState().waypoints[1];
  if (dest) plan.updatePoint(dest.id, { dwellMin: preset.dwellMin });
  useEdu.getState().requestCamera({ kind: "route" });
  return null;
}

/** ¿La travesía de ahora es exactamente el escenario, sin cambios del alumno? */
export function presetActive(waypoints: readonly Waypoint[], preset: Preset): boolean {
  const [h, d] = waypoints;
  return (
    waypoints.length === 2 &&
    h?.placeId === preset.habitat &&
    d?.placeId === preset.destination &&
    d.dwellMin === preset.dwellMin
  );
}

/**
 * ¿El server tiene lo que necesita cada misión, para el sitio activo?
 * null = todavía se está consultando.
 */
export function useDataReady(): Readonly<Record<LessonNeed, boolean | null>> {
  const catalog = useSun((s) => s.catalog);
  const sunLoading = useSun((s) => s.load.kind === "loading");
  const places = useStore((s) => s.places);
  return {
    shadows: catalog ? catalog.sols.length > 0 : sunLoading ? null : false,
    places: places ? places.places.length > 0 : false,
  };
}
