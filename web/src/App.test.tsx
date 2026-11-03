// The app shell with the map replaced by a stand-in (jsdom has no WebGL).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { AnnouncerProvider } from "./components/Announcer";
import { I18nProvider } from "./i18n/i18n";
import { ThemeProvider } from "./lib/theme";
import { fakeServer, makePlace } from "./test/fakeApi";

vi.mock("./features/map/MapView", () => ({
  MapView: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <section aria-label="Mapa de lugares">
      <button type="button" onClick={() => onSelect(makePlace(1).id)}>
        Place 1
      </button>
    </section>
  ),
}));

function renderApp() {
  return render(
    <I18nProvider language="es">
      <ThemeProvider>
        <AnnouncerProvider>
          <App />
        </AnnouncerProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("has the landmarks and a skip link to the main content", async () => {
    fakeServer([makePlace(1)]);
    renderApp();
    expect(screen.getByRole("link", { name: "Saltar al contenido" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Vistas y acciones" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(await screen.findByRole("region", { name: "Mapa de lugares" })).toBeInTheDocument();
  });

  it("switches between map and list, and keeps it in the address", async () => {
    fakeServer([makePlace(1), makePlace(2)]);
    renderApp();
    const mapButton = await screen.findByRole("button", { name: "Mapa" });
    const listButton = screen.getByRole("button", { name: "Lista" });
    expect(mapButton).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(listButton);

    expect(listButton).toHaveAttribute("aria-pressed", "true");
    expect(mapButton).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByRole("heading", { name: "Lista de lugares" })).toBeInTheDocument();
    expect(window.location.search).toContain("view=list");
    // The map is hidden, not destroyed.
    expect(screen.getByRole("region", { name: "Mapa de lugares", hidden: true })).not.toBeVisible();

    await userEvent.click(mapButton);
    expect(window.location.search).toContain("view=map");
    expect(screen.getByRole("region", { name: "Mapa de lugares" })).toBeVisible();
  });

  it("opens a place from the list and gives the focus back to its row on close", async () => {
    fakeServer([makePlace(1), makePlace(2)]);
    window.history.replaceState(null, "", "/?view=list");
    renderApp();

    const row = await screen.findByRole("button", { name: /Place 2/ });
    await userEvent.click(row);

    const heading = await screen.findByRole("heading", { level: 2, name: "Place 2" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(window.location.search).toContain(`place=${makePlace(2).id}`);

    await userEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Place 2/ })).toHaveFocus());
    expect(window.location.search).not.toContain("place=");
  });

  it("opens the panel from a shared link", async () => {
    fakeServer([makePlace(1)]);
    window.history.replaceState(null, "", `/?view=map&place=${makePlace(1).id}`);
    renderApp();
    expect(await screen.findByRole("heading", { level: 2, name: "Place 1" })).toBeInTheDocument();
  });

  it("shows a retry button when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo conectar con el servidor");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });
});
