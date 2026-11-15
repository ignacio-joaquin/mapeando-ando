import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  GeoJSONSource,
  Popup,
  type ExpressionSpecification,
  type MapMouseEvent,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
// MapLibre 6 arma la URL del worker relativa a su propio módulo, en runtime: Vite no la
// ve y en el build el worker no se emite (404 → nginx devuelve index.html y el mapa no
// arranca). Con ?url Vite lo copia a assets/ y le pasamos la URL real.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import { geojsonUrl, LAYERS, RELIEF_DEM_ID, RELIEF_DEM_SOURCE, tileUrl } from "./layers";
import { readyTiles, terrainLayer, usesGeojson } from "./terrain";
import { TERRAIN_TRUE_SCALE } from "../mars/constants";
import { ProvenanceBadge } from "../components/ProvenanceBadge";
import { SHADOWS_LAYER_ID, SHADOWS_NIGHT_LAYER_ID, bandLayerId, frameAt, okBands } from "./sun";
import { useSun } from "../state/sun";
import { useStore } from "../state/store";
import type { Bbox, RouteLeg } from "../api/schemas";
import { useFreshRoute, usePlan } from "../state/plan";
import { LEG_CLASS_COLOR, waypointLabel } from "./route";
import { checkCoverage } from "./coverage";
import {
  addPinImages,
  PLACE_KINDS,
  PLACES_LAYER,
  PLACES_SELECTED_LAYER,
  PLACES_SOURCE,
  placesToGeoJSON,
} from "./places";
import { PlacePopup } from "../components/route/PlacePopup";

/**
 * El mapa. La instancia de MapLibre es imperativa y mutable: vive en un ref,
 * se crea una vez y los efectos sincronizan store -> mapa. Nunca en useState.
 *
 * LIMITACIÓN CONOCIDA: MapLibre asume Web Mercator terrestre para el encuadre.
 * Las medidas que se le muestran al usuario (escala, distancias) NO salen de
 * MapLibre: salen de src/mars/geo.ts con el radio marciano. Servir los tiles en
 * la proyección del DTM (Equidistant Cylindrical) es trabajo del pipeline.
 *
 * En 3D la misma limitación estira el terreno en horizontal R_Tierra / R_Marte;
 * el relieve se estira igual (TERRAIN_TRUE_SCALE) para que las pendientes se
 * vean como son.
 */

/** Inclinación de la cámara al pasar a 3D, y el tope. En 2D el tope es 0. */
const PITCH_3D = 55;
const MAX_PITCH_3D = 70;

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
      // Arranca en 2D: sin inclinar, para que la barra de escala valga en todo el mapa.
      maxPitch: 0,
      attributionControl: false,
    });
    // Primer listener de "load": los once("load") de los otros efectos corren
    // después y ya ven la bandera prendida.
    readyRef.current = false;
    map.on("load", () => {
      readyRef.current = true;
    });
    // Brújula: en 3D se puede girar, y tiene que haber cómo volver al norte.
    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.on("mousemove", (e: MapMouseEvent) => setCursor({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    map.on("mouseout", () => setCursor(null));
    map.on("mouseenter", PLACES_LAYER, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", PLACES_LAYER, () => (map.getCanvas().style.cursor = ""));
    // La barra de escala sigue al zoom real del mapa (y a la latitud del centro).
    const syncView = () =>
      useStore
        .getState()
        .setView({ zoom: map.getZoom(), lat: map.getCenter().lat, pitch: map.getPitch() });
    map.on("move", syncView);
    map.on("load", syncView);
    map.on("click", (e: MapMouseEvent) => {
      // Un pin de lugar le gana al clic en el mapa: abre su ficha y no suma un punto.
      const hit = map.getLayer(PLACES_LAYER)
        ? map.queryRenderedFeatures(e.point, { layers: [PLACES_LAYER] })[0]
        : undefined;
      const hitId = hit?.properties?.["id"];
      if (typeof hitId === "string") {
        useStore.getState().setSelectedPlace(hitId);
        return;
      }
      const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      // El modo se lee al momento del clic: el handler se registra una sola vez.
      const plan = usePlan.getState();
      if (plan.clickMode !== "add") {
        setPicked(p);
        return;
      }
      // Sin terreno de 1 m real no hay ruta que valga: se rechaza y se dice por qué.
      const check = checkCoverage(useStore.getState().coverage, p);
      if (check.kind === "outside") plan.setNotice(check.message);
      else plan.addPoint(p);
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

  // 2b. Contorno del terreno de 1 m (coverage.geojson). Sin esto, el usuario se
  //     entera de que un punto no sirve recién cuando el clic se rechaza. Línea
  //     continua clara, distinta del recuadro punteado del sitio; la leyenda
  //     está en el planificador (no se comunica solo por color).
  const coverage = useStore((s) => s.coverage);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const data: FeatureCollection<Polygon | MultiPolygon> = {
        type: "FeatureCollection",
        features: (coverage?.features ?? []).map((f) => ({
          type: "Feature",
          properties: {},
          geometry: f.geometry as Polygon | MultiPolygon,
        })),
      };
      const src = map.getSource("coverage");
      if (src instanceof GeoJSONSource) {
        src.setData(data);
        return;
      }
      map.addSource("coverage", { type: "geojson", data });
      map.addLayer(
        {
          id: "coverage-outline",
          type: "line",
          source: "coverage",
          paint: { "line-color": "#f2e8d5", "line-width": 1.5, "line-opacity": 0.85 },
        },
        // Debajo de la ruta, si ya está dibujada.
        map.getLayer("route-casing") ? "route-casing" : undefined,
      );
    };
    whenReady(map, apply);
  }, [coverage]);

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
        const geojson = !tiles && usesGeojson(spec, terrain) ? geojsonUrl(spec, siteId) : null;
        const usable = state.available && (tiles !== null || geojson !== null);

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

        // Vectoriales (curvas de nivel): tiles MVT. MapLibre pide solo los de
        // la vista, y ninguno mientras la capa está apagada. Si terrain.json dice
        // que la capa es un GeoJSON (corrida vieja, o el teselado falló), el GeoJSON
        // entero, y recién al prender la capa: en Gale pesa cientos de MB.
        if (spec.kind === "vector") {
          if (!existing) {
            if (tiles) {
              map.addSource(spec.id, {
                type: "vector",
                tiles: [tileUrl(spec, siteId)],
                minzoom: tiles.minzoom,
                maxzoom: tiles.maxzoom,
                bounds: tiles.bounds,
              });
            } else if (geojson && state.visible) {
              map.addSource(spec.id, { type: "geojson", data: geojson });
            } else {
              continue;
            }
            map.addLayer(
              {
                id: spec.id,
                type: "line",
                source: spec.id,
                // La capa del MVT la dice terrain.json; la de layers.ts es el respaldo.
                ...(tiles ? { "source-layer": tiles.layer ?? spec.sourceLayer ?? spec.id } : {}),
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

  // 3b. Relieve 3D. La fuente raster-dem se arma cuando terrain.json la trae lista
  //     (y se rearma si cambia el sitio o la corrida); el botón prende o apaga el
  //     terreno sobre ella. Sin relief-dem el mapa queda en 2D y el botón lo dice.
  const view3d = useStore((s) => s.view3d);
  const setView3d = useStore((s) => s.setView3d);
  const demTiles = readyTiles(terrain, RELIEF_DEM_ID);
  const demLayer = terrainLayer(terrain, RELIEF_DEM_ID);
  const demEncoding = demLayer?.encoding;
  const demReady = demTiles !== null && demEncoding !== undefined;
  const demKeyRef = useRef("");
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const key = `${siteId}|${terrain?.generated_at ?? ""}`;
    const apply = () => {
      if (map.getSource(RELIEF_DEM_ID) && (demKeyRef.current !== key || !demReady)) {
        map.setTerrain(null);
        map.removeSource(RELIEF_DEM_ID);
      }
      if (demTiles && demEncoding && !map.getSource(RELIEF_DEM_ID)) {
        map.addSource(RELIEF_DEM_ID, {
          type: "raster-dem",
          tiles: [`/tiles/${siteId}/${demTiles.template}`],
          tileSize: 256,
          minzoom: demTiles.minzoom,
          maxzoom: demTiles.maxzoom,
          bounds: demTiles.bounds,
          encoding: "custom",
          redFactor: demEncoding.red_factor,
          greenFactor: demEncoding.green_factor,
          blueFactor: demEncoding.blue_factor,
          baseShift: demEncoding.base_shift,
        });
        demKeyRef.current = key;
      }
      if (view3d && demReady) {
        map.setTerrain({ source: RELIEF_DEM_ID, exaggeration: TERRAIN_TRUE_SCALE });
        map.setMaxPitch(MAX_PITCH_3D);
        if (map.getPitch() < 10) map.easeTo({ pitch: PITCH_3D, duration: 700 });
      } else {
        map.setTerrain(null);
        // Tope 0: la cámara vuelve a mirar derecho hacia abajo y no se puede inclinar.
        map.setMaxPitch(0);
        if (map.getBearing() !== 0) map.easeTo({ bearing: 0, duration: 400 });
      }
    };
    whenReady(map, apply);
  }, [view3d, demReady, siteId, terrain]);

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
          if (!ll) return;
          const p = { lat: ll.lat, lon: ll.lng };
          const plan = usePlan.getState();
          if (checkCoverage(useStore.getState().coverage, p).kind === "outside") {
            // Vuelve a donde estaba: soltarlo afuera no mueve el punto.
            const prev = plan.waypoints.find((x) => x.id === w.id);
            if (prev) m?.setLngLat([prev.lon, prev.lat]);
            plan.setNotice("No se movió: ahí no hay terreno de 1 m real (DTM HiRISE).");
            return;
          }
          plan.movePoint(w.id, p);
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
      // Los pines quedan arriba de la ruta.
      if (map.getLayer(PLACES_SELECTED_LAYER)) map.moveLayer(PLACES_SELECTED_LAYER);
      if (map.getLayer(PLACES_LAYER)) map.moveLayer(PLACES_LAYER);
    };
    whenReady(map, apply);
  }, [result]);

  // 6. Pines de lugares (places.json), como en Google Maps. Los mismos lugares
  //    que el buscador; se filtran por tipo desde el panel de capas. Al
  //    superponerse queda el de mayor rango (IAU > muestras > objetivos > …).
  const places = useStore((s) => s.places);
  const placeKinds = useStore((s) => s.placeKinds);
  const selectedPlaceId = useStore((s) => s.selectedPlaceId);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const data = placesToGeoJSON(places?.places ?? []);
      const src = map.getSource(PLACES_SOURCE);
      if (src instanceof GeoJSONSource) {
        src.setData(data);
      } else {
        addPinImages(map);
        map.addSource(PLACES_SOURCE, { type: "geojson", data });
        // Anillo del lugar con la ficha abierta, debajo del pin.
        map.addLayer({
          id: PLACES_SELECTED_LAYER,
          type: "circle",
          source: PLACES_SOURCE,
          filter: ["==", ["get", "id"], ""],
          paint: {
            "circle-radius": 14,
            "circle-color": "rgba(224,122,74,0.25)",
            "circle-stroke-color": "#e07a4a",
            "circle-stroke-width": 3,
          },
        });
        map.addLayer({
          id: PLACES_LAYER,
          type: "symbol",
          source: PLACES_SOURCE,
          layout: {
            "icon-image": ["concat", "place-pin-", ["get", "kind"]],
            "icon-anchor": "bottom",
            "icon-allow-overlap": false,
            "icon-padding": 1,
            "symbol-sort-key": ["get", "rank"],
            // Nombres solo de cerca, y se caen antes que el pin si no entran.
            "text-field": ["step", ["zoom"], "", 14, ["get", "name"]],
            "text-font": ["Noto Sans Regular"],
            "text-size": 12,
            "text-anchor": "top",
            "text-offset": [0, 0.2],
            "text-optional": true,
            "text-max-width": 10,
          },
          paint: {
            "text-color": "#ece6de",
            "text-halo-color": "#0b0a09",
            "text-halo-width": 1.5,
          },
        });
      }
      const kinds = PLACE_KINDS.filter((k) => placeKinds[k]);
      map.setFilter(PLACES_LAYER, ["in", ["get", "kind"], ["literal", kinds]]);
      map.setFilter(PLACES_SELECTED_LAYER, ["==", ["get", "id"], selectedPlaceId ?? ""]);
      // La ruta va por debajo de los pines: si no, la línea los tapa.
      if (map.getLayer("route-casing")) map.moveLayer(PLACES_SELECTED_LAYER);
      if (map.getLayer("route-casing")) map.moveLayer(PLACES_LAYER);
    };
    whenReady(map, apply);
  }, [places, placeKinds, selectedPlaceId]);

  // 7. Ficha del pin tocado. El popup de MapLibre aloja un div y React dibuja
  //    adentro con un portal, así la ficha usa los mismos componentes que el panel.
  const [popupNode] = useState(() => document.createElement("div"));
  const popupRef = useRef<Popup | null>(null);
  const selectedPlace = places?.places.find((p) => p.id === selectedPlaceId) ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!selectedPlace) {
      popupRef.current?.remove();
      return;
    }
    let popup = popupRef.current;
    if (!popup) {
      popup = new Popup({
        closeButton: true,
        closeOnClick: false,
        maxWidth: "none",
        offset: [0, -30],
        // Sin foco automático: si no, el badge de procedencia abre su tooltip encima de la ficha.
        focusAfterOpen: false,
      })
        .setDOMContent(popupNode);
      // Cerrar con la cruz (o con Escape) limpia la selección.
      popup.on("close", () => {
        if (useStore.getState().selectedPlaceId) useStore.getState().setSelectedPlace(null);
      });
      popupRef.current = popup;
    }
    popup.setLngLat([selectedPlace.lon, selectedPlace.lat]);
    if (!popup.isOpen()) popup.addTo(map);
  }, [selectedPlace, popupNode]);
  // Al desmontar el mapa, el popup se va con él.
  useEffect(() => () => {
    popupRef.current?.remove();
    popupRef.current = null;
  }, []);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute right-3 bottom-3 flex flex-col items-end gap-1">
        <button
          type="button"
          aria-pressed={view3d && demReady}
          disabled={!demReady}
          onClick={() => setView3d(!view3d)}
          title={
            demReady
              ? "Relieve a escala real. Arrastrá con el botón derecho (o Ctrl + arrastrar) para girar e inclinar."
              : "El relieve 3D espera al pipeline (relief-dem en terrain.json)."
          }
          className="min-h-11 min-w-16 rounded border-2 border-fg/70 bg-bg/90 px-3 text-sm font-bold text-fg shadow-lg hover:bg-panel disabled:cursor-not-allowed disabled:border-line disabled:text-muted aria-pressed:border-rust aria-pressed:bg-rust/20"
        >
          {view3d && demReady ? "Ver en 2D" : "Ver en 3D"}
        </button>
        {!demReady ? (
          <span className="rounded bg-bg/85 px-1.5 py-0.5 text-[10px] text-muted">
            3D: esperando el pipeline
          </span>
        ) : view3d ? (
          <span className="flex items-center gap-1.5 rounded bg-bg/85 px-1.5 py-0.5 text-[10px] text-muted">
            relieve a escala real · ×{TERRAIN_TRUE_SCALE.toFixed(2)} por el radio
            <ProvenanceBadge
              source={{
                ...RELIEF_DEM_SOURCE,
                resolution: demLayer?.resolution ?? RELIEF_DEM_SOURCE.resolution,
                assumptions: [...(RELIEF_DEM_SOURCE.assumptions ?? []), ...(demLayer?.assumptions ?? [])],
              }}
              side="top"
            />
          </span>
        ) : null}
      </div>
      {selectedPlace
        ? createPortal(
            <PlacePopup place={selectedPlace} onClose={() => useStore.getState().setSelectedPlace(null)} />,
            popupNode,
          )
        : null}
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
    kind === "origin" || kind === "return"
      ? "border-fg bg-ok text-bg"
      : kind === "destination"
        ? "border-fg bg-alert text-bg"
        : "border-fg bg-panel text-fg";
  return `${base} ${tone} ${open ? "ring-4 ring-rust" : ""}`;
}

