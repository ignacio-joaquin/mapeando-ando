/** Constantes de Marte. Un solo lugar: nunca hardcodear un radio en un componente. */

/**
 * Radio de Marte, esfera IAU Mars 2000: 3396190 m.
 *
 * Es el mismo valor que usan `api/terrain.py`, `sites/common.json` y la
 * proyección en la que vienen los DTM de HiRISE (Equidistant Cylindrical).
 * Medir sobre el raster con otro radio es medir mal: con el radio medio
 * volumétrico (3389.5 km) las distancias dan ~0.2% cortas (≈20 m cada 10 km) y
 * no coinciden con las que devuelve `/api/route` para el mismo tramo.
 */
export const MARS_RADIUS_M = 3_396_190;

/** Duración del sol marciano en segundos terrestres. */
export const MARS_SOL_SECONDS = 88_775.244;

/**
 * Radio de la Tierra que MapLibre usa por dentro (`earthRadius` de maplibre-gl).
 * Como los tiles etiquetan el lon/lat de Marte como si fuera de la Tierra
 * (pipeline/tiles.py), MapLibre cree que un grado mide ~111 km cuando en Marte
 * mide ~59 km.
 */
const MAPLIBRE_EARTH_RADIUS_M = 6_371_008.8;

/**
 * Exageración vertical del relieve 3D que deja la escala REAL: el terreno en
 * horizontal sale estirado R_Tierra / R_Marte (≈ 1,876), así que la altura se
 * estira lo mismo. Con 1 el relieve se vería casi la mitad de empinado de lo
 * que es: una pendiente de 30° parecería de 17°.
 */
export const TERRAIN_TRUE_SCALE = MAPLIBRE_EARTH_RADIUS_M / MARS_RADIUS_M;
