import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnouncerProvider } from "../../components/Announcer";
import { I18nProvider, type Language } from "../../i18n/i18n";
import type { ExternalSuggestion, NearbyPlace } from "../../lib/api";
import { ThemeProvider } from "../../lib/theme";
import { CONFIG, json, makePlace, mockFetch } from "../../test/fakeApi";
import { AddPlaceFlow } from "./AddPlaceFlow";
import { parseCoordinate } from "./validation";

// The small map needs WebGL; a button stands in for "tap the map here".
vi.mock("./LocationPicker", () => ({
  LocationPicker: ({ onPick, accuracyM }: { onPick: (lat: number, lon: number) => void; accuracyM?: number | null }) => (
    <button type="button" data-accuracy={accuracyM ?? ""} onClick={() => onPick(43.263, -2.935)}>
      tap map
    </button>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const NEARBY: NearbyPlace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fuente de la plaza",
  latitude: 43.2631,
  longitude: -2.9351,
  distance_m: 12.4,
  recording_count: 3,
};

const SITE: ExternalSuggestion = {
  external_source: "osm",
  external_id: "node/1001",
  name: "Panadería Paco",
  category: "bakery",
  latitude: 43.2632,
  longitude: -2.935,
  distance_m: 20,
};

function renderFlow({ writes = true, language = "es" as Language, config = {} } = {}) {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  const onOpenExisting = vi.fn();
  render(
    <I18nProvider language={language}>
      <ThemeProvider>
        <AnnouncerProvider>
          <AddPlaceFlow
            config={{ ...CONFIG, writes_enabled: writes, ...config }}
            initialCamera={{ lon: -3.7, lat: 40.2, zoom: 5 }}
            onCancel={onCancel}
            onCreated={onCreated}
            onOpenExisting={onOpenExisting}
            locateMs={30}
          />
        </AnnouncerProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
  return { onCreated, onCancel, onOpenExisting };
}

/** A server with these neighbours; create() decides the answer to the POST. */
function server({
  existing = [] as NearbyPlace[],
  external = [] as ExternalSuggestion[],
  create,
  suggestFails = false,
}: {
  existing?: NearbyPlace[];
  external?: ExternalSuggestion[];
  create?: (body: Record<string, unknown>) => Response;
  suggestFails?: boolean;
} = {}) {
  return mockFetch(async (url, init) => {
    if (url.pathname === "/api/places/suggest") {
      if (suggestFails) return json({}, 500);
      return json({ existing, external, external_available: true, attribution: "© OpenStreetMap contributors", radius_m: 50 });
    }
    const body = JSON.parse(String(init!.body));
    return create ? create(body) : json(makePlace(9, body), 201);
  });
}

const posted = (fetch: ReturnType<typeof server>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
const suggestCalls = (fetch: ReturnType<typeof server>) =>
  fetch.mock.calls.map(([url]) => new URL(String(url), "http://localhost")).filter((url) => url.pathname.endsWith("/suggest"));

const user = () => userEvent.setup();
const NEXT = { name: "Siguiente" };

/** Advanced fields, the keyboard way, then on to the next step. */
async function typeLocation(u: ReturnType<typeof user>, lat = "43,2630", lon = "-2,9350") {
  await u.click(screen.getByText("Avanzado: escribir coordenadas"));
  await u.type(screen.getByLabelText("Latitud"), lat);
  await u.type(screen.getByLabelText("Longitud"), lon);
  await u.click(screen.getByRole("button", NEXT));
}

function stubGeolocation(readings: { accuracy: number; latitude?: number; longitude?: number }[], state = "prompt") {
  const clearWatch = vi.fn();
  const watchPosition = vi.fn((ok: PositionCallback, _fail?: PositionErrorCallback, _options?: PositionOptions) => {
    void _fail;
    void _options;
    for (const reading of readings) {
      ok({ coords: { latitude: 41.387, longitude: 2.17, ...reading } } as GeolocationPosition);
    }
    return 7;
  });
  vi.stubGlobal("navigator", {
    ...navigator,
    geolocation: { watchPosition, clearWatch },
    permissions: { query: vi.fn(async () => ({ state })) },
  });
  return { watchPosition, clearWatch };
}

describe("parseCoordinate", () => {
  it("reads what people type", () => {
    expect(parseCoordinate("43,2630")).toBe(43.263);
    expect(parseCoordinate(" -2.935 ")).toBe(-2.935);
    expect(parseCoordinate("−2,5")).toBe(-2.5); // typographic minus
    expect(parseCoordinate("4 3")).toBe(43);
    expect(parseCoordinate("43,26,1")).toBeNull();
    expect(parseCoordinate("north")).toBeNull();
    expect(parseCoordinate("1e3")).toBeNull();
  });
});

describe("where the place is", () => {
  it("starts on the first step with the focus on its heading", async () => {
    server();
    renderFlow();
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("Paso 1 de 3: Ubicación");
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("puts the current location first, as the recommended way", () => {
    server();
    renderFlow();
    const [first, second] = screen.getAllByRole("button");
    expect(first).toHaveAccessibleName(/^Usar mi ubicación actual Recomendado/);
    expect(first).toHaveClass("sa-btn--primary");
    expect(second).toHaveAccessibleName("Elegir en el mapa");
  });

  it("explains before asking, and does not ask until the tap", () => {
    const { watchPosition } = stubGeolocation([{ accuracy: 8 }]);
    server();
    renderFlow();
    expect(screen.getByText(/Tu navegador te pedirá permiso/)).toBeVisible();
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it("keeps the coordinates folded away under Advanced", () => {
    server();
    renderFlow();
    const details = screen.getByText("Avanzado: escribir coordenadas").closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByLabelText("Latitud")).toBeInTheDocument();
  });

  it("opens Advanced to show the errors and focuses the first wrong field", async () => {
    const u = user();
    server();
    renderFlow();
    await u.click(screen.getByRole("button", NEXT));
    const lat = screen.getByLabelText("Latitud");
    expect(screen.getByText("Avanzado: escribir coordenadas").closest("details")!.open).toBe(true);
    expect(lat).toHaveAttribute("aria-invalid", "true");
    expect(lat).toHaveAccessibleDescription(/Escribe la latitud o elige un punto en el mapa/);
    expect(screen.getByText("Hay 2 campos que revisar.")).toBeInTheDocument();
    await waitFor(() => expect(lat).toHaveFocus());
  });

  it("rejects numbers out of range and text that is not a number", async () => {
    const u = user();
    server();
    renderFlow();
    await typeLocation(u, "91", "abc");
    expect(screen.getByLabelText("Latitud")).toHaveAccessibleDescription(/entre −90 y 90/);
    expect(screen.getByLabelText("Longitud")).toHaveAccessibleDescription(/debe ser un número/);
  });

  it("shows the map when asked and fills the point when tapped", async () => {
    const u = user();
    server();
    renderFlow();
    expect(screen.queryByRole("button", { name: "tap map" })).not.toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Elegir en el mapa" }));
    await u.click(screen.getByRole("button", { name: "tap map" }));
    expect(screen.getByLabelText("Latitud")).toHaveValue("43,263000");
    expect(screen.getByLabelText("Longitud")).toHaveValue("-2,935000");
    expect(screen.getByText(/Punto elegido: 43,26300° N, 2,93500° O/)).toBeInTheDocument();
  });

  it("keeps the most precise reading, shows it and stops the GPS", async () => {
    const u = user();
    const { watchPosition, clearWatch } = stubGeolocation([
      { accuracy: 60, latitude: 41 },
      { accuracy: 8.4, latitude: 41.5 },
      { accuracy: 30, latitude: 42 },
    ]);
    server();
    renderFlow({ language: "en" });
    await u.click(screen.getByRole("button", { name: /Use my current location/ }));
    expect(await screen.findByText("Accuracy: ±8 m")).toBeInTheDocument();
    expect(screen.getByLabelText("Latitude")).toHaveValue("41.500000");
    expect(watchPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
    expect(clearWatch).toHaveBeenCalledWith(7);
  });

  it("warns when the position is rough, and offers the marker", async () => {
    const u = user();
    stubGeolocation([{ accuracy: 240 }]);
    server();
    renderFlow();
    await u.click(screen.getByRole("button", { name: /Usar mi ubicación actual/ }));
    expect(await screen.findByText(/La ubicación es aproximada; puedes mover el marcador/)).toBeInTheDocument();
    expect(screen.getByText("Precisión: ±240 m")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "tap map" })).toHaveAttribute("data-accuracy", "240");
  });

  it("a point placed by hand has no GPS doubt attached", async () => {
    const u = user();
    stubGeolocation([{ accuracy: 240 }]);
    const fetch = server();
    renderFlow();
    await u.click(screen.getByRole("button", { name: /Usar mi ubicación actual/ }));
    const map = await screen.findByRole("button", { name: "tap map" });
    await screen.findByText("Precisión: ±240 m");
    await u.click(map);
    expect(screen.queryByText(/La ubicación es aproximada/)).not.toBeInTheDocument();
    await u.click(screen.getByRole("button", NEXT));
    await u.type(await screen.findByRole("textbox", { name: "Nombre" }), "Puente");
    await u.click(screen.getByRole("button", NEXT));
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));
    await waitFor(() => expect(posted(fetch)).toHaveLength(1));
    expect(posted(fetch)[0]).not.toHaveProperty("location_accuracy_m");
  });

  it("says how to unblock a denied permission and brings the map forward", async () => {
    const u = user();
    const { watchPosition } = stubGeolocation([], "denied");
    server();
    renderFlow();
    await u.click(screen.getByRole("button", { name: /Usar mi ubicación actual/ }));
    expect(await screen.findByText(/tiene bloqueado el acceso a tu ubicación/)).toBeInTheDocument();
    expect(screen.getByText(/abre los ajustes del sitio/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "tap map" })).toBeInTheDocument();
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it("a refusal at the browser's own prompt shows the same help", async () => {
    const u = user();
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        clearWatch,
        watchPosition: (_ok: PositionCallback, fail: PositionErrorCallback) => {
          fail({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3 } as GeolocationPositionError);
          return 3;
        },
      },
      permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
    });
    server();
    renderFlow();
    await u.click(screen.getByRole("button", { name: /Usar mi ubicación actual/ }));
    expect(await screen.findByText(/tiene bloqueado el acceso/)).toBeInTheDocument();
    expect(clearWatch).toHaveBeenCalled();
  });

  it("says so when no reading arrives in time", async () => {
    const u = user();
    stubGeolocation([]);
    server();
    renderFlow();
    await u.click(screen.getByRole("button", { name: /Usar mi ubicación actual/ }));
    expect(await screen.findByText(/tardó demasiado/)).toBeInTheDocument();
  });

  it("says so when the browser cannot locate at all", async () => {
    const u = user();
    const { geolocation: _dropped, ...rest } = navigator as Navigator & { geolocation?: unknown };
    void _dropped;
    vi.stubGlobal("navigator", Object.fromEntries(Object.entries(rest)));
    server();
    renderFlow();
    await u.click(screen.getByRole("button", { name: /Usar mi ubicación actual/ }));
    expect(await screen.findByText(/no puede compartir tu ubicación/)).toBeInTheDocument();
  });
});

describe("is it somewhere we know?", () => {
  it("skips the step when there is nothing nearby", async () => {
    const u = user();
    server();
    renderFlow();
    await typeLocation(u);
    expect(await screen.findByRole("heading", { level: 2 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Paso 2 de 3: Nombre"));
  });

  it("skips it silently when the check fails", async () => {
    const u = user();
    server({ suggestFails: true });
    renderFlow();
    await typeLocation(u);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Nombre" })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets the person move on without waiting for the check", async () => {
    const u = user();
    let release: (response: Response) => void = () => {};
    mockFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    renderFlow();
    await u.click(screen.getByRole("button", { name: "Elegir en el mapa" }));
    await u.click(screen.getByRole("button", { name: "tap map" }));
    await u.click(screen.getByRole("button", NEXT));
    await u.click(await screen.findByRole("button", { name: "Seguir sin esperar" }));
    expect(screen.getByRole("textbox", { name: "Nombre" })).toBeInTheDocument();
    release(json({}));
  });

  it("asks about places already here, with distance and recordings", async () => {
    const u = user();
    server({ existing: [NEARBY] });
    renderFlow();
    await typeLocation(u);
    const heading = await screen.findByRole("heading", { level: 3, name: "¿Es el mismo lugar?" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Paso 2 de 4: Sitios cercanos");
    expect(screen.getByText("Fuente de la plaza")).toBeInTheDocument();
    expect(screen.getByText(/a 12 m · 3 grabaciones/)).toBeInTheDocument();
  });

  it("'yes, this one' opens it and creates nothing", async () => {
    const u = user();
    const fetch = server({ existing: [NEARBY] });
    const { onOpenExisting, onCreated } = renderFlow();
    await typeLocation(u);
    await u.click(await screen.findByRole("button", { name: "Sí, es Fuente de la plaza" }));
    expect(onOpenExisting).toHaveBeenCalledWith({ id: NEARBY.id, latitude: NEARBY.latitude, longitude: NEARBY.longitude });
    expect(onCreated).not.toHaveBeenCalled();
    expect(posted(fetch)).toEqual([]);
  });

  it("'no, it is different' goes on and confirms on create", async () => {
    const u = user();
    const fetch = server({ existing: [NEARBY] });
    const { onCreated } = renderFlow();
    await typeLocation(u);
    await u.click(await screen.findByRole("button", { name: "No, es un lugar distinto" }));
    await u.type(await screen.findByRole("textbox", { name: "Nombre" }), "Otra fuente");
    await u.click(screen.getByRole("button", NEXT));
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted(fetch)[0]).toMatchObject({ name: "Otra fuente", confirm_distinct: true });
  });

  it("offers OpenStreetMap sites, fills the name and keeps the reference", async () => {
    const u = user();
    const fetch = server({ external: [SITE] });
    const { onCreated } = renderFlow();
    await typeLocation(u);
    expect(await screen.findByRole("heading", { level: 3, name: "¿Es alguno de estos sitios?" })).toBeInTheDocument();
    expect(screen.getByText("Panadería · a 20 m")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "© colaboradores de OpenStreetMap" })).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Es Panadería Paco" }));
    const name = await screen.findByRole("textbox", { name: "Nombre" });
    expect(name).toHaveValue("Panadería Paco");
    await u.clear(name);
    await u.type(name, "La panadería de Paco");
    await u.click(screen.getByRole("button", NEXT));
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted(fetch)[0]).toMatchObject({
      name: "La panadería de Paco",
      external_source: "osm",
      external_id: "node/1001",
    });
  });

  it("'none of these' creates a place with no reference", async () => {
    const u = user();
    const fetch = server({ external: [SITE] });
    renderFlow();
    await typeLocation(u);
    await u.click(await screen.findByRole("button", { name: "Ninguno de estos" }));
    await u.type(await screen.findByRole("textbox", { name: "Nombre" }), "Rincón");
    await u.click(screen.getByRole("button", NEXT));
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));
    await waitFor(() => expect(posted(fetch)).toHaveLength(1));
    expect(posted(fetch)[0]).not.toHaveProperty("external_id");
  });

  it("asks about existing places first, then the sites", async () => {
    const u = user();
    server({ existing: [NEARBY], external: [SITE] });
    renderFlow();
    await typeLocation(u);
    await u.click(await screen.findByRole("button", { name: "No, es un lugar distinto" }));
    expect(await screen.findByRole("heading", { level: 3, name: "¿Es alguno de estos sitios?" })).toBeInTheDocument();
    expect(screen.queryByText("Fuente de la plaza")).not.toBeInTheDocument();
  });

  it("marks a site that looks like an existing place", async () => {
    const u = user();
    server({ external: [{ ...SITE, matches_place_id: NEARBY.id }] });
    renderFlow();
    await typeLocation(u);
    expect(await screen.findByText("Se parece a un lugar que ya existe")).toBeInTheDocument();
  });

  it("translates a known category and leaves an unknown one readable", async () => {
    const u = user();
    server({ external: [{ ...SITE, category: "bicycle_repair_station" }, { ...SITE, external_id: "node/2", category: "cafe" }] });
    renderFlow({ language: "en" });
    await u.click(screen.getByText("Advanced: type coordinates"));
    await u.type(screen.getByLabelText("Latitude"), "43.26");
    await u.type(screen.getByLabelText("Longitude"), "-2.93");
    await u.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("bicycle repair station · 20 m away")).toBeInTheDocument();
    expect(screen.getByText("Café · 20 m away")).toBeInTheDocument();
  });

  it("changing the point forgets the earlier answers", async () => {
    const u = user();
    const fetch = server({ existing: [NEARBY] });
    renderFlow();
    await typeLocation(u);
    await u.click(await screen.findByRole("button", { name: "No, es un lugar distinto" }));
    await screen.findByRole("textbox", { name: "Nombre" });
    await u.click(screen.getByRole("button", { name: "Atrás" }));
    await u.click(await screen.findByRole("button", { name: "Atrás" }));
    await u.click(screen.getByText("Avanzado: escribir coordenadas"));
    await u.type(screen.getByLabelText("Latitud"), "1");
    await u.click(screen.getByRole("button", NEXT));
    expect(await screen.findByRole("heading", { level: 3, name: "¿Es el mismo lugar?" })).toBeInTheDocument();
    void fetch;
  });
});

describe("the OpenStreetMap switch", () => {
  it("is on by default, says what is sent, and asks outside", async () => {
    const u = user();
    const fetch = server();
    renderFlow();
    const box = screen.getByRole("checkbox", { name: "Sugerir sitios de OpenStreetMap" });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(/cuadrado de unos 300 m. Nunca se envía tu posición exacta/);
    await typeLocation(u);
    await waitFor(() => expect(suggestCalls(fetch).length).toBeGreaterThan(0));
    expect(suggestCalls(fetch).at(-1)!.searchParams.get("external")).toBe("true");
  });

  it("off means the server is told not to ask, and it is remembered", async () => {
    const u = user();
    const fetch = server();
    renderFlow();
    await u.click(screen.getByRole("checkbox"));
    expect(window.localStorage.getItem("sa.suggestOsm")).toBe("off");
    await typeLocation(u);
    await waitFor(() => expect(suggestCalls(fetch).length).toBeGreaterThan(0));
    expect(suggestCalls(fetch).at(-1)!.searchParams.get("external")).toBe("false");
  });

  it("starts off when it was left off", () => {
    window.localStorage.setItem("sa.suggestOsm", "off");
    server();
    renderFlow();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("does not appear when the instance has it switched off", async () => {
    const u = user();
    const fetch = server();
    renderFlow({ config: { external_places_enabled: false } });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await typeLocation(u);
    await waitFor(() => expect(suggestCalls(fetch).length).toBeGreaterThan(0));
    expect(suggestCalls(fetch).at(-1)!.searchParams.get("external")).toBe("false");
  });
});

describe("creating", () => {
  async function toConfirm(u: ReturnType<typeof user>, name = "Bridge") {
    await typeLocation(u);
    await u.type(await screen.findByRole("textbox", { name: "Nombre" }), name);
    await u.click(screen.getByRole("button", NEXT));
  }

  it("checks the name, then creates the place with the typed values", async () => {
    const u = user();
    const fetch = server();
    const { onCreated } = renderFlow();

    await typeLocation(u);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Paso 2 de 3"));
    await u.click(screen.getByRole("button", NEXT));
    const name = screen.getByLabelText("Nombre");
    expect(name).toHaveAccessibleDescription(/Escribe un nombre/);
    await waitFor(() => expect(name).toHaveFocus());

    await u.type(name, "  Old market  ");
    await u.type(screen.getByLabelText("Descripción (opcional)"), "Rain on a tin roof");
    await u.click(screen.getByRole("button", NEXT));

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Paso 3 de 3: Confirmar");
    expect(screen.getByText("Old market")).toBeInTheDocument();
    expect(screen.getByText("43,26300° N, 2,93500° O")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted(fetch)[0]).toEqual({ name: "Old market", description: "Rain on a tin roof", latitude: 43.263, longitude: -2.935 });
  });

  it("rejects a name that is too long", async () => {
    const u = user();
    server();
    renderFlow();
    await typeLocation(u);
    await u.click(await screen.findByLabelText("Nombre"));
    await u.paste("x".repeat(121));
    await u.click(screen.getByRole("button", NEXT));
    expect(screen.getByLabelText("Nombre")).toHaveAccessibleDescription(/121 caracteres; el máximo es 120/);
  });

  it("a 409 on create asks the same question and keeps what was typed", async () => {
    const u = user();
    const fetch = server({
      create: (body) =>
        body.confirm_distinct
          ? json(makePlace(9, body), 201)
          : json({ detail: { code: "possible_duplicate", candidates: [NEARBY], radius_m: 50 } }, 409),
    });
    const { onCreated } = renderFlow();
    await toConfirm(u);
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));

    expect(await screen.findByRole("heading", { level: 3, name: "¿Es el mismo lugar?" })).toBeInTheDocument();
    expect(screen.getByText("Bridge")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "No, es un lugar distinto" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted(fetch)[1]).toMatchObject({ name: "Bridge", confirm_distinct: true });
  });

  it("a 409 for a site already taken offers to open it or go on without the link", async () => {
    const u = user();
    const fetch = server({
      external: [SITE],
      create: (body) =>
        body.external_id ? json({ detail: { code: "external_exists", candidates: [NEARBY] } }, 409) : json(makePlace(9, body), 201),
    });
    const { onCreated } = renderFlow();
    await typeLocation(u);
    await u.click(await screen.findByRole("button", { name: "Es Panadería Paco" }));
    await screen.findByRole("textbox", { name: "Nombre" });
    await u.click(screen.getByRole("button", NEXT));
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));
    await u.click(await screen.findByRole("button", { name: "Es otro: crearlo sin enlazar el sitio" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted(fetch)[1]).not.toHaveProperty("external_id");
  });

  it("keeps everything after a network error and lets the user retry", async () => {
    const u = user();
    let online = false;
    mockFetch(async (url, init) => {
      if (url.pathname.endsWith("/suggest")) return json({ existing: [], external: [], external_available: false, radius_m: 50 });
      if (!online) throw new TypeError("Failed to fetch");
      return json(makePlace(9, JSON.parse(String(init!.body))), 201);
    });
    const { onCreated } = renderFlow();
    await toConfirm(u);
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo conectar con el servidor");
    expect(screen.getByText("Bridge")).toBeInTheDocument();
    online = true;
    await u.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("explains a server error with its status", async () => {
    const u = user();
    server({ create: () => json({}, 500) });
    renderFlow();
    await toConfirm(u);
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("(error 500)");
  });

  it("shows the disabled state instead of the form when writes are off", async () => {
    const u = user();
    const { onCancel } = renderFlow({ writes: false });
    expect(screen.getByText("La creación de lugares está desactivada en este servidor")).toBeInTheDocument();
    expect(screen.queryByLabelText("Latitud")).not.toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Volver" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
