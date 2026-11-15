import type { SourceInfo } from "./provenance";

/**
 * Equipo que se puede llevar en la EVA, con su masa (MAP-50).
 *
 * La masa elegida viaja como `cargo_kg` en POST /api/route y entra a Pandolf
 * (api/consumables.py): sube el gasto metabólico y con él el O2, y puede pasar
 * el veredicto de GO a NO-GO.
 *
 * No hay herramientas de EVA marciana que hayan volado. Las masas son las de
 * las herramientas de Apollo, pesadas para el vuelo, y cada una cita de dónde
 * sale. Que un kit para Marte pese lo mismo es un supuesto y se dice. Son
 * masas, no pesos: la gravedad la pone el modelo (0,38 g).
 */

const ALLTON_A17 = "Allton 1989, Catalog of Apollo Lunar Surface Geological Sampling Tools and Containers (JSC-23454), tabla de Apollo 17";
const ALLTON_A16 = "Allton 1989 (JSC-23454), tabla de Apollo 16";
const ALLTON_DRILL = "Allton 1989 (JSC-23454), ficha del taladro";
const WOTM = "Working on the Moon (ALSJ), Imagery Weight Totals: Apollo 11 vs. Apollo 17";

interface Part {
  readonly name: string;
  readonly grams: number;
  /** Cita corta de la fuente de este número. */
  readonly ref: string;
}

export interface EquipmentItem {
  readonly id: string;
  readonly name: string;
  readonly use: string;
  readonly parts: readonly Part[];
  readonly mission: string;
}

/** Orden: lo más pesado primero, que es lo que más mueve el veredicto. */
export const EQUIPMENT: readonly EquipmentItem[] = [
  {
    id: "drill",
    name: "Taladro de núcleo",
    use: "Saca columnas de suelo de hasta 3 m",
    mission: "Apollo 15–17",
    parts: [{ name: "Apollo Lunar Surface Drill, total de sus 4 componentes", grams: 13400, ref: ALLTON_DRILL }],
  },
  {
    id: "camera",
    name: "Cámara",
    use: "Hasselblad de 70 mm con lente, empuñadura y un cargador",
    mission: "Apollo 17",
    parts: [
      { name: "Hasselblad eléctrica de datos (3,1 lb)", grams: 3.1 * 453.592, ref: WOTM },
      { name: "Lente de 60 mm (1,7 lb)", grams: 1.7 * 453.592, ref: WOTM },
      { name: "Gatillo, empuñadura y soporte (0,6 lb)", grams: 0.6 * 453.592, ref: WOTM },
      { name: "Un cargador de 70 mm (1,4 lb)", grams: 1.4 * 453.592, ref: WOTM },
    ],
  },
  {
    id: "sampling",
    name: "Kit de muestras",
    use: "Pala, pinzas, mango largo, bolsa de recolección y 20 bolsitas",
    mission: "Apollo 16–17",
    parts: [
      { name: "Pala grande ajustable", grams: 590.0, ref: ALLTON_A17 },
      { name: "Pinzas de 32 pulgadas", grams: 454.0, ref: ALLTON_A17 },
      { name: "Mango de extensión largo", grams: 816.0, ref: ALLTON_A17 },
      { name: "Bolsa de recolección de muestras (SCB 1)", grams: 742.7, ref: ALLTON_A16 },
      { name: "Dispensador de 20 bolsas documentadas", grams: 440.4, ref: ALLTON_A16 },
    ],
  },
  {
    id: "rake",
    name: "Rastrillo",
    use: "Junta piedritas de 1 a 2 cm del regolito",
    mission: "Apollo 17",
    parts: [{ name: "Rastrillo", grams: 1497.0, ref: ALLTON_A17 }],
  },
  {
    id: "hammer",
    name: "Martillo geológico",
    use: "Parte rocas y clava los tubos",
    mission: "Apollo 17",
    parts: [{ name: "Martillo pesado", grams: 1315.0, ref: ALLTON_A17 }],
  },
  {
    id: "core_tubes",
    name: "Tubos de núcleo",
    use: "Un par de tubos de 4 cm, para clavar a martillo",
    mission: "Apollo 17",
    parts: [
      { name: "Tubo de 4 cm, inferior", grams: 316.6, ref: ALLTON_A17 },
      { name: "Tubo de 4 cm, superior", grams: 299.1, ref: ALLTON_A17 },
    ],
  },
  {
    id: "gnomon",
    name: "Gnomon",
    use: "Escala, vertical y color en cada foto de muestra",
    mission: "Apollo 17",
    parts: [{ name: "Gnomon", grams: 272.0, ref: ALLTON_A17 }],
  },
];

const BY_ID = new Map(EQUIPMENT.map((e) => [e.id, e]));

export const isEquipmentId = (id: string): boolean => BY_ID.has(id);

export const itemKg = (e: EquipmentItem): number => e.parts.reduce((s, p) => s + p.grams, 0) / 1000;

/** Tope de la carga libre (muestras juntadas, otro equipo). El server acepta hasta 500 kg. */
export const MAX_EXTRA_KG = 100;

/**
 * Carga libre válida: 0–MAX_EXTRA_KG, redondeada a 0,1 kg (lo que entra en el
 * enlace). La usan el panel y el enlace: así un enlace abre con la misma carga.
 */
export function clampExtraKg(kg: number): number {
  return Number.isFinite(kg) ? Math.min(Math.max(0, Math.round(kg * 10) / 10), MAX_EXTRA_KG) : 0;
}

/** Masa total que va a la API: equipo elegido + carga libre, redondeada a gramos. */
export function cargoKg(ids: readonly string[], extraKg: number): number {
  const kit = ids.reduce((s, id) => {
    const e = BY_ID.get(id);
    return e ? s + itemKg(e) : s;
  }, 0);
  return Math.round((kit + extraKg) * 1000) / 1000;
}

export function itemSource(e: EquipmentItem): SourceInfo {
  const refs = [...new Set(e.parts.map((p) => p.ref))];
  return {
    provenance: "OBSERVED",
    mission: e.mission,
    instrument: "masa de vuelo",
    source: refs.join(" · "),
    assumptions: [
      ...e.parts.map((p) => `${p.name}: ${Math.round(p.grams)} g`),
      "Herramienta de Apollo como referencia: un kit para Marte puede pesar distinto",
    ],
  };
}

/** Lo que escribe el usuario a mano: no tiene fuente más que él. */
export const EXTRA_SOURCE: SourceInfo = {
  provenance: "ASSUMED",
  mission: null,
  instrument: "dato del usuario",
  source: "Carga escrita a mano en el planificador",
  assumptions: ["Muestras juntadas u otro equipo; el planificador no la verifica"],
};
