// A small map for choosing where a new place is: tap or click to drop the
// pin. It is one of three ways to set the location; the other two (typing
// the coordinates, "use my location") work without it, so keyboard and
// screen-reader users never depend on this map.
import "maplibre-gl/dist/maplibre-gl.css";

import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";

import { useI18n } from "../../i18n/i18n";
import type { PublicConfig } from "../../lib/api";
import { motionDuration } from "../../lib/media";
import { useTheme } from "../../lib/theme";
import { styleUrlFor, type Camera } from "../map/MapView";

interface LocationPickerProps {
  config: PublicConfig;
  initialCamera: Camera;
  value: { lat: number; lon: number } | null;
  onPick: (lat: number, lon: number) => void;
}

export function LocationPicker({ config, initialCamera, value, onPick }: LocationPickerProps) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  });

  useEffect(() => {
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current!,
        style: styleUrlFor(config, theme),
        center: value ? [value.lon, value.lat] : [initialCamera.lon, initialCamera.lat],
        zoom: value ? Math.max(initialCamera.zoom, 14) : initialCamera.zoom,
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
    map.on("click", (event) => onPickRef.current(event.lngLat.lat, event.lngLat.wrap().lng));
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(containerRef.current!);
    return () => {
      resize.disconnect();
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
      markerRef.current = new maplibregl.Marker({ element, anchor: "center" }).setLngLat([value.lon, value.lat]).addTo(map);
    } else {
      markerRef.current.setLngLat([value.lon, value.lat]);
    }
    if (!map.getBounds().contains([value.lon, value.lat])) {
      map.easeTo({ center: [value.lon, value.lat], duration: motionDuration(300) });
    }
  }, [value, t]);

  return <div ref={containerRef} className="location-picker map-view" />;
}
