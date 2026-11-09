import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { AnnouncerProvider } from "../../components/Announcer";
import { I18nProvider } from "../../i18n/i18n";
import sample from "./fixtures/sample-style.json";
import { LayerControl } from "./LayerControl";
import {
  basemapLayersToHide,
  firstLayerAbove,
  isInSpain,
  layerChoice,
  layerOptions,
  PROVIDERS,
  providerFor,
} from "./layers";
import { MapLayers } from "./MapLayers";

const ALL = { satellite_enabled: true, satellite_global_fallback: true, topo_es_enabled: true };

/** The parts of a MapLibre map that MapLayers touches. */
class FakeMap {
  center = { lng: -0.878, lat: 41.656 };
  layers: { id: string; type: string; layout: Record<string, string>; paint: Record<string, unknown> }[] = [];
  sources = new Map<string, Record<string, unknown>>();
  handlers = new Map<string, Set<(event: never) => void>>();
  added: string[] = [];
  holder = document.createElement("div");

  constructor(style = sample.layers) {
    this.holder.className = "map-view";
    this.load(style);
  }
  load(style: { id: string; type: string }[]) {
    this.layers = style.map((layer) => ({ ...layer, layout: {}, paint: {} }));
    this.sources.clear();
  }
  on(name: string, handler: (event: never) => void) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
  }
  off(name: string, handler: (event: never) => void) {
    this.handlers.get(name)?.delete(handler);
  }
  fire(name: string, event: unknown = {}) {
    this.handlers.get(name)?.forEach((handler) => handler(event as never));
  }
  getCenter = () => this.center;
  getStyle = () => ({ layers: this.layers });
  getContainer = () => this.holder;
  getSource = (id: string) => this.sources.get(id);
  getLayer = (id: string) => this.layers.find((layer) => layer.id === id);
  addSource(id: string, source: Record<string, unknown>) {
    this.added.push(id);
    this.sources.set(id, source);
  }
  addLayer(layer: { id: string; type: string }, before?: string) {
    const index = before ? this.layers.findIndex((l) => l.id === before) : this.layers.length;
    this.layers.splice(index, 0, { ...layer, layout: {}, paint: {} });
  }
  setLayoutProperty(id: string, key: string, value: string) {
    this.getLayer(id)!.layout[key] = value;
  }
  setPaintProperty(id: string, key: string, value: unknown) {
    this.getLayer(id)!.paint[key] = value;
  }
  visibility = (id: string) => this.getLayer(id)?.layout.visibility ?? "visible";
}

function controller(config = ALL, map = new FakeMap()) {
  const layers = new MapLayers(map as never, config);
  layers.onStyleLoad();
  return { map, layers };
}

beforeEach(() => {
  layerChoice.reload();
});

describe("the provider list", () => {
  it("has the tile address parts each service expects", () => {
    expect(PROVIDERS.pnoa.tiles[0]).toContain("www.ign.es/wmts/pnoa-ma");
    expect(PROVIDERS.pnoa.tiles[0]).toContain("layer=OI.OrthoimageCoverage");
    expect(PROVIDERS.pnoa.tiles[0]).toContain("tilematrixset=GoogleMapsCompatible");
    expect(PROVIDERS.pnoa.tiles[0]).toContain("TileMatrix={z}&TileRow={y}&TileCol={x}");
    expect(PROVIDERS.mtn.tiles[0]).toContain("layer=MTN");
    // EOX's order is z, then row (y), then column (x).
    expect(PROVIDERS.eox.tiles[0]).toMatch(/\/g\/\{z\}\/\{y\}\/\{x\}\.jpg$/);
  });

  it("uses https and 256 px tiles everywhere", () => {
    for (const provider of Object.values(PROVIDERS)) {
      expect(provider.tiles[0]).toMatch(/^https:\/\//);
      expect(provider.tileSize).toBe(256);
      expect(provider.maxzoom).toBeGreaterThan(provider.minzoom);
    }
  });

  it("gives each provider its exact attribution", () => {
    expect(PROVIDERS.pnoa.attribution).toBe("PNOA cedido por © Instituto Geográfico Nacional");
    expect(PROVIDERS.eox.attribution).toBe(
      "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)",
    );
    expect(PROVIDERS.mtn.attribution).toContain("Instituto Geográfico Nacional");
  });

  it("limits the IGN layers to the area around Spain", () => {
    expect(PROVIDERS.pnoa.bounds).toEqual([-18.5, 27.4, 4.6, 44.1]);
    expect(PROVIDERS.mtn.bounds).toEqual(PROVIDERS.pnoa.bounds);
    expect(PROVIDERS.eox.bounds).toBeUndefined();
  });

  it("offers only what the server has switched on", () => {
    expect(layerOptions({ ...ALL, satellite_enabled: false, topo_es_enabled: false }).map((o) => o.id)).toEqual(["map"]);
    expect(layerOptions({ ...ALL, topo_es_enabled: false }).map((o) => o.id)).toEqual(["map", "satellite"]);
    expect(layerOptions(ALL).map((o) => o.id)).toEqual(["map", "satellite", "topo"]);
  });
});

describe("is it Spain?", () => {
  it.each([
    ["Madrid", -3.7, 40.42],
    ["Bilbao", -2.93, 43.26],
    ["Sevilla", -5.98, 37.39],
    ["Barcelona", 2.17, 41.39],
    ["Palma", 2.65, 39.57],
    ["Las Palmas", -15.43, 28.12],
    ["Ceuta", -5.32, 35.89],
    ["Melilla", -2.94, 35.29],
  ])("%s is", (_name, lon, lat) => {
    expect(isInSpain(lon, lat)).toBe(true);
  });

  it.each([
    ["Lisboa", -9.14, 38.72],
    ["Porto", -8.61, 41.15],
    ["Bordeaux", -0.58, 44.84],
    ["Toulouse", 1.44, 43.6],
    ["Rabat", -6.84, 34.02],
    ["Mid-Atlantic", -30, 40],
  ])("%s is not", (_name, lon, lat) => {
    expect(isInSpain(lon, lat)).toBe(false);
  });
});

describe("which imagery", () => {
  it("is the IGN inside Spain and EOX only outside", () => {
    expect(providerFor("satellite", -3.7, 40.42, ALL)).toBe("pnoa");
    expect(providerFor("satellite", -9.14, 38.72, ALL)).toBe("eox");
  });

  it("is nothing outside Spain when the world-wide imagery is off", () => {
    expect(providerFor("satellite", -9.14, 38.72, { ...ALL, satellite_global_fallback: false })).toBeNull();
  });

  it("topographic exists only in Spain", () => {
    expect(providerFor("topo", -3.7, 40.42, ALL)).toBe("mtn");
    expect(providerFor("topo", -9.14, 38.72, ALL)).toBeNull();
  });

  it("the plain map needs none", () => {
    expect(providerFor("map", -3.7, 40.42, ALL)).toBeNull();
  });
});

describe("which of the style's layers to hide", () => {
  it("hybrid: only what the image replaces; roads and labels stay", () => {
    expect(basemapLayersToHide(sample.layers, true)).toEqual(["background", "water", "landuse_park", "building-3d"]);
  });

  it("a full map layer hides the roads and labels too", () => {
    const hidden = basemapLayersToHide(sample.layers, false);
    expect(hidden).toContain("highway_minor");
    expect(hidden).toContain("place_city");
  });

  it("never hides our own layers, even of the same type", () => {
    expect(basemapLayersToHide(sample.layers, false)).not.toContain("sa-accuracy-fill");
    expect(basemapLayersToHide(sample.layers, false)).not.toContain("sa-accuracy-line");
  });

  it("the image goes under everything, and under the other image too", () => {
    expect(firstLayerAbove(sample.layers)).toBe("background");
    expect(firstLayerAbove([{ id: "sa-raster-eox", type: "raster" }, ...sample.layers])).toBe("background");
  });
});

describe("switching layers", () => {
  it("adds nothing at all until a layer is chosen", () => {
    const { map } = controller();
    expect(map.added).toEqual([]);
  });

  it("puts the image at the bottom, hides the land, keeps roads and labels", () => {
    const { map, layers } = controller();
    layers.choose("satellite");
    expect(map.layers[0].id).toBe("sa-raster-pnoa");
    expect(map.visibility("background")).toBe("none");
    expect(map.visibility("water")).toBe("none");
    expect(map.visibility("highway_minor")).toBe("visible");
    expect(map.visibility("place_city")).toBe("visible");
    expect(map.visibility("sa-accuracy-fill")).toBe("visible");
    expect(map.holder.dataset.imagery).toBe("true");
  });

  it("going back shows the land again and keeps the source for next time", () => {
    const { map, layers } = controller();
    layers.choose("satellite");
    layers.choose("map");
    expect(map.visibility("background")).toBe("visible");
    expect(map.visibility("sa-raster-pnoa")).toBe("none");
    expect(map.holder.dataset.imagery).toBe("false");
    layers.choose("satellite");
    expect(map.added.filter((id) => id.includes("pnoa"))).toHaveLength(1);
  });

  it("alternating many times leaves the same layers as at the start", () => {
    const { map, layers } = controller();
    for (let i = 0; i < 5; i++) {
      layers.choose("satellite");
      layers.choose("map");
    }
    expect(map.layers.filter((layer) => layer.id.startsWith("sa-raster-")).map((l) => l.id)).toEqual(["sa-raster-pnoa"]);
    expect(map.visibility("water")).toBe("visible");
  });

  it("changes the imagery when the view leaves Spain, and back", () => {
    const { map, layers } = controller();
    layers.choose("satellite");
    map.center = { lng: -9.14, lat: 38.72 };
    map.fire("moveend");
    expect(map.visibility("sa-raster-pnoa")).toBe("none");
    expect(map.visibility("sa-raster-eox")).toBe("visible");
    const order = map.layers.map((layer) => layer.id);
    expect(order.indexOf("sa-raster-eox")).toBeLessThan(order.indexOf("background"));
    map.center = { lng: -3.7, lat: 40.42 };
    map.fire("moveend");
    expect(map.visibility("sa-raster-pnoa")).toBe("visible");
    expect(map.visibility("sa-raster-eox")).toBe("none");
  });

  it("never touches EOX inside Spain", () => {
    const { map, layers } = controller();
    layers.choose("satellite");
    map.fire("moveend");
    expect(map.added.some((id) => id.includes("eox"))).toBe(false);
  });

  it("says it is unavailable outside Spain and leaves the plain map showing", () => {
    const { map, layers } = controller({ ...ALL, satellite_global_fallback: false });
    layers.choose("satellite");
    map.center = { lng: -9.14, lat: 38.72 };
    map.fire("moveend");
    expect(layers.getState().unavailable).toBe(true);
    expect(map.visibility("background")).toBe("visible");
    expect(map.visibility("sa-raster-pnoa")).toBe("none");
  });

  it("a new style (change of theme) starts empty and gets the layer back", () => {
    const { map, layers } = controller();
    layers.choose("satellite");
    map.load(sample.layers);
    layers.onStyleLoad();
    expect(map.layers[0].id).toBe("sa-raster-pnoa");
    expect(map.visibility("background")).toBe("none");
  });

  it("applies a saved choice when the style arrives", () => {
    window.localStorage.setItem("sa.mapLayer", "satellite");
    layerChoice.reload();
    const { map } = controller();
    expect(map.layers[0].id).toBe("sa-raster-pnoa");
    window.localStorage.removeItem("sa.mapLayer");
    layerChoice.reload();
  });

  it("a saved layer the server no longer offers is the plain map", () => {
    window.localStorage.setItem("sa.mapLayer", "topo");
    layerChoice.reload();
    const { map, layers } = controller({ ...ALL, topo_es_enabled: false });
    expect(layers.getState().selected).toBe("map");
    expect(map.added).toEqual([]);
    window.localStorage.removeItem("sa.mapLayer");
    layerChoice.reload();
  });

  it("two maps on the page follow the same choice", () => {
    const a = controller();
    const b = controller();
    a.layers.choose("satellite");
    expect(b.map.layers[0].id).toBe("sa-raster-pnoa");
    a.layers.choose("map");
  });

  it("a tile error raises one notice, and not for other sources", () => {
    const { map, layers } = controller();
    layers.choose("satellite");
    map.fire("error", { sourceId: "openmaptiles" });
    expect(layers.getState().failed).toBe(false);
    map.fire("error", { sourceId: "sa-raster-source-pnoa" });
    expect(layers.getState().failed).toBe(true);
    layers.choose("map");
    expect(layers.getState().failed).toBe(false);
  });

  it("does not repeat the notice within the minute", () => {
    const { map, layers } = controller();
    layers.choose("satellite");
    let changes = 0;
    layers.subscribe(() => (changes += 1));
    map.fire("error", { sourceId: "sa-raster-source-pnoa" });
    map.fire("error", { sourceId: "sa-raster-source-pnoa" });
    map.fire("error", { sourceId: "sa-raster-source-pnoa" });
    expect(changes).toBe(1);
  });
});

describe("the selector", () => {
  function renderControl(config = ALL) {
    const { layers, map } = controller(config);
    render(
      <I18nProvider language="es">
        <AnnouncerProvider>
          <LayerControl layers={layers} />
        </AnnouncerProvider>
      </I18nProvider>,
    );
    return { layers, map };
  }

  const openIt = async (u: ReturnType<typeof userEvent.setup>) => {
    await u.click(screen.getByRole("button", { name: "Capas" }));
    return screen.findByRole("radiogroup", { name: "Capa del mapa" });
  };

  it("does not appear with nothing to choose", () => {
    renderControl({ ...ALL, satellite_enabled: false, topo_es_enabled: false });
    expect(screen.queryByRole("button", { name: "Capas" })).not.toBeInTheDocument();
  });

  it("opens as a group of radio buttons, with the current one checked and focused", async () => {
    const u = userEvent.setup();
    renderControl();
    expect(screen.getByRole("button", { name: "Capas" })).toHaveAttribute("aria-expanded", "false");
    await openIt(u);
    expect(screen.getByRole("button", { name: "Capas" })).toHaveAttribute("aria-expanded", "true");
    const mapa = screen.getByRole("radio", { name: "Mapa" });
    expect(mapa).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(mapa).toHaveFocus());
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("arrow keys move and choose, and the focus goes with them", async () => {
    const u = userEvent.setup();
    const { map } = renderControl();
    await openIt(u);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Mapa" })).toHaveFocus());
    await u.keyboard("{ArrowDown}");
    const satellite = screen.getByRole("radio", { name: "Satélite" });
    expect(satellite).toHaveAttribute("aria-checked", "true");
    expect(satellite).toHaveFocus();
    expect(map.layers[0].id).toBe("sa-raster-pnoa");
    await u.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Mapa" })).toHaveAttribute("aria-checked", "true");
  });

  it("wraps around at the ends", async () => {
    const u = userEvent.setup();
    renderControl();
    await openIt(u);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Mapa" })).toHaveFocus());
    await u.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Mapa topográfico" })).toHaveAttribute("aria-checked", "true");
  });

  it("Esc closes and gives the focus back to the button", async () => {
    const u = userEvent.setup();
    renderControl();
    await openIt(u);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Mapa" })).toHaveFocus());
    await u.keyboard("{Escape}");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capas" })).toHaveFocus();
  });

  it("clicking an option chooses it and closes", async () => {
    const u = userEvent.setup();
    const { map } = renderControl();
    await openIt(u);
    await u.click(screen.getByRole("radio", { name: "Satélite" }));
    expect(map.layers[0].id).toBe("sa-raster-pnoa");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("remembers the choice", async () => {
    const u = userEvent.setup();
    renderControl();
    await openIt(u);
    await u.click(screen.getByRole("radio", { name: "Satélite" }));
    expect(window.localStorage.getItem("sa.mapLayer")).toBe("satellite");
  });

  it("works when the browser refuses to save", async () => {
    const u = userEvent.setup();
    const { map } = renderControl();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      await openIt(u);
      await u.click(screen.getByRole("radio", { name: "Satélite" }));
      expect(map.layers[0].id).toBe("sa-raster-pnoa");
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it("says when there is no imagery here", async () => {
    const u = userEvent.setup();
    const { map, layers } = renderControl({ ...ALL, satellite_global_fallback: false });
    await openIt(u);
    await u.click(screen.getByRole("radio", { name: "Satélite" }));
    map.center = { lng: -9.14, lat: 38.72 };
    act(() => map.fire("moveend"));
    expect(await screen.findByText("Satélite no disponible en esta zona")).toBeInTheDocument();
    act(() => layers.choose("map"));
  });

  it("offers a way back when tiles fail", async () => {
    const u = userEvent.setup();
    const { map, layers } = renderControl();
    await openIt(u);
    await u.click(screen.getByRole("radio", { name: "Satélite" }));
    act(() => map.fire("error", { sourceId: "sa-raster-source-pnoa" }));
    await u.click(await screen.findByRole("button", { name: "Volver al mapa" }));
    expect(layers.getState().selected).toBe("map");
    expect(map.visibility("background")).toBe("visible");
  });
});
