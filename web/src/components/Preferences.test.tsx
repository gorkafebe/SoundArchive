import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "../i18n/i18n";
import { ThemeProvider } from "../lib/theme";
import { Preferences } from "./Preferences";

function renderPreferences() {
  return render(
    <I18nProvider language="es">
      <ThemeProvider>
        <Preferences />
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe("Preferences", () => {
  it("switches the language, updates <html lang> and remembers it", async () => {
    renderPreferences();
    expect(document.documentElement.lang).toBe("es");

    await userEvent.click(screen.getByRole("button", { name: /Cambiar el idioma:\s*English/ }));

    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("button", { name: /Change the language:\s*Español/ })).toBeInTheDocument();
    expect(window.localStorage.getItem("sa.language")).toBe("en");
  });

  it("starts light, switches to dark and remembers it", async () => {
    renderPreferences();
    expect(document.documentElement.dataset.theme).toBe("light");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Tema" }), "dark");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("sa.theme")).toBe("dark");
  });
});
