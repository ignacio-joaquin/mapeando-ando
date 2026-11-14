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
