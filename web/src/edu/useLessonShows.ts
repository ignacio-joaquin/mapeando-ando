import { useEdu } from "../state/edu";
import { lessonById, setupAt, type EduTarget } from "./lessons";

/**
 * ¿El paso abierto de la lección muestra alguna de estas piezas? En pantalla
 * chica el planificador, el perfil y las capas arrancan plegados: con esto se
 * abren solos cuando una lección los señala, para que el alumno no tenga que
 * buscarlos. Fuera del entrenamiento, siempre false.
 */
export function useLessonShows(targets: readonly EduTarget[]): boolean {
  const open = useEdu((s) => s.open);
  const lesson = lessonById(useEdu((s) => s.lessonId));
  const step = useEdu((s) => s.step);
  if (!open || !lesson) return false;
  const { ui } = setupAt(lesson, Math.min(step, lesson.steps.length - 1));
  return targets.some((t) => ui.has(t));
}
