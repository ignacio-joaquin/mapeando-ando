import { useEffect, useRef } from "react";
import {
  Map as MapLibreMap,
  NavigationControl,
  GeoJSONSource,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import type { Feature, Polygon } from "geojson";
import { LAYERS, tileUrl } from "./layers";
import { useStore } from "../state/store";
import type { Bbox } from "../api/schemas";

/**
 * El mapa. La instancia de MapLibre es imperativa y mutable: vive en un ref,
 * se crea una vez y los efectos sincronizan store -> mapa. Nunca en useState.
 *
 * LIMITACIÓN CONOCIDA: MapLibre asume Web Mercator terrestre para el encuadre.
 * Las medidas que se le muestran al usuario (escala, distancias) NO salen de
 * MapLibre: salen de src/mars/geo.ts con el radio marciano. Servir los tiles en
 * la proyección del DTM (Equidistant Cylindrical) es trabajo del pipeline.
 */

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
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("mousemove", (e: MapMouseEvent) => setCursor({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    map.on("mouseout", () => setCursor(null));
    map.on("click", (e: MapMouseEvent) => setPicked({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
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
      }
      map.fitBounds(
        [
          [bbox.lon_min, bbox.lat_min],
          [bbox.lon_max, bbox.lat_max],
        ],
        { padding: 48, animate: false },
      );
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [bbox]);

  // 3. Sincronizar store -> capas. Se agregan solo las disponibles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      for (const spec of LAYERS) {
        const state = layers[spec.id];
        if (!state) continue;
        const existing = map.getLayer(spec.id);

        if (!state.available || spec.kind !== "raster") {
          if (existing) map.setLayoutProperty(spec.id, "visibility", "none");
          continue;
        }
        if (!existing) {
          if (!map.getSource(spec.id)) {
            map.addSource(spec.id, {
              type: "raster",
              tiles: [tileUrl(spec, siteId)],
              tileSize: 256,
            });
          }
          map.addLayer(
            { id: spec.id, type: "raster", source: spec.id, paint: { "raster-opacity": state.opacity } },
            "site-bbox-line",
          );
        }
        map.setLayoutProperty(spec.id, "visibility", state.visible ? "visible" : "none");
        map.setPaintProperty(spec.id, "raster-opacity", state.opacity);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [layers, siteId]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
