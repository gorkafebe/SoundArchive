// Shared setup for the end-to-end tests.
//
// No internet: every request that does not go to our own site is answered
// locally or blocked, so the tests never depend on (or send anything to) the
// tile provider. /api/config is passed through but its map style is replaced
// by a minimal local style: a flat background, no tiles, no fonts.
import { test as base, expect, type Page } from "@playwright/test";

export const LOCAL_STYLE = {
  version: 8,
  name: "e2e-flat",
  sources: {},
  // A plain, light background: a stand-in for the real basemap.
  layers: [{ id: "background", type: "background", paint: { "background-color": "#e9e6dc" } }],
};

export interface AppOptions {
  writesEnabled?: boolean;
  language?: "es" | "en";
  theme?: "light" | "dark";
}

export async function prepare(page: Page, options: AppOptions = {}) {
  const origin = new URL(test.info().project.use.baseURL ?? "https://soundarchive").origin;
  const blocked: string[] = [];

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      // Simulated tile server: answer with nothing, and remember it.
      blocked.push(url.href);
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname === "/e2e/style.json") {
      return route.fulfill({ json: LOCAL_STYLE });
    }
    if (url.pathname === "/api/config") {
      // The page may reload while this is in flight; that is not a failure.
      try {
        const response = await route.fetch();
        const config = await response.json();
        config.map_style_url = "/e2e/style.json";
        config.map_style_url_dark = "/e2e/style.json";
        if (options.writesEnabled !== undefined) config.writes_enabled = options.writesEnabled;
        return await route.fulfill({ response, json: config });
      } catch {
        return route.abort().catch(() => {});
      }
    }
    return route.continue();
  });

  // Language and theme as a returning visitor would have saved them.
  await page.addInitScript(
    ({ language, theme }) => {
      // Only on the first visit: a reload keeps what the test switched to.
      if (language && !localStorage.getItem("sa.language")) localStorage.setItem("sa.language", language);
      if (theme && !localStorage.getItem("sa.theme")) localStorage.setItem("sa.theme", theme);
    },
    { language: options.language ?? "es", theme: options.theme },
  );
  return { blocked };
}

export const test = base;
export { expect };

/** Wait until the map has drawn its pins for the current view. */
export async function waitForPins(page: Page) {
  await expect(page.locator(".map-pin, .map-cluster").first()).toBeVisible();
  await expect(page.locator(".map-status").filter({ hasText: /lugares? en esta zona|places? in this area/ })).toBeVisible();
}
