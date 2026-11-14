/** Constantes de Marte. Un solo lugar: nunca hardcodear un radio en un componente. */

/**
 * Radio medio volumétrico, el que piden los tickets para la barra de escala
 * y las mediciones por defecto (3389.5 km).
 */
export const MARS_RADIUS_MEAN_M = 3_389_500;

/**
 * Radio ecuatorial de la esfera de referencia que usan los productos USGS/HiRISE
 * y `sites/common.json` (`radius_m: 3396190`). Es el radio de la proyección en la
 * que viene el DTM (Equidistant Cylindrical).
 *
 * OJO: medir sobre el raster con el radio medio en vez del de la proyección
 * introduce ~0.2% de error (≈20 m cada 10 km). Decisión del equipo pendiente;
 * ver "decisiones abiertas" en docs/context.md.
 */
export const MARS_RADIUS_PROJECTION_M = 3_396_190;

/** Radio que se usa hoy para distancias y escala. */
export const MARS_RADIUS_M = MARS_RADIUS_MEAN_M;

/** Duración del sol marciano en segundos terrestres. */
export const MARS_SOL_SECONDS = 88_775.244;
