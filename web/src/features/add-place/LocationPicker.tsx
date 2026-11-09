// A small map for placing a new place: tap to drop the pin, drag it to adjust.
// A circle shows how sure the GPS is. The other ways to set the location
// (current position, typing the coordinates) work without this map, so
// keyboard and screen-reader users never depend on it.
import "maplibre-gl/dist/maplibre-gl.css";

import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n/i18n";
import type { PublicConfig } from "../../lib/api";
import { motionDuration } from "../../lib/media";
import { useTheme } from "../../lib/theme";
import { styleUrlFor, type Camera } from "../map/MapView";
import { circlePolygon } from "../map/geo";
import { LayerControl } from "../map/LayerControl";
import { MapLayers } from "../map/MapLayers";
import { applyMapTokens } from "../map/mapTokens";

const ACCURACY_SOURCE = "sa-accuracy";
const ACCURACY_FILL = "sa-accuracy-fill";
const ACCURACY_LINE = "sa-accuracy-line";
const LOCATED_ZOOM = 16;

interface LocationPickerProps {
  config: PublicConfig;
  initialCamera: Camera;
  value: { lat: number; lon: number } | null;
  /** Metres of doubt, when the point came from the GPS. */
  accuracyM?: number | null;
  onPick: (lat: number, lon: number) => void;
}

function accuracyData(value: LocationPickerProps["value"], meters: number | null | undefined): GeoJSON.FeatureCollection {
  if (!value || !meters) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circlePolygon(value.lat, value.lon, meters)] } }],
  };
}

/** Our own layers on the map. Safe to call again: a new style starts empty. */
function addAppLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection): void {
  if (map.getSource(ACCURACY_SOURCE)) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const ring = css.getPropertyValue("--map-marker-ring").trim();
  map.addSource(ACCURACY_SOURCE, { type: "geojson", data });
  map.addLayer({ id: ACCURACY_FILL, type: "fill", source: ACCURACY_SOURCE, paint: { "fill-color": accent, "fill-opacity": 0.18 } });
  map.addLayer({
    id: ACCURACY_LINE,
    type: "line",
    source: ACCURACY_SOURCE,
    paint: { "line-color": ring || accent, "line-width": 2 },
  });
}

export function LocationPicker({ config, initialCamera, value, accuracyM, onPick }: LocationPickerProps) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  });
  const circleRef = useRef(accuracyData(value, accuracyM));
  const [layers, setLayers] = useState<MapLayers | null>(null);

  useEffect(() => {
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current!,
        style: styleUrlFor(config, theme),
        center: value ? [value.lon, value.lat] : [initialCamera.lon, initialCamera.lat],
        zoom: value ? Math.max(initialCamera.zoom, accuracyM ? LOCATED_ZOOM : 14) : initialCamera.zoom,
        attributionControl: false,
        locale: {
          "Map.Title": t("add.location.mapLabel"),
          "NavigationControl.ZoomIn": t("map.zoomIn"),
          "NavigationControl.ZoomOut": t("map.zoomOut"),
        },
        dragRotate: false,
      });
    } catch {
      return; // No WebGL: the coordinate fields still work.
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const osm = document.createElement("a");
    osm.href = t("map.osmAttributionLink");
    osm.textContent = t("map.osmAttribution");
    map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: osm.outerHTML }), "bottom-right");
    const mapLayers = new MapLayers(map, config);
    map.on("style.load", () => {
      applyMapTokens(map);
      addAppLayers(map, circleRef.current);
      mapLayers.onStyleLoad();
    });
    setLayers(mapLayers);
    map.on("click", (event) => onPickRef.current(event.lngLat.lat, event.lngLat.wrap().lng));
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(containerRef.current!);
    return () => {
      resize.disconnect();
      mapLayers.destroy();
      setLayers(null);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the chosen point; follow it if it was typed outside the view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    circleRef.current = accuracyData(value, accuracyM);
    (map.getSource(ACCURACY_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(circleRef.current);
    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const element = document.createElement("span");
      element.className = "map-pin map-pin--selected";
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", t("add.location.pinLabel"));
      const dot = document.createElement("span");
      dot.className = "map-pin__dot";
      element.append(dot);
      const marker = new maplibregl.Marker({ element, anchor: "center", draggable: true })
        .setLngLat([value.lon, value.lat])
        .addTo(map);
      marker.on("dragend", () => {
        const position = marker.getLngLat();
        onPickRef.current(position.lat, position.wrap().lng);
      });
      markerRef.current = marker;
    } else {
      markerRef.current.setLngLat([value.lon, value.lat]);
    }
    if (accuracyM) {
      map.easeTo({
        center: [value.lon, value.lat],
        zoom: Math.max(map.getZoom(), LOCATED_ZOOM),
        duration: motionDuration(300),
      });
    } else if (!map.getBounds().contains([value.lon, value.lat])) {
      map.easeTo({ center: [value.lon, value.lat], duration: motionDuration(300) });
    }
  }, [value?.lat, value?.lon, accuracyM, t]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="location-picker map-view">
      <div ref={containerRef} className="map-view__canvas" />
      {layers && <LayerControl layers={layers} />}
    </div>
  );
}
