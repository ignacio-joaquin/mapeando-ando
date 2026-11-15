import { useEffect, useRef } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  GeoJSONSource,
  type ExpressionSpecification,
  type MapMouseEvent,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
// MapLibre 6 arma la URL del worker relativa a su propio módulo, en runtime: Vite no la
// ve y en el build el worker no se emite (404 → nginx devuelve index.html y el mapa no
// arranca). Con ?url Vite lo copia a assets/ y le pasamos la URL real.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Feature, FeatureCollection, LineString, Polygon } from "geojson";
import { LAYERS, tileUrl } from "./layers";
import { readyTiles } from "./terrain";
import { SHADOWS_LAYER_ID, SHADOWS_NIGHT_LAYER_ID, bandLayerId, frameAt, okBands } from "./sun";
import { useSun } from "../state/sun";
import { useStore } from "../state/store";
import type { Bbox, RouteLeg } from "../api/schemas";
import { useFreshRoute, usePlan } from "../state/plan";
import { LEG_CLASS_COLOR, waypointLabel } from "./route";

/**
 * El mapa. La instancia de MapLibre es imperativa y mutable: vive en un ref,
 * se crea una vez y los efectos sincronizan store -> mapa. Nunca en useState.
 *
 * LIMITACIÓN CONOCIDA: MapLibre asume Web Mercator terrestre para el encuadre.
 * Las medidas que se le muestran al usuario (escala, distancias) NO salen de
 * MapLibre: salen de src/mars/geo.ts con el radio marciano. Servir los tiles en
 * la proyección del DTM (Equidistant Cylindrical) es trabajo del pipeline.
 */

setWorkerUrl(maplibreWorkerUrl);

/** Estilo base: fondo vacío. No hay basemap terrestre, a propósito. */
const emptyStyle: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#1a1714" } }],
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
};

function bboxFeature(bbox: Bbox): Feature<Polygon> {
  const { lon_min, lon_max, lat_min, lat_max } = bbox;
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lon_min, lat_min],
          [lon_max, lat_min],
          [lon_max, lat_max],
          [lon_min, lat_max],
          [lon_min, lat_min],
        ],
      ],
    },
  };
}

/**
 * Orden de las capas, de abajo hacia arriba: rasters de relieve y de
 * supervivencia → sombras por hora → velo de noche → curvas de nivel →
 * recuadro del sitio → ruta. Las sombras van arriba de todo raster sin importar
 * qué se cargó primero (si no, la ortoimagen opaca las tapa), así que un raster
 * nuevo se inserta debajo de la primera capa de sombras que exista.
 */
function rasterBeforeId(map: MapLibreMap, shadowIds: readonly string[]): string {
  const lowestShadow = shadowIds.find((id) => map.getLayer(id));
  if (lowestShadow) return lowestShadow;
  if (map.getLayer(SHADOWS_NIGHT_LAYER_ID)) return SHADOWS_NIGHT_LAYER_ID;
  return map.getLayer("relief-contours") ? "relief-contours" : "site-bbox-line";
}

interface Props {
  readonly center: { readonly lat: number; readonly lon: number };
  readonly bbox: Bbox;
  readonly siteId: string;
}

export function MapView({ center, bbox, siteId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const setCursor = useStore((s) => s.setCursor);
  const setPicked = useStore((s) => s.setPicked);
  const layers = useStore((s) => s.layers);

  // ¿El mapa ya disparó "load"? No alcanza con map.isStyleLoaded(): da false
  // cada vez que hay tiles bajando, y un once("load") registrado después de la
  // carga inicial no se dispara nunca. Así se perdían actualizaciones (la ruta
  // nueva no se dibujaba). Después de "load", sumar fuentes y capas es seguro.
  const readyRef = useRef(false);
  const whenReady = (map: MapLibreMap, fn: () => void) => {
    if (readyRef.current) fn();
    else map.once("load", fn);
  };

  // 1. Crear el mapa una sola vez.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: emptyStyle,
      center: [center.lon, center.lat],
      zoom: 12,
      attributionControl: false,
    });
    // Primer listener de "load": los once("load") de los otros efectos corren
    // después y ya ven la bandera prendida.
    readyRef.current = false;
    map.on("load", () => {
      readyRef.current = true;
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("mousemove", (e: MapMouseEvent) => setCursor({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    map.on("mouseout", () => setCursor(null));
    // La barra de escala sigue al zoom real del mapa (y a la latitud del centro).
    const syncView = () =>
      useStore.getState().setView({ zoom: map.getZoom(), lat: map.getCenter().lat });
    map.on("move", syncView);
    map.on("load", syncView);
    map.on("click", (e: MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      // El modo se lee al momento del clic: el handler se registra una sola vez.
      const plan = usePlan.getState();
      if (plan.clickMode === "add") plan.addPoint(p);
      else setPicked(p);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, [center.lat, center.lon, setCursor, setPicked]);

  // 2. Encuadre y recuadro del sitio activo.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const data = bboxFeature(bbox);
      const src = map.getSource("site-bbox");
      if (src instanceof GeoJSONSource) {
        src.setData(data);
      } else {
        map.addSource("site-bbox", { type: "geojson", data });
        map.addLayer({
          id: "site-bbox-line",
          type: "line",
          source: "site-bbox",
          paint: { "line-color": "#e07a4a", "line-width": 1.5, "line-dasharray": [3, 2] },
        });
        // Velo de noche del deslizador del sol (lo prende el efecto de sombras).
        // Mismo color que la sombra de los tiles (pipeline/shadow_tiles.py).
        // Se crea antes que cualquier raster y los rasters se insertan debajo
        // (rasterBeforeId), así que siempre queda arriba de ellos.
        map.addLayer(
          {
            id: SHADOWS_NIGHT_LAYER_ID,
            type: "fill",
            source: "site-bbox",
            layout: { visibility: "none" },
            paint: { "fill-color": "#0c0a09", "fill-opacity": 0.69 },
          },
          "site-bbox-line",
        );
      }
      map.fitBounds(
        [
          [bbox.lon_min, bbox.lat_min],
          [bbox.lon_max, bbox.lat_max],
        ],
        { padding: 48, animate: false },
      );
    };
    whenReady(map, apply);
  }, [bbox]);

  // 3. Sincronizar store -> capas. Se agregan solo las disponibles.
  //    Cada fuente recuerda de qué sitio y de qué corrida del pipeline salió:
  //    si cambia cualquiera de los dos, se rearma (si no, al cambiar de sitio
  //    seguiría pidiendo los tiles del anterior).
  const terrain = useStore((s) => s.terrain);
  const sourceKeysRef = useRef(new Map<string, string>());
  // Capas de sombra por hora del sol cargado (las arma el efecto 3b), en orden.
  const shadowIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sourceKey = `${siteId}|${terrain?.generated_at ?? ""}`;
    const apply = () => {
      const keys = sourceKeysRef.current;
      for (const spec of LAYERS) {
        // Las sombras dependen de la hora: las maneja su propio efecto (abajo).
        if (spec.id === SHADOWS_LAYER_ID) continue;
        const state = layers[spec.id];
        if (!state) continue;
        const tiles = readyTiles(terrain, spec.id);
        const usable = state.available && (spec.kind === "vector" || tiles !== null);

        if (keys.get(spec.id) !== sourceKey && (map.getLayer(spec.id) || map.getSource(spec.id))) {
          if (map.getLayer(spec.id)) map.removeLayer(spec.id);
          if (map.getSource(spec.id)) map.removeSource(spec.id);
          keys.delete(spec.id);
        }
        const existing = map.getLayer(spec.id);

        if (!usable) {
          if (existing) map.setLayoutProperty(spec.id, "visibility", "none");
          continue;
        }

        // Vectoriales (curvas de nivel): un GeoJSON que sirve el pipeline en
        // /tiles/<sitio>/contours.geojson. MapLibre lo descarga solo.
        if (spec.kind === "vector") {
          if (!existing) {
            map.addSource(spec.id, { type: "geojson", data: tileUrl(spec, siteId) });
            map.addLayer(
              {
                id: spec.id,
                type: "line",
                source: spec.id,
                paint: {
                  "line-color": spec.legend[0]?.color ?? "#e0a24a",
                  // Finas de lejos y más marcadas de cerca: de otro modo, a
                  // zoom bajo las curvas tapan el relieve que hay debajo.
                  "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 17, 1.2],
                  "line-opacity": state.opacity,
                },
              },
              "site-bbox-line",
            );
            keys.set(spec.id, sourceKey);
          }
          map.setLayoutProperty(spec.id, "visibility", state.visible ? "visible" : "none");
          map.setPaintProperty(spec.id, "line-opacity", state.opacity);
          continue;
        }

        if (!existing && tiles) {
          // Zoom y límites salen de terrain.json: fuera de ellos no hay PNG, y
          // pasado el zoom máximo MapLibre agranda el último nivel en vez de
          // pedir tiles que no existen.
          map.addSource(spec.id, {
            type: "raster",
            tiles: [tileUrl(spec, siteId)],
            tileSize: 256,
            minzoom: tiles.minzoom,
            maxzoom: tiles.maxzoom,
            bounds: tiles.bounds,
          });
          // Debajo de las sombras y de las curvas, para que se lean encima del color.
          map.addLayer(
            {
              id: spec.id,
              type: "raster",
              source: spec.id,
              paint: {
                "raster-opacity": state.opacity,
                // Una capa por clases se agranda sin suavizar: el suavizado
                // mezclaría clases y mostraría colores que no están en la leyenda.
                "raster-resampling": spec.categorical ? "nearest" : "linear",
              },
            },
            rasterBeforeId(map, shadowIdsRef.current),
          );
          keys.set(spec.id, sourceKey);
        }
        map.setLayoutProperty(spec.id, "visibility", state.visible ? "visible" : "none");
        map.setPaintProperty(spec.id, "raster-opacity", state.opacity);
      }
    };
    whenReady(map, apply);
  }, [layers, siteId, terrain]);

  // 3b. Sombras por hora (deslizador de tiempo del sol). Al cargar un sol se
  //     agrega una capa por hora, todas visibles con opacidad 0 para que
  //     MapLibre ya tenga los tiles; mover el deslizador solo cambia qué hora
  //     tiene opacidad, sin pedir nada nuevo. Así no se traba.
  const sunSol = useSun((s) => s.sol);
  const shadowState = layers[SHADOWS_LAYER_ID];
  const shadowOn = !!shadowState?.visible && !!shadowState.available;
  const shadowOpacity = shadowState?.opacity ?? 1;
  // Qué mostrar se reduce a una clave que cambia una vez por hora, no por
  // minuto: mientras el deslizador se mueve dentro de la misma hora, el mapa
  // no se toca.
  const shadowKey = useSun((s) => {
    if (!s.sol || s.time === null) return "none";
    const f = frameAt(s.sol, s.time);
    return f.kind === "band" ? bandLayerId(s.sol.sol_tag, f.band) : f.kind;
  });

  // Estructura: una fuente y una capa por hora del sol cargado.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    whenReady(map, () => {
      const wanted = sunSol ? okBands(sunSol) : [];
      const wantedIds = sunSol ? wanted.map((b) => bandLayerId(sunSol.sol_tag, b)) : [];
      // Sol nuevo (o sitio nuevo): sacar las horas del anterior.
      for (const id of shadowIdsRef.current) {
        if (wantedIds.includes(id)) continue;
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      }
      wanted.forEach((b, i) => {
        const id = wantedIds[i]!;
        if (map.getSource(id) || !b.template) return;
        map.addSource(id, {
          type: "raster",
          tiles: [`/tiles/${siteId}/${b.template}`],
          tileSize: 256,
          ...(b.minzoom !== undefined ? { minzoom: b.minzoom } : {}),
          ...(b.maxzoom !== undefined ? { maxzoom: b.maxzoom } : {}),
          ...(b.bounds ? { bounds: b.bounds } : {}),
        });
        map.addLayer(
          {
            id,
            type: "raster",
            source: id,
            layout: { visibility: "none" },
            // Máscara por clases: sin suavizar, para no inventar "media sombra".
            paint: { "raster-opacity": 0, "raster-resampling": "nearest", "raster-fade-duration": 0 },
          },
          // Arriba de todo raster y debajo del velo de noche (ver rasterBeforeId).
          map.getLayer(SHADOWS_NIGHT_LAYER_ID)
            ? SHADOWS_NIGHT_LAYER_ID
            : map.getLayer("relief-contours")
              ? "relief-contours"
              : "site-bbox-line",
        );
      });
      shadowIdsRef.current = wantedIds;
    });
  }, [sunSol, siteId]);

  // Qué hora se ve. Corre solo cuando cambia la hora de la máscara, se prende
  // o apaga la capa, o cambia su opacidad.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    whenReady(map, () => {
      for (const id of shadowIdsRef.current) {
        if (!map.getLayer(id)) continue;
        map.setLayoutProperty(id, "visibility", shadowOn ? "visible" : "none");
        map.setPaintProperty(id, "raster-opacity", shadowOn && id === shadowKey ? shadowOpacity : 0);
      }
      if (map.getLayer(SHADOWS_NIGHT_LAYER_ID)) {
        map.setLayoutProperty(SHADOWS_NIGHT_LAYER_ID, "visibility", shadowOn && shadowKey === "night" ? "visible" : "none");
        map.setPaintProperty(SHADOWS_NIGHT_LAYER_ID, "fill-opacity", 0.69 * shadowOpacity);
      }
    });
  }, [shadowKey, shadowOn, shadowOpacity, sunSol]);

  // El contenedor de MapLibre va adentro de otro div: maplibre-gl.css le pone
  // `position: relative` a .maplibregl-map y le gana al `absolute inset-0` de
  // Tailwind (que va en @layer). Sin el wrapper el mapa mide 0 px de alto.
  // 4. Marcadores de la travesía: salida (A), estaciones (1, 2…) y llegada (B).
  //    Arrastrables; al soltar se mueve el punto en el store.
  const waypoints = usePlan((s) => s.waypoints);
  const openStop = usePlan((s) => s.openStop);
  const markersRef = useRef(new Map<string, Marker>());
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;
    const alive = new Set(waypoints.map((w) => w.id));
    for (const [id, m] of markers) {
      if (!alive.has(id)) {
        m.remove();
        markers.delete(id);
      }
    }
    waypoints.forEach((w, i) => {
      const label = waypointLabel(i, waypoints.length);
      let m = markers.get(w.id);
      if (!m) {
        const el = document.createElement("button");
        el.type = "button";
        m = new Marker({ element: el, draggable: true })
          .setLngLat([w.lon, w.lat])
          .addTo(map);
        m.on("dragend", () => {
          const ll = m?.getLngLat();
          if (ll) usePlan.getState().movePoint(w.id, { lat: ll.lat, lon: ll.lng });
        });
        el.addEventListener("click", (ev) => {
          // Abrir la estación sin agregar un punto nuevo debajo.
          ev.stopPropagation();
          const idx = usePlan.getState().waypoints.findIndex((x) => x.id === w.id);
          usePlan.getState().setOpenStop(idx);
        });
        markers.set(w.id, m);
      }
      m.setLngLat([w.lon, w.lat]);
      const el = m.getElement();
      el.textContent = label.short;
      el.title = `${label.long}${w.task ? ` · ${w.task}` : ""}`;
      el.setAttribute("aria-label", el.title);
      // OJO: MapLibre pone sus propias clases en el elemento del marcador, y
      // `.maplibregl-marker` es la que lo saca del flujo (`position:absolute;
      // top:0; left:0`) para que el transform lo ubique en la coordenada.
      // Pisar className entero las borraba y cada marcador caía donde lo dejaba
      // el flujo normal, corrido hacia abajo por los anteriores. Reescribimos
      // solo las nuestras y conservamos las de MapLibre (incluidas las que
      // alterna sola, como -draggable o -covered).
      const fromMapLibre = Array.from(el.classList).filter((c) =>
        c.startsWith("maplibregl-"),
      );
      el.className = [...fromMapLibre, markerClass(label.kind, openStop === i)].join(" ");
    });
  }, [waypoints, openStop]);

  // 5. Línea de la ruta (id de contrato: route-line), coloreada por tramo.
  //    Solo la ruta vigente: mientras se recalcula, no queda la línea vieja.
  const result = useFreshRoute();
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const data = legsToGeoJSON(result?.route.legs ?? []);
      const src = map.getSource("route");
      if (src instanceof GeoJSONSource) {
        src.setData(data);
        return;
      }
      map.addSource("route", { type: "geojson", data });
      const color = [
        "match",
        ["get", "class"],
        ...Object.entries(LEG_CLASS_COLOR).flat(),
        "#a39a8f",
      ] as unknown as ExpressionSpecification;
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0b0a09", "line-width": 9 },
      });
      // Tramos evaluados: línea llena.
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        filter: ["!=", ["get", "class"], "unknown"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": color, "line-width": 5 },
      });
      // Tramos sin evaluar (falta DTM): punteada, para que no se lea como "ok".
      map.addLayer({
        id: "route-line-unknown",
        type: "line",
        source: "route",
        filter: ["==", ["get", "class"], "unknown"],
        paint: { "line-color": color, "line-width": 4, "line-dasharray": [1.5, 1.2] },
      });
    };
    whenReady(map, apply);
  }, [result]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

function legsToGeoJSON(legs: readonly RouteLeg[]): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: legs.map((l) => ({
      type: "Feature",
      properties: { class: l.class, from: l.from, to: l.to },
      geometry: { type: "LineString", coordinates: l.coordinates.map(([x, y]) => [x, y]) },
    })),
  };
}

function markerClass(kind: ReturnType<typeof waypointLabel>["kind"], open: boolean): string {
  const base =
    "grid size-7 cursor-grab place-items-center rounded-full border-2 text-xs font-bold shadow-lg active:cursor-grabbing";
  const tone =
    kind === "origin"
      ? "border-fg bg-ok text-bg"
      : kind === "destination"
        ? "border-fg bg-alert text-bg"
        : "border-fg bg-panel text-fg";
  return `${base} ${tone} ${open ? "ring-4 ring-rust" : ""}`;
}

