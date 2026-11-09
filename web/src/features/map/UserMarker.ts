// The person's own position on the main map: a marker and a circle of doubt.
//
// It must never be mistaken for a place. Places are solid round discs that can
// be pressed. This is a target: a small dot inside a thick white ring with a
// dark edge, in a colour of its own, inside a larger halo. It is drawn under
// the pins and takes no clicks, so it can never get in the way of a place.
//
// The marker is HTML and survives a change of style by itself. The circle is a
// map layer, which a new style throws away: onStyleLoad() puts it back.
import * as maplibregl from "maplibre-gl";

import { motionDuration } from "../../lib/media";
import { circlePolygon } from "./geo";

const SOURCE = "sa-me-accuracy";
const FILL = "sa-me-accuracy-fill";
const LINE = "sa-me-accuracy-line";

const MIN_ZOOM = 16;
/** Worse than this, fit the view to the circle instead of zooming in on a guess. */
export const FIT_ABOVE_M = 500;
/** Worse than this, a circle would only cover the screen. */
export const NO_CIRCLE_ABOVE_M = 5000;
/** Worse than this it is a position from the IP address, or as good as. */
export const VERY_APPROXIMATE_ABOVE_M = 20_000;
/** The furthest out it will go for such a position: the region, not the continent. */
const VERY_APPROXIMATE_ZOOM = 10;
/** How far from the middle of the map still counts as "centred", in pixels. */
const CENTERED_PX = 24;

export interface MeReading {
  lat: number;
  lon: number;
  meters: number;
}

function circleData(reading: MeReading | null): GeoJSON.FeatureCollection {
  if (!reading || reading.meters <= 0 || reading.meters > NO_CIRCLE_ABOVE_M) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [circlePolygon(reading.lat, reading.lon, reading.meters)] },
      },
    ],
  };
}

export class UserMarker {
  private readonly map: maplibregl.Map;
  private marker: maplibregl.Marker | null = null;
  private element: HTMLElement | null = null;
  private reading: MeReading | null = null;
  private styleReady = false;
  // It starts true: turning on centres the map straight away.
  private centered = true;
  // Moving to the person: a position arriving meanwhile must not read as "moved away".
  private centering = false;
  private readonly listeners = new Set<() => void>();

  constructor(map: maplibregl.Map) {
    this.map = map;
    map.on("moveend", this.onMoveEnd);
  }

  destroy(): void {
    this.map.off("moveend", this.onMoveEnd);
    this.marker?.remove();
    this.marker = null;
    this.listeners.clear();
  }

  // --- For React (useSyncExternalStore) ----------------------------------------
  getCentered = (): boolean => this.centered;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setCentered(value: boolean): void {
    if (value === this.centered) return;
    this.centered = value;
    this.listeners.forEach((listener) => listener());
  }

  private readonly onMoveEnd = () => {
    this.centering = false;
    this.measure();
  };

  private measure(): void {
    if (!this.reading || this.centering) return;
    const here = this.map.project([this.reading.lon, this.reading.lat]);
    const middle = this.map.project(this.map.getCenter());
    this.setCentered(Math.hypot(here.x - middle.x, here.y - middle.y) <= CENTERED_PX);
  }

  // --- The drawing ---------------------------------------------------------------

  /** Call on every "style.load": a new style has none of our layers. */
  onStyleLoad(): void {
    this.styleReady = true;
    const map = this.map;
    if (map.getSource(SOURCE)) return;
    const css = getComputedStyle(document.documentElement);
    map.addSource(SOURCE, { type: "geojson", data: circleData(this.reading) });
    map.addLayer({
      id: FILL,
      type: "fill",
      source: SOURCE,
      paint: { "fill-color": css.getPropertyValue("--map-me").trim(), "fill-opacity": 0.14 },
    });
    map.addLayer({
      id: LINE,
      type: "line",
      source: SOURCE,
      paint: { "line-color": css.getPropertyValue("--map-me-accuracy").trim(), "line-width": 2 },
    });
  }

  private build(label: string): HTMLElement {
    const element = document.createElement("div");
    element.className = "map-me";
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", label);
    const halo = document.createElement("span");
    halo.className = "map-me__halo";
    const dot = document.createElement("span");
    dot.className = "map-me__dot";
    element.append(halo, dot);
    return element;
  }

  /** Show this position, or take everything away with null. */
  update(reading: MeReading | null, label: string): void {
    this.reading = reading;
    if (this.styleReady) (this.map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(circleData(reading));
    if (!reading) {
      this.marker?.remove();
      this.marker = null;
      this.element = null;
      this.setCentered(true);
      return;
    }
    if (!this.marker) {
      this.element = this.build(label);
      this.marker = new maplibregl.Marker({ element: this.element, anchor: "center" })
        .setLngLat([reading.lon, reading.lat])
        .addTo(this.map);
      // An image, not a control: not a stop for the Tab key.
      this.element.removeAttribute("tabindex");
      // Under the pins, which use 1 and 2.
      this.element.style.zIndex = "0";
      return; // the first drawing is followed by center(): nothing to measure yet
    }
    this.marker.setLngLat([reading.lon, reading.lat]);
    this.element?.setAttribute("aria-label", label);
    this.measure();
  }

  /** Bring the person into the middle of the view. */
  center(): void {
    const reading = this.reading;
    if (!reading) return;
    this.setCentered(true);
    this.centering = true;
    const map = this.map;
    const duration = motionDuration(400);
    if (reading.meters > VERY_APPROXIMATE_ABOVE_M) {
      map.easeTo({ center: [reading.lon, reading.lat], zoom: VERY_APPROXIMATE_ZOOM, duration });
      return;
    }
    if (reading.meters > FIT_ABOVE_M) {
      const ring = circlePolygon(reading.lat, reading.lon, reading.meters);
      const bounds = ring.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(ring[0], ring[0]));
      map.fitBounds(bounds, { padding: 48, maxZoom: MIN_ZOOM, duration });
      return;
    }
    map.easeTo({ center: [reading.lon, reading.lat], zoom: Math.max(map.getZoom(), MIN_ZOOM), duration });
  }
}
