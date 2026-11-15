---
name: mapeando-maplibre
description: >
  Mapa de supervivencia con MapLibre GL en React 19: capas, fuentes, performance y planificador 4D.
  Trigger: Al tocar el mapa en web/, capas, tiles, markers, popups, MapLibre, o el slider de tiempo.
metadata:
  author: mapeando-ando
  version: "1.0"
---

## Cuándo se usa

Cualquier trabajo sobre el mapa de `web/`: capas de supervivencia, landmarks, rutas, planificador 4D.
Leer junto con las skills `react-19`, `typescript` y `tailwind-4`.

---

## Reglas duras

### 1. MapLibre, no Mapbox

`maplibre-gl` (BSD, sin token). **Nunca** `mapbox-gl` ni nada que pida API key: el repo es público y el server no guarda claves.

### 2. Marte no es la Tierra

- Sin basemaps de la Tierra, sin OSM, sin Google. Las únicas fuentes son nuestros tiles de `/tiles/` y los datos de `sites/*.json`.
- CRS planetario, no Web Mercator automático. El DEM viene en Equidistant Cylindrical; declarar la proyección explícitamente y no dejar que la librería asuma Tierra.
- Escalas y distancias con el radio marciano (`3396190` m). Un cálculo de distancia con radio terrestre es un bug de datos, no un detalle visual.

### 3. El mapa vive fuera de React

La instancia de MapLibre es imperativa y mutable; React no la re-renderiza.

```tsx
// ✅ instancia en un ref, creada una vez
const mapRef = useRef<maplibregl.Map | null>(null);
const containerRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (mapRef.current || !containerRef.current) return;
  const map = new maplibregl.Map({ container: containerRef.current, style, center, zoom });
  mapRef.current = map;
  return () => { map.remove(); mapRef.current = null; };
}, []);

// ❌ NUNCA: guardar el Map en useState, o recrearlo en cada render
```

Estado del mapa (sitio activo, capas visibles, instante del planificador) en Zustand (skill `zustand-5`); el efecto sincroniza store → mapa con `setPaintProperty` / `setLayoutProperty`, no destruyendo capas.

### 4. Capas declarativas y con nombre estable

Un id por capa, en un solo lugar, en el formato `<dominio>-<qué>`: `survival-slope`, `survival-dose`, `landmarks-points`, `route-line`. La API y el frontend comparten esos ids; renombrar uno es breaking change.

Agregar capa: siempre `if (map.getLayer(id)) return;` antes de `addLayer`, y `map.isStyleLoaded()` / evento `load` antes de tocar el estilo.

### 5. Performance en una EC2 chica con GB de raster

- Raster precomputado por el pipeline y servido desde `/tiles/` (nginx, cache 1 h). El frontend **no** procesa raster.
- Vectores grandes: GeoJSON ya simplificado por el pipeline, o PMTiles. Nada de recalcular geometría en el cliente por frame.
- Toggle de capa = cambiar visibilidad, no re-fetchear.
- Planificador 4D: el slider de tiempo cambia qué capa/frame se muestra entre salidas ya calculadas; nunca dispara cómputo de sombras en el cliente.

### 6. La UI tiene que ser legible en EVA

Es un mapa de supervivencia: la claridad es funcional, no estética.

- Alto contraste, legible en claro y oscuro (el HTML actual ya define tokens y respeta `prefers-color-scheme`).
- Nunca comunicar algo crítico solo por color: color + ícono o patrón.
- Toda capa derivada muestra su fuente y su resolución; si un valor es estimado, dice que es estimado.
- Que funcione con teclado y en pantalla chica.

---

## Anti-patrones

- ❌ Un `useEffect` que recrea el mapa cuando cambia un filtro.
- ❌ `useMemo`/`useCallback` manuales (React Compiler: ver skill `react-19`).
- ❌ Pedir el mismo GeoJSON en cada toggle.
- ❌ Hardcodear bbox o centro de un sitio en el frontend: viene de `/api/sites`.
- ❌ Dibujar una ruta "linda" que no sale del `/api/route` real.
