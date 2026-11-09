import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/ui";
import { I18nProvider } from "../../i18n/i18n";
import { json, mockFetch } from "../../test/fakeApi";
import { PhotoStrip } from "./PhotoStrip";

afterEach(() => vi.unstubAllGlobals());

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

async function openForm() {
  mockFetch(async () => json([]));
  render(
    <I18nProvider language="es">
      <ToastProvider>
        <PhotoStrip placeId="p" isAdmin={false} />
      </ToastProvider>
    </I18nProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Añadir una foto" }));
}

describe("two ways to add a photo", () => {
  it("on a touch screen the camera opens straight from the file field", async () => {
    pointer(true);
    await openForm();
    const input = screen.getByTestId("camera-input");
    expect(input).toHaveAttribute("capture", "environment");
    expect(input).toHaveAttribute("accept", "image/*");
    expect(screen.getByLabelText("Elegir de la galería o archivos")).toBeInTheDocument();
  });

  it("on a computer it opens the camera inside the page, after an explanation", async () => {
    pointer(false);
    await openForm();
    expect(screen.queryByTestId("camera-input")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hacer una foto" }));
    expect(screen.getByRole("heading", { level: 3, name: "Hacer una foto con la cámara" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elegir un archivo en su lugar" })).toBeInTheDocument();
  });

  it("the gallery stays available", async () => {
    pointer(false);
    await openForm();
    expect(screen.getByTestId("photo-input")).toHaveAccessibleName("Elegir de la galería o archivos");
  });
});
