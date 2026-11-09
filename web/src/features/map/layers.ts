// The map layers people can choose, and everything known about who serves them.
//
// To add a layer: add a provider here, an option that uses it, a name in the
// translation files, and its domain to MAP_RASTER_ORIGINS (the page's CSP).
//
// Where the numbers come from (checked 2026-11-09, docs/THIRD_PARTY_DATA.md):
// tile size, zoom levels and formats are from each service's GetCapabilities.
// Two exceptions, on purpose:
//   - GetCapabilities gives no coverage for the IGN layers (its tile limits are
//     almost the whole world), so the bounds below are our own rectangles;
//   - EOX declares zoom 0..21 but the imagery is 10 m per pixel, which is zoom
//     14. Asking for more would only fetch the same pixels, larger.
import { readStored, STORAGE_KEYS, writeStored } from "../../lib/storage";

export type LayerId = "map" | "satellite" | "topo";
export type ProviderId = "pnoa" | "eox" | "mtn";

export interface RasterProvider {
  id: ProviderId;
  tiles: string[];
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  /** West, south, east, north. */
  bounds?: [number, number, number, number];
  attribution: string;
  terms: string;
}

const ignTile = (service: string, layer: string): string =>
  `https://www.ign.es/wmts/${service}?service=WMTS&request=GetTile&version=1.0.0&format=image/jpeg` +
  `&layer=${layer}&style=default&tilematrixset=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}`;

/** Everything Spain covers: mainland, Balearics, Canaries, Ceuta and Melilla. */
const SPAIN_BOUNDS: [number, number, number, number] = [-18.5, 27.4, 4.6, 44.1];

const EOX_YEAR = 2025;

export const PROVIDERS: Record<ProviderId, RasterProvider> = {
  pnoa: {
    id: "pnoa",
    tiles: [ignTile("pnoa-ma", "OI.OrthoimageCoverage")],
    tileSize: 256,
    minzoom: 0,
    // "Pregeneradas hasta el nivel 19", says the layer's own description.
    maxzoom: 19,
    bounds: SPAIN_BOUNDS,
    attribution: "PNOA cedido por © Instituto Geográfico Nacional",
    terms: "https://www.ign.es/web/ign/portal/qsm-cnig",
  },
  eox: {
    id: "eox",
    tiles: [`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 14,
    attribution: `EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${EOX_YEAR})`,
    terms: "https://cloudless.eox.at",
  },
  mtn: {
    id: "mtn",
    tiles: [ignTile("mapa-raster", "MTN")],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 20,
    bounds: SPAIN_BOUNDS,
    attribution: "Mapa topográfico cedido por © Instituto Geográfico Nacional",
    terms: "https://www.ign.es/web/ign/portal/qsm-cnig",
  },
};

export interface LayerOption {
  id: LayerId;
  /** Key under map.layers in the translation files. */
  nameKey: string;
  /** Roads and labels stay on top of the image. */
  hybrid: boolean;
}

export interface LayerConfig {
  satellite_enabled: boolean;
  satellite_global_fallback: boolean;
  topo_es_enabled: boolean;
}

export function layerOptions(config: LayerConfig): LayerOption[] {
  const options: LayerOption[] = [{ id: "map", nameKey: "map", hybrid: false }];
  if (config.satellite_enabled) options.push({ id: "satellite", nameKey: "satellite", hybrid: true });
  if (config.topo_es_enabled) options.push({ id: "topo", nameKey: "topo", hybrid: false });
  return options;
}

// --- Is a point in Spain? -----------------------------------------------------
// A plain outline, good to a few kilometres: it only decides which imagery to
// show. The mainland needs a shape because a rectangle would take in Portugal.

const MAINLAND: [number, number][] = [
  [-9.6, 43.0], [-9.4, 43.95], [-7.9, 44.0], [-3.5, 43.8], [-1.75, 43.45], [-1.4, 43.0],
  [-0.75, 42.95], [0.7, 42.85], [1.4, 42.45], [2.0, 42.35], [3.35, 42.45], [3.5, 41.8],
  [1.6, 41.0], [0.95, 40.4], [0.4, 39.2], [0.55, 38.6], [-0.4, 37.4], [-1.9, 36.6],
  [-3.5, 36.55], [-5.2, 35.95], [-6.5, 36.6], [-7.45, 37.15], [-7.45, 38.0], [-7.0, 38.2],
  [-7.3, 38.8], [-7.0, 39.6], [-6.85, 41.0], [-6.2, 41.6], [-6.6, 41.95], [-8.2, 41.85],
  [-8.9, 41.85],
];

const ISLANDS_AND_CITIES: [number, number, number, number][] = [
  [1.1, 38.5, 4.5, 40.2], // Balearics
  [-18.5, 27.4, -13.2, 29.6], // Canaries
  [-5.45, 35.85, -5.25, 35.95], // Ceuta
  [-3.0, 35.25, -2.9, 35.35], // Melilla
];

function insidePolygon(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isInSpain(lon: number, lat: number): boolean {
  return (
    insidePolygon(lon, lat, MAINLAND) ||
    ISLANDS_AND_CITIES.some(([west, south, east, north]) => lon >= west && lon <= east && lat >= south && lat <= north)
  );
}

/** Which imagery to show for a layer and a view; null if there is none here. */
export function providerFor(layer: LayerId, lon: number, lat: number, config: LayerConfig): ProviderId | null {
  if (layer === "map") return null;
  const spain = isInSpain(lon, lat);
  if (layer === "topo") return spain ? "mtn" : null;
  if (spain) return "pnoa";
  return config.satellite_global_fallback ? "eox" : null;
}

// --- Which of the style's own layers to hide ------------------------------------

export interface StyleLayerLike {
  id: string;
  type: string;
}

/** Our own layers start with this; the provider's never do. */
export const APP_LAYER_PREFIX = "sa-";

export function basemapLayersToHide(layers: StyleLayerLike[], hybrid: boolean): string[] {
  const covered = hybrid ? ["background", "fill", "fill-extrusion"] : ["background", "fill", "fill-extrusion", "line", "symbol"];
  return layers.filter((layer) => !layer.id.startsWith(APP_LAYER_PREFIX) && covered.includes(layer.type)).map((layer) => layer.id);
}

/** A raster goes under everything: before the first layer that is not raster imagery. */
export function firstLayerAbove(layers: StyleLayerLike[]): string | undefined {
  return layers.find((layer) => !layer.id.startsWith(`${APP_LAYER_PREFIX}raster-`))?.id;
}

// --- What the person chose ------------------------------------------------------
// One value for the whole page, so the small map and the main one agree. It
// stays in this browser: it is never sent to the server.

const listeners = new Set<() => void>();

function read(): LayerId {
  const stored = readStored(STORAGE_KEYS.mapLayer);
  return stored === "satellite" || stored === "topo" ? stored : "map";
}

let chosen: LayerId = read();

export const layerChoice = {
  get: (): LayerId => chosen,
  set(next: LayerId): void {
    if (next === chosen) return;
    chosen = next;
    writeStored(STORAGE_KEYS.mapLayer, next);
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Read the saved value again (a new page, or a test). */
  reload(): void {
    chosen = read();
  },
};
