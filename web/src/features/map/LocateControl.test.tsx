import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as maplibregl from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnouncerProvider } from "../../components/Announcer";
import { I18nProvider, type Language } from "../../i18n/i18n";
import { LocateControl } from "./LocateControl";
import { FIT_ABOVE_M, NO_CIRCLE_ABOVE_M, UserMarker } from "./UserMarker";

vi.mock("maplibre-gl", () => {
  class Marker {
    element: HTMLElement;
    constructor({ element }: { element: HTMLElement }) {
      this.element = element;
    }
    setLngLat() {
      return this;
    }
    addTo() {
      this.element.setAttribute("tabindex", "0");
      document.body.append(this.element);
      return this;
    }
    remove() {
      this.element.remove();
    }
  }
  class LngLatBounds {
    extend() {
      return this;
    }
  }
  return { Marker, LngLatBounds };
});

/** The parts of a MapLibre map used here. Centre and pixels are 1:1 with degrees. */
class FakeMap {
  center = { lng: -3, lat: 40 };
  zoom = 12;
  sources = new Map<string, { data: GeoJSON.FeatureCollection; setData: (d: GeoJSON.FeatureCollection) => void }>();
  layers: string[] = [];
  handlers = new Map<string, Set<() => void>>();
  controls: { onAdd: (map: never) => HTMLElement; element?: HTMLElement }[] = [];
  easeTo = vi.fn((options: { center: [number, number]; zoom: number; duration: number }) => {
    this.center = { lng: options.center[0], lat: options.center[1] };
    this.zoom = options.zoom;
    this.fire("moveend");
  });
  fitBounds = vi.fn();

  on(name: string, handler: () => void) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
  }
  off(name: string, handler: () => void) {
    this.handlers.get(name)?.delete(handler);
  }
  fire(name: string) {
    this.handlers.get(name)?.forEach((handler) => handler());
  }
  getZoom = () => this.zoom;
  getCenter = () => this.center;
  project(point: [number, number] | { lng: number; lat: number }) {
    const [x, y] = Array.isArray(point) ? point : [point.lng, point.lat];
    return { x: x * 1000, y: y * 1000 };
  }
  getSource = (id: string) => this.sources.get(id);
  addSource(id: string, source: { data: GeoJSON.FeatureCollection }) {
    const stored = { data: source.data, setData: (data: GeoJSON.FeatureCollection) => (stored.data = data) };
    this.sources.set(id, stored);
  }
  addLayer(layer: { id: string }) {
    this.layers.push(layer.id);
  }
  addControl(control: FakeMap["controls"][number]) {
    this.controls.push(control);
    document.body.append(control.onAdd(this as never));
  }
  removeControl = vi.fn();
  /** A new style: what was added is gone. */
  newStyle() {
    this.sources.clear();
    this.layers = [];
  }
}

function stubGeolocation(state: PermissionState = "granted", accuracy = 8) {
  const clearWatch = vi.fn();
  const watchPosition = vi.fn((ok: PositionCallback) => {
    ok({ coords: { latitude: 41, longitude: -2, accuracy } } as GeolocationPosition);
    return 1;
  });
  vi.stubGlobal("navigator", {
    ...navigator,
    geolocation: { watchPosition, clearWatch },
    permissions: { query: vi.fn(async () => ({ state })) },
  });
  return { watchPosition, clearWatch };
}

function renderControl(language: Language = "es") {
  const map = new FakeMap();
  const marker = new UserMarker(map as unknown as maplibregl.Map);
  marker.onStyleLoad();
  const slot = document.createElement("div");
  document.body.append(slot);
  const view = render(
    <I18nProvider language={language}>
      <AnnouncerProvider>
        <LocateControl map={map as unknown as maplibregl.Map} marker={marker} statusSlot={slot} active locateMs={40} />
      </AnnouncerProvider>
    </I18nProvider>,
  );
  return { map, marker, slot, ...view };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const SHOW = "Mostrar mi ubicación";
const STOP = "Dejar de mostrar mi ubicación";
const CENTER = "Centrar en mi ubicación";
const me = () => document.querySelector<HTMLElement>(".map-me");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  window.localStorage.clear();
});

async function turnOn(u = userEvent.setup()) {
  await u.click(button(SHOW));
  await screen.findByRole("button", { name: STOP });
  return u;
}

describe("the button", () => {
  it("is a named button in the map's control area, off at first", () => {
    stubGeolocation();
    const { map } = renderControl();
    expect(map.controls).toHaveLength(1);
    expect(button(SHOW)).toHaveAttribute("aria-busy", "false");
    expect(me()).toBeNull();
  });

  it("is in English too", () => {
    stubGeolocation();
    renderControl("en");
    expect(button("Show my location")).toBeInTheDocument();
  });

  it("explains before asking, with a way out, and returns the focus", async () => {
    const { watchPosition } = stubGeolocation("prompt");
    renderControl();
    const u = userEvent.setup();
    await u.click(button(SHOW));
    const dialog = await screen.findByRole("dialog", { name: "Verte en el mapa" });
    expect(dialog).toHaveTextContent("Tu ubicación se usa solo en tu dispositivo");
    expect(dialog).toHaveTextContent("No se envía ni se guarda");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continuar" })).toHaveFocus());
    expect(watchPosition).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Ahora no" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button(SHOW)).toHaveFocus();
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it("Esc closes the explanation", async () => {
    stubGeolocation("prompt");
    renderControl();
    const u = userEvent.setup();
    await u.click(button(SHOW));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continuar" })).toHaveFocus());
    await u.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button(SHOW)).toHaveFocus();
  });

  it("accepting asks the browser, then shows the marker", async () => {
    const { watchPosition } = stubGeolocation("prompt");
    renderControl();
    const u = userEvent.setup();
    await u.click(button(SHOW));
    await u.click(await screen.findByRole("button", { name: "Continuar" }));
    await screen.findByRole("button", { name: STOP });
    expect(watchPosition).toHaveBeenCalled();
    expect(me()).toHaveAttribute("aria-label", "Tu ubicación, precisión ±8 m");
  });

  it("works from the keyboard", async () => {
    stubGeolocation();
    renderControl();
    const u = userEvent.setup();
    button(SHOW).focus();
    await u.keyboard("{Enter}");
    await screen.findByRole("button", { name: STOP });
    await u.keyboard(" ");
    await screen.findByRole("button", { name: SHOW });
  });

  it("is busy while searching, and a press changes nothing", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: { watchPosition: vi.fn(() => 1), clearWatch: vi.fn() },
      permissions: { query: vi.fn(async () => ({ state: "granted" })) },
    });
    renderControl();
    const u = userEvent.setup();
    await u.click(button(SHOW));
    const busy = await screen.findByRole("button", { name: "Buscando tu ubicación…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    await u.click(busy);
    expect(busy).toHaveAttribute("aria-busy", "true");
    // The window ends: never stuck in "searching".
    expect(await screen.findByRole("button", { name: SHOW })).toHaveAttribute("aria-busy", "false");
    expect(document.querySelector(".locate-notice")).toHaveTextContent(/no ha respondido/);
  });

  it("on and centred: a press turns it off and takes the marker away", async () => {
    stubGeolocation();
    renderControl();
    const u = await turnOn();
    expect(me()).not.toBeNull();
    await u.click(button(STOP));
    expect(button(SHOW)).toBeInTheDocument();
    expect(me()).toBeNull();
  });

  it("on and moved away: the label changes and a press centres", async () => {
    stubGeolocation();
    const { map } = renderControl();
    const u = await turnOn();
    act(() => {
      map.center = { lng: 5, lat: 45 };
      map.fire("moveend");
    });
    await u.click(button(CENTER));
    expect(map.easeTo).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("button", { name: STOP })).toBeInTheDocument();
    expect(me()).not.toBeNull();
  });

  it("announces what changes", async () => {
    stubGeolocation();
    renderControl();
    await turnOn();
    await waitFor(() =>
      expect(document.querySelector(".locate-live")).toHaveTextContent(`Ubicación encontrada, con una precisión de ±8 m. ${STOP}`),
    );
  });

  it("denied: explains how to recover, can be closed, and the button still works", async () => {
    stubGeolocation("denied");
    const { slot } = renderControl();
    const u = userEvent.setup();
    await u.click(button(SHOW));
    await waitFor(() => expect(slot).toHaveTextContent(/tiene bloqueado el acceso/));
    expect(slot).toHaveTextContent("abre los ajustes del sitio");
    expect(button(SHOW)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(slot).toBeEmptyDOMElement();
  });

  it("a rough position says so", async () => {
    stubGeolocation("granted", 1500);
    const { slot, map } = renderControl();
    await userEvent.click(button(SHOW));
    await screen.findByText("Ubicación aproximada (±1500 m).");
    expect(slot).toHaveTextContent("Ubicación aproximada");
    expect(map.fitBounds).toHaveBeenCalled();
  });
});

describe("the marker", () => {
  const setup = () => {
    const map = new FakeMap();
    const marker = new UserMarker(map as unknown as maplibregl.Map);
    marker.onStyleLoad();
    return { map, marker };
  };
  const reading = (meters: number) => ({ lat: 41, lon: -2, meters });
  const features = (map: FakeMap) => map.sources.get("sa-me-accuracy")!.data.features.length;

  it("is an image with a name, not a control, and takes no Tab stop", () => {
    const { marker } = setup();
    marker.update(reading(20), "Tu ubicación, precisión ±20 m");
    const element = me()!;
    expect(element).toHaveAttribute("role", "img");
    expect(element).toHaveAttribute("aria-label", "Tu ubicación, precisión ±20 m");
    expect(element).not.toHaveAttribute("tabindex");
    expect(element.tagName).not.toBe("BUTTON");
  });

  it("is drawn under the pins", () => {
    const { marker } = setup();
    marker.update(reading(20), "x");
    expect(Number(me()!.style.zIndex)).toBeLessThan(1);
  });

  it("zooms to at least 16 and keeps a closer zoom", () => {
    const { map, marker } = setup();
    marker.update(reading(20), "x");
    marker.center();
    expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 16, center: [-2, 41] }));
    map.zoom = 18;
    marker.center();
    expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: 18 }));
  });

  it("does not animate with reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    const { map, marker } = setup();
    marker.update(reading(20), "x");
    marker.center();
    expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 0 }));
  });

  it("fits the circle when the position is worse than 500 m", () => {
    const { map, marker } = setup();
    marker.update(reading(FIT_ABOVE_M), "x");
    marker.center();
    expect(map.easeTo).toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
    marker.update(reading(FIT_ABOVE_M + 1), "x");
    marker.center();
    expect(map.fitBounds).toHaveBeenCalled();
  });

  it("draws the circle only while it means something", () => {
    const { map, marker } = setup();
    marker.update(reading(30), "x");
    expect(features(map)).toBe(1);
    marker.update(reading(NO_CIRCLE_ABOVE_M + 1), "x");
    expect(features(map)).toBe(0);
  });

  it("gets its circle back after a new style, without repeating it", () => {
    const { map, marker } = setup();
    marker.update(reading(30), "x");
    marker.onStyleLoad();
    expect(map.layers.filter((id) => id.startsWith("sa-me-"))).toHaveLength(2);
    map.newStyle();
    marker.onStyleLoad();
    expect(features(map)).toBe(1);
    expect(map.layers).toEqual(["sa-me-accuracy-fill", "sa-me-accuracy-line"]);
  });

  it("the circle's layers are ones the layer switcher leaves alone", () => {
    const { map } = setup();
    expect(map.layers.every((id) => id.startsWith("sa-"))).toBe(true);
  });

  it("clearing removes the marker and empties the circle", () => {
    const { map, marker } = setup();
    marker.update(reading(30), "x");
    marker.update(null, "");
    expect(me()).toBeNull();
    expect(features(map)).toBe(0);
  });

  it("knows whether the map is still centred on the person", () => {
    const { map, marker } = setup();
    map.center = { lng: -2, lat: 41 };
    marker.update(reading(30), "x");
    marker.update(reading(30), "x");
    expect(marker.getCentered()).toBe(true);
    map.center = { lng: -1.9, lat: 41 };
    map.fire("moveend");
    expect(marker.getCentered()).toBe(false);
  });
});
