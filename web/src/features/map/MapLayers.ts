// Switches a map between the plain map and raster imagery, without setStyle.
//
// Why not setStyle: it throws away every source and layer added after the
// style loaded, and reloads everything. Imagery is one extra layer at the very
// bottom; showing it is a matter of setting "visibility" on a few layers.
//
// What the provider sees: nothing at all until someone chooses the layer. The
// source is only added at that moment, so MapLibre cannot request a tile
// earlier. The choice itself stays in the browser (layers.ts).
//
// Theme changes do use setStyle (MapView), which starts from an empty style:
// so everything here is re-applied, safely, on every "style.load".
import type * as maplibregl from "maplibre-gl";

import { motionDuration } from "../../lib/media";
import { applyImageryTokens, applyMapTokens } from "./mapTokens";
import {
  APP_LAYER_PREFIX,
  basemapLayersToHide,
  firstLayerAbove,
  layerChoice,
  layerOptions,
  PROVIDERS,
  providerFor,
  type LayerConfig,
  type LayerId,
  type LayerOption,
  type ProviderId,
} from "./layers";

const rasterLayerId = (provider: ProviderId) => `${APP_LAYER_PREFIX}raster-${provider}`;
const sourceId = (provider: ProviderId) => `${APP_LAYER_PREFIX}raster-source-${provider}`;
const ERROR_NOTICE_MS = 60_000;

export interface MapLayersState {
  options: LayerOption[];
  selected: LayerId;
  /** The chosen layer has no imagery in this part of the world. */
  unavailable: boolean;
  /** Tiles are failing to load. */
  failed: boolean;
}

export class MapLayers {
  private readonly map: maplibregl.Map;
  private readonly config: LayerConfig;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  private styleReady = false;
  private hidden: string[] = [];
  private shownProvider: ProviderId | null = null;
  private lastErrorAt = -Infinity;
  private state: MapLayersState;

  constructor(map: maplibregl.Map, config: LayerConfig) {
    this.map = map;
    this.config = config;
    this.state = { options: layerOptions(config), selected: this.effectiveChoice(), unavailable: false, failed: false };
    this.unsubscribe = layerChoice.subscribe(() => this.apply());
    map.on("moveend", this.onMoveEnd);
    map.on("error", this.onError);
  }

  destroy(): void {
    this.unsubscribe();
    this.map.off("moveend", this.onMoveEnd);
    this.map.off("error", this.onError);
    this.listeners.clear();
  }

  // --- For React (useSyncExternalStore) ----------------------------------------
  getState = (): MapLayersState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(change: Partial<MapLayersState>): void {
    const next = { ...this.state, ...change };
    if ((Object.keys(next) as (keyof MapLayersState)[]).every((key) => next[key] === this.state[key])) return;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  choose(layer: LayerId): void {
    this.setState({ failed: false });
    this.lastErrorAt = -Infinity;
    layerChoice.set(layer);
    // The same layer again (after a failure) still has to be re-applied.
    this.apply();
  }

  // --- Applying the choice -------------------------------------------------------

  /** Call on every "style.load": a new style has none of what was added. */
  onStyleLoad(): void {
    this.styleReady = true;
    this.hidden = [];
    this.shownProvider = null;
    this.apply();
  }

  private readonly onMoveEnd = () => {
    if (this.effectiveChoice() !== "map") this.apply();
  };

  private readonly onError = (event: maplibregl.ErrorEvent & { sourceId?: string }) => {
    if (!event.sourceId?.startsWith(`${APP_LAYER_PREFIX}raster-`)) return;
    // Not more than one notice a minute, however many tiles fail.
    const now = performance.now();
    if (now - this.lastErrorAt < ERROR_NOTICE_MS) return;
    this.lastErrorAt = now;
    this.setState({ failed: true });
  };

  /** A saved choice the server no longer offers counts as the plain map. */
  private effectiveChoice(): LayerId {
    const choice = layerChoice.get();
    return layerOptions(this.config).some((option) => option.id === choice) ? choice : "map";
  }

  private apply(): void {
    const selected = this.effectiveChoice();
    if (!this.styleReady) {
      this.setState({ selected });
      return;
    }
    const center = this.map.getCenter();
    const provider = providerFor(selected, center.lng, center.lat, this.config);

    if (provider !== this.shownProvider) {
      this.show(provider, selected);
      this.shownProvider = provider;
    }
    this.setState({
      selected,
      unavailable: selected !== "map" && provider === null,
      ...(provider === null ? { failed: false } : {}),
    });
  }

  private show(provider: ProviderId | null, selected: LayerId): void {
    const map = this.map;
    if (provider) this.ensureRaster(provider);
    for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
      if (map.getLayer(rasterLayerId(id))) {
        map.setLayoutProperty(rasterLayerId(id), "visibility", id === provider ? "visible" : "none");
      }
    }

    for (const id of this.hidden) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
    }
    this.hidden = [];
    const option = layerOptions(this.config).find((candidate) => candidate.id === selected);
    if (provider && option) {
      this.hidden = basemapLayersToHide(map.getStyle().layers ?? [], option.hybrid);
      for (const id of this.hidden) map.setLayoutProperty(id, "visibility", "none");
    }

    applyMapTokens(map);
    if (provider) applyImageryTokens(map);

    // A CSS hook: pins need a stronger outline over a photograph.
    const holder = map.getContainer().closest<HTMLElement>(".map-view");
    if (holder) holder.dataset.imagery = provider ? "true" : "false";
  }

  private ensureRaster(provider: ProviderId): void {
    const map = this.map;
    const { tiles, tileSize, minzoom, maxzoom, bounds, attribution } = PROVIDERS[provider];
    if (!map.getSource(sourceId(provider))) {
      map.addSource(sourceId(provider), {
        type: "raster",
        tiles,
        tileSize,
        minzoom,
        maxzoom,
        attribution,
        ...(bounds ? { bounds } : {}),
      });
    }
    if (!map.getLayer(rasterLayerId(provider))) {
      map.addLayer(
        {
          id: rasterLayerId(provider),
          type: "raster",
          source: sourceId(provider),
          paint: { "raster-fade-duration": motionDuration(150) },
        },
        firstLayerAbove(map.getStyle().layers ?? []),
      );
    }
  }
}
