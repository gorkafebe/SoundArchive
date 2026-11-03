import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnouncerProvider } from "../../components/Announcer";
import { I18nProvider, type Language } from "../../i18n/i18n";
import { ThemeProvider } from "../../lib/theme";
import { CONFIG, json, makePlace, mockFetch } from "../../test/fakeApi";
import { AddPlaceFlow } from "./AddPlaceFlow";
import { parseCoordinate } from "./validation";

// The small map needs WebGL; a button stands in for "tap the map here".
vi.mock("./LocationPicker", () => ({
  LocationPicker: ({ onPick }: { onPick: (lat: number, lon: number) => void }) => (
    <button type="button" onClick={() => onPick(43.263, -2.935)}>
      tap map
    </button>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

function renderFlow({ writes = true, language = "es" as Language } = {}) {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  render(
    <I18nProvider language={language}>
      <ThemeProvider>
        <AnnouncerProvider>
          <AddPlaceFlow
            config={{ ...CONFIG, writes_enabled: writes }}
            initialCamera={{ lon: -3.7, lat: 40.2, zoom: 5 }}
            onCancel={onCancel}
            onCreated={onCreated}
          />
        </AnnouncerProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
  return { onCreated, onCancel };
}

const user = () => userEvent.setup();

async function fillLocation(u: ReturnType<typeof user>, lat = "43,2630", lon = "-2,9350") {
  await u.type(screen.getByLabelText("Latitud"), lat);
  await u.type(screen.getByLabelText("Longitud"), lon);
  await u.click(screen.getByRole("button", { name: "Siguiente" }));
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

describe("AddPlaceFlow", () => {
  it("starts on step 1 with the focus on its heading", async () => {
    renderFlow();
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("Paso 1 de 3: Ubicación");
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("explains 'use my location' before it is pressed", () => {
    renderFlow();
    const button = screen.getByRole("button", { name: "Usar mi ubicación" });
    expect(button).toHaveAccessibleDescription(/Tu navegador te pedirá permiso/);
  });

  it("marks empty coordinates, links the errors and focuses the first one", async () => {
    const u = user();
    renderFlow();
    await u.click(screen.getByRole("button", { name: "Siguiente" }));

    const lat = screen.getByLabelText("Latitud");
    expect(lat).toHaveAttribute("aria-invalid", "true");
    expect(lat).toHaveAccessibleDescription(/Escribe la latitud o elige un punto en el mapa/);
    expect(screen.getByLabelText("Longitud")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Hay 2 campos que revisar.")).toBeInTheDocument();
    await waitFor(() => expect(lat).toHaveFocus());
  });

  it("rejects numbers out of range and text that is not a number", async () => {
    const u = user();
    renderFlow();
    await fillLocation(u, "91", "abc");
    expect(screen.getByLabelText("Latitud")).toHaveAccessibleDescription(/entre −90 y 90/);
    expect(screen.getByLabelText("Longitud")).toHaveAccessibleDescription(/debe ser un número/);
  });

  it("fills the fields when the map is tapped", async () => {
    const u = user();
    renderFlow();
    await u.click(screen.getByRole("button", { name: "tap map" }));
    expect(screen.getByLabelText("Latitud")).toHaveValue("43,263000");
    expect(screen.getByLabelText("Longitud")).toHaveValue("-2,935000");
  });

  it("checks the name, then creates the place with the typed values", async () => {
    const u = user();
    const fetch = mockFetch(async (_url, init) => json(makePlace(9, JSON.parse(String(init!.body))), 201));
    const { onCreated } = renderFlow();

    await fillLocation(u);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Paso 2 de 3");
    await u.click(screen.getByRole("button", { name: "Siguiente" }));
    const name = screen.getByLabelText("Nombre");
    expect(name).toHaveAccessibleDescription(/Escribe un nombre/);
    await waitFor(() => expect(name).toHaveFocus());

    await u.type(name, "  Old market  ");
    await u.type(screen.getByLabelText("Descripción (opcional)"), "Rain on a tin roof");
    await u.click(screen.getByRole("button", { name: "Siguiente" }));

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Paso 3 de 3: Confirmar");
    expect(screen.getByText("Old market")).toBeInTheDocument();
    expect(screen.getByText("43,26300° N, 2,93500° O")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(body).toEqual({ name: "Old market", description: "Rain on a tin roof", latitude: 43.263, longitude: -2.935 });
  });

  it("rejects a name that is too long", async () => {
    const u = user();
    renderFlow();
    await fillLocation(u);
    await u.click(screen.getByLabelText("Nombre"));
    await u.paste("x".repeat(121));
    await u.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByLabelText("Nombre")).toHaveAccessibleDescription(/121 caracteres; el máximo es 120/);
  });

  it("keeps everything after a network error and lets the user retry", async () => {
    const u = user();
    let online = false;
    mockFetch(async (_url, init) => {
      if (!online) throw new TypeError("Failed to fetch");
      return json(makePlace(9, JSON.parse(String(init!.body))), 201);
    });
    const { onCreated } = renderFlow();
    await fillLocation(u);
    await u.type(screen.getByLabelText("Nombre"), "Bridge");
    await u.click(screen.getByRole("button", { name: "Siguiente" }));
    await u.click(screen.getByRole("button", { name: "Crear el lugar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo conectar con el servidor");
    expect(screen.getByText("Bridge")).toBeInTheDocument();
    online = true;
    await u.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("explains a server error with its status", async () => {
    const u = user();
    mockFetch(async () => json({}, 500));
    renderFlow();
    await fillLocation(u);
    await u.type(screen.getByLabelText("Nombre"), "Bridge");
    await u.click(screen.getByRole("button", { name: "Siguiente" }));
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

  it("says how to unblock a denied location permission", async () => {
    const u = user();
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: { getCurrentPosition: vi.fn() },
      permissions: { query: vi.fn(async () => ({ state: "denied" })) },
    });
    renderFlow();
    await u.click(screen.getByRole("button", { name: "Usar mi ubicación" }));
    expect(await screen.findByText(/tiene bloqueado el acceso a tu ubicación/)).toBeInTheDocument();
    expect(screen.getByText(/abre los ajustes del sitio/)).toBeInTheDocument();
    expect((navigator.geolocation.getCurrentPosition as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("fills the fields from the device location after a tap", async () => {
    const u = user();
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: 41.387, longitude: 2.17, accuracy: 12.4 } } as GeolocationPosition),
      },
      permissions: { query: vi.fn(async () => ({ state: "prompt" })) },
    });
    renderFlow({ language: "en" });
    await u.click(screen.getByRole("button", { name: "Use my location" }));
    expect(await screen.findByText("Location found (accuracy about 12 m).")).toBeInTheDocument();
    expect(screen.getByLabelText("Latitude")).toHaveValue("41.387000");
    expect(screen.getByLabelText("Longitude")).toHaveValue("2.170000");
  });
});
