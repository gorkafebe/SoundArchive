// The map: MapLibre with the basemap style from /api/config, and the places
// of the visible area as clustered pins.
//
// Data flow: the map stops moving ("moveend") -> wait 250 ms (more movement
// restarts the wait) -> cancel the previous request -> ask the API for the
// places in the visible rectangle -> group them (clusters.ts) -> draw them as
// buttons (markers.ts).
//
// Keyboard: the map itself is focusable (MapLibre: arrow keys move it, + and
// - zoom), and every pin and cluster is a button that Tab reaches.
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";

import * as maplibregl from "maplibre-gl";
// MapLibre runs its heavy work in a background "worker" script. ?url makes
// Vite copy that file into the build and give us its address.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type Supercluster from "supercluster";

import { useAnnounce } from "../../components/Announcer";
import { useI18n } from "../../i18n/i18n";
import { getPlacesInArea, isAbort, type PublicConfig } from "../../lib/api";
import { motionDuration } from "../../lib/media";
import { useTheme } from "../../lib/theme";
import { buildIndex, clustersFor, type PlaceProps } from "./clusters";
import { boundsToBbox } from "./geo";
import { LayerControl } from "./LayerControl";
import { MapLayers } from "./MapLayers";
import { applyMapTokens } from "./mapTokens";
import { MarkerLayer, type MarkerLabels } from "./markers";

maplibregl.setWorkerUrl(workerUrl);

export interface Camera {
  lon: number;
  lat: number;
  zoom: number;
}

export interface MapViewHandle {
  /** Focus a place's pin; falls back to the map itself. */
  focusPlace: (id: string) => void;
  centerOn: (lon: number, lat: number, zoom?: number) => void;
}

interface MapViewProps {
  config: PublicConfig;
  initialCamera: Camera;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCameraChange: (camera: Camera) => void;
  /** Change it to reload the places (e.g. after one was created). */
  reloadKey: number;
  ref?: Ref<MapViewHandle>;
}

type Status =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; count: number; truncated: boolean };

const LOAD_DELAY_MS = 250;

/** Relative style URLs (a local test style) are resolved against this site. */
export function styleUrlFor(config: PublicConfig, theme: "light" | "dark"): string {
  const url = theme === "dark" ? config.map_style_url_dark : config.map_style_url;
  return new URL(url, window.location.href).href;
}

export function MapView({ config, initialCamera, selectedId, onSelect, onCameraChange, reloadKey, ref }: MapViewProps) {
  const { t, formatNumber } = useI18n();
  const { theme } = useTheme();
  const announce = useAnnounce();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const layerRef = useRef<MarkerLayer | null>(null);
  const indexRef = useRef<Supercluster<PlaceProps> | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [mapError, setMapError] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const [layers, setLayers] = useState<MapLayers | null>(null);

  // Latest callbacks and texts, read from MapLibre's event handlers without
  // re-creating the map each time they change.
  const latest = useRef({ onSelect, onCameraChange, t, announce, formatNumber });
  useEffect(() => {
    latest.current = { onSelect, onCameraChange, t, announce, formatNumber };
  });

  const labels = (): MarkerLabels => ({
    place: (name, selected) => (selected ? latest.current.t("map.pinSelected", { name }) : name),
    cluster: (count) => latest.current.t("map.cluster", { count }),
  });

  // --- Create the map once --------------------------------------------------
  useEffect(() => {
    const container = containerRef.current!;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: styleUrlFor(config, theme),
        center: [initialCamera.lon, initialCamera.lat],
        zoom: initialCamera.zoom,
        // Our own attribution control below, never collapsed into an icon.
        attributionControl: false,
        // The canvas gets this as its accessible name.
        locale: {
          "Map.Title": t("map.canvasLabel"),
          "NavigationControl.ZoomIn": t("map.zoomIn"),
          "NavigationControl.ZoomOut": t("map.zoomOut"),
          "NavigationControl.ResetBearing": t("map.resetBearing"),
          "AttributionControl.ToggleAttribution": t("map.toggleAttribution"),
        },
        dragRotate: false, // a rotated map confuses more than it helps here
        pitchWithRotate: false,
      });
    } catch {
      // No WebGL (very old device, or disabled): the list still works.
      // Reporting a failure of the external map library is what this effect is for.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMapError(true);
      return;
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // compact: false = the full text is always shown, never folded into an
    // icon. The OpenStreetMap credit is added here, not left to the style, so
    // it is there whatever basemap provider the configuration points to.
    const osm = document.createElement("a");
    osm.href = t("map.osmAttributionLink");
    osm.textContent = t("map.osmAttribution");
    map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: osm.outerHTML }),
      "bottom-right",
    );

    let styleLoaded = false;
    map.on("load", () => {
      styleLoaded = true;
    });
    // On every style, also after a change of theme.
    const mapLayers = new MapLayers(map, config);
    map.on("style.load", () => {
      applyMapTokens(map);
      mapLayers.onStyleLoad();
    });
    setLayers(mapLayers);
    map.on("error", (event: maplibregl.ErrorEvent) => {
      // An error before the style has loaded means no basemap at all. Later
      // errors are usually a single missing tile, which is harmless.
      if (!styleLoaded) setMapError(true);
      console.warn("Map error:", event.error?.message ?? event);
    });

    const layer = new MarkerLayer(
      map,
      {
        onPlace: (id) => latest.current.onSelect(id),
        onCluster: (clusterId, lon, lat) => {
          const index = indexRef.current;
          if (!index) return;
          const zoom = Math.min(index.getClusterExpansionZoom(clusterId), 18);
          map.easeTo({ center: [lon, lat], zoom, duration: motionDuration(400) });
          // The cluster button disappears; keep the focus on the map.
          map.getCanvas().focus();
        },
      },
      labels(),
    );
    layerRef.current = layer;

    const onMoveEnd = () => {
      const c = map.getCenter();
      latest.current.onCameraChange({ lon: c.lng, lat: c.lat, zoom: map.getZoom() });
      redraw();
      setLoadTick((n) => n + 1);
    };
    map.on("moveend", onMoveEnd);

    // The panel next to the map opens and closes: tell MapLibre its box changed.
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container);

    return () => {
      resize.disconnect();
      layer.destroy();
      mapLayers.destroy();
      setLayers(null);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // Created once; later changes (theme, language) are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function currentBbox(map: maplibregl.Map) {
    const b = map.getBounds();
    return boundsToBbox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
  }

  function redraw() {
    const map = mapRef.current;
    const index = indexRef.current;
    if (!map || !layerRef.current || !index) return;
    layerRef.current.update(clustersFor(index, currentBbox(map), map.getZoom()));
  }

  // --- Load the places of the visible area (debounced, cancellable) --------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus({ kind: "loading" });
      getPlacesInArea(currentBbox(map), controller.signal)
        .then((collection) => {
          indexRef.current = buildIndex(collection.features);
          redraw();
          const count = collection.features.length;
          setStatus({ kind: "ready", count, truncated: collection.truncated });
          const { t: tr, announce: say } = latest.current;
          say(count === 0 ? tr("map.status.empty") : tr("map.status.count", { count }));
        })
        .catch((error) => {
          if (isAbort(error)) return;
          setStatus({ kind: "error" });
          latest.current.announce(latest.current.t("map.status.error"));
        });
    }, LOAD_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort(); // a newer movement replaces this request
    };
    // redraw only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTick, reloadKey]);

  // --- Theme: swap the basemap style; the pins are HTML and stay ------------
  const firstStyle = useRef(true);
  useEffect(() => {
    if (firstStyle.current) {
      firstStyle.current = false;
      return;
    }
    mapRef.current?.setStyle(styleUrlFor(config, theme));
  }, [theme, config]);

  // --- Language: MapLibre's texts and the pins' names -----------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().setAttribute("aria-label", t("map.canvasLabel"));
    const set = (selector: string, text: string) => {
      const button = map.getContainer().querySelector(selector);
      button?.setAttribute("aria-label", text);
      button?.setAttribute("title", text);
    };
    set(".maplibregl-ctrl-zoom-in", t("map.zoomIn"));
    set(".maplibregl-ctrl-zoom-out", t("map.zoomOut"));
    layerRef.current?.setLabels(labels());
  }, [t]);

  useEffect(() => {
    layerRef.current?.setSelected(selectedId);
    if (!selectedId) return;
    // The panel opening narrows the map. If that pushes the selected pin out
    // of view, bring it back, so the selection never disappears.
    const position = layerRef.current?.positionOf(selectedId);
    const timer = window.setTimeout(() => {
      const map = mapRef.current;
      if (map && position && !map.getBounds().contains(position)) {
        map.easeTo({ center: position, duration: motionDuration(300) });
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [selectedId]);

  useImperativeHandle(ref, () => ({
    focusPlace: (id) => {
      if (!layerRef.current?.focusPlace(id)) mapRef.current?.getCanvas().focus();
    },
    centerOn: (lon, lat, zoom) => {
      mapRef.current?.easeTo({
        center: [lon, lat],
        zoom: zoom ?? Math.max(mapRef.current.getZoom(), 14),
        duration: motionDuration(400),
      });
    },
  }));

  return (
    <section className="map-view" aria-label={t("map.label")}>
      <div ref={containerRef} className="map-view__canvas" />
      {layers && <LayerControl layers={layers} />}
      <div className="map-view__status">
        {mapError && <p className="map-status map-status--error">{t("map.styleError")}</p>}
        {status.kind === "loading" && <p className="map-status">{t("map.status.loading")}</p>}
        {status.kind === "error" && (
          <p className="map-status map-status--error">
            {t("map.status.error")}{" "}
            <button type="button" className="sa-btn" onClick={() => setLoadTick((n) => n + 1)}>
              {t("common.retry")}
            </button>
          </p>
        )}
        {status.kind === "ready" && (
          <p className="map-status">
            {status.count === 0 ? t("map.status.empty") : t("map.status.count", { count: status.count })}
            {status.truncated && <> {t("map.status.truncated")}</>}
          </p>
        )}
      </div>
    </section>
  );
}
