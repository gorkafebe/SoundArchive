// Map layers, with the imagery simulated: a test image from the repository,
// served by Playwright. The Content-Security-Policy is the real one (the
// browser applies it before the request), and nothing reaches the internet.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, prepare, test, waitForPins } from "./fixtures";

const BILBAO = "/?view=map&lat=43.26300&lon=-2.93500&z=14.00";
const LYON = "/?view=map&lat=45.76000&lon=4.84000&z=9.00";
const CORS = { "Access-Control-Allow-Origin": "*" };

/** Serve the imagery providers locally and remember who was asked. */
async function fakeTiles(page: Page, status = 200) {
  const calls: string[] = [];
  const answer = (route: import("@playwright/test").Route) => {
    calls.push(route.request().url());
    return status === 200
      ? route.fulfill({ path: "e2e/assets/tile.png", contentType: "image/png", headers: CORS })
      : route.fulfill({ status, body: "", headers: CORS });
  };
  await page.route("https://www.ign.es/**", answer);
  await page.route("https://tiles.maps.eox.at/**", answer);
  return calls;
}

const ign = (calls: string[]) => calls.filter((url) => url.startsWith("https://www.ign.es/"));
const eox = (calls: string[]) => calls.filter((url) => url.startsWith("https://tiles.maps.eox.at/"));

async function chooseLayer(page: Page, name: string | RegExp, button = "Capas") {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("radio", { name, exact: true }).click();
}

const attribution = (page: Page) => page.locator(".maplibregl-ctrl-attrib").first();

async function moveAlong(page: Page) {
  // moveend comes from the map; a small pan with the keyboard produces one.
  await page.locator(".maplibregl-canvas").first().focus();
  await page.keyboard.press("ArrowRight");
}

for (const { language, theme, width, height, button, satellite, map } of [
  { language: "es", theme: "light", width: 390, height: 844, button: "Capas", satellite: "Satélite", map: "Mapa" },
  { language: "es", theme: "dark", width: 1440, height: 900, button: "Capas", satellite: "Satélite", map: "Mapa" },
  { language: "en", theme: "light", width: 1440, height: 900, button: "Layers", satellite: "Satellite", map: "Map" },
  { language: "en", theme: "dark", width: 390, height: 844, button: "Layers", satellite: "Satellite", map: "Map" },
] as const) {
  test(`satellite only when chosen; credit, memory and pins survive (${language}, ${theme}, ${width})`, async ({ page }) => {
    await prepare(page, { language, theme });
    await page.setViewportSize({ width, height });
    const calls = await fakeTiles(page);
    await page.goto(BILBAO);
    await waitForPins(page);
    await page.waitForTimeout(500);
    expect(calls, "no imagery request before choosing it").toEqual([]);
    await expect(attribution(page)).not.toContainText("Instituto Geográfico");

    const pins = await page.locator(".map-pin, .map-cluster").count();
    await chooseLayer(page, satellite, button);
    await expect.poll(() => ign(calls).length).toBeGreaterThan(0);
    expect(eox(calls), "Spain must not touch EOX").toEqual([]);
    await expect(attribution(page)).toContainText("PNOA cedido por © Instituto Geográfico Nacional");
    await expect(attribution(page)).toContainText("OpenStreetMap");
    await expect(page.locator(".map-view").first()).toHaveAttribute("data-imagery", "true");
    await page.screenshot({ path: `test-results/screens/layer-satellite-${language}-${theme}-${width}.png` });

    // The credit is not hidden behind the controls.
    const overlap = await page.evaluate(() => {
      const credit = document.querySelector(".maplibregl-ctrl-attrib")!.getBoundingClientRect();
      return [...document.querySelectorAll(".layer-control__button, .maplibregl-ctrl-group, .map-add")].some((element) => {
        const box = element.getBoundingClientRect();
        return box.left < credit.right && box.right > credit.left && box.top < credit.bottom && box.bottom > credit.top;
      });
    });
    expect(overlap).toBe(false);
    await expect(attribution(page)).toBeInViewport();

    for (let i = 0; i < 2; i++) {
      await chooseLayer(page, map, button);
      await expect(attribution(page)).not.toContainText("Instituto Geográfico");
      await chooseLayer(page, satellite, button);
      await expect(attribution(page)).toContainText("Instituto Geográfico");
    }
    await expect(page.locator(".map-pin, .map-cluster")).toHaveCount(pins);

    await page.reload();
    await waitForPins(page);
    await expect(attribution(page)).toContainText("Instituto Geográfico");
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByRole("radio", { name: satellite })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await chooseLayer(page, map, button);
    await expect(page.locator(".map-pin, .map-cluster")).toHaveCount(pins);
  });
}

test("outside Spain the imagery is EOX, never the IGN, with its credit", async ({ page }) => {
  await prepare(page);
  const calls = await fakeTiles(page);
  await page.goto(LYON);
  await chooseLayer(page, "Satélite");
  await expect.poll(() => eox(calls).length).toBeGreaterThan(0);
  expect(ign(calls)).toEqual([]);
  await expect(attribution(page)).toContainText("EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH");
  await expect(attribution(page)).toContainText("Copernicus Sentinel data 2025");
  await expect(attribution(page)).not.toContainText("Instituto Geográfico");
});

test("without the world-wide imagery, outside Spain it says so and shows the map", async ({ page }) => {
  await prepare(page, { config: { satellite_global_fallback: false } });
  const calls = await fakeTiles(page);
  await page.goto(LYON);
  await chooseLayer(page, "Satélite");
  await expect(page.getByText("Satélite no disponible en esta zona")).toBeVisible();
  await page.waitForTimeout(500);
  expect(calls).toEqual([]);
  await expect(page.locator(".map-view").first()).not.toHaveAttribute("data-imagery", "true");
});

test("with satellite switched off on the server there is no selector", async ({ page }) => {
  await prepare(page, { config: { satellite_enabled: false, topo_es_enabled: false } });
  await page.goto(BILBAO);
  await waitForPins(page);
  await expect(page.getByRole("button", { name: "Capas", exact: true })).toHaveCount(0);
});

test("the topographic map has its own credit", async ({ page }) => {
  await prepare(page);
  const calls = await fakeTiles(page);
  await page.goto(BILBAO);
  await waitForPins(page);
  await chooseLayer(page, "Mapa topográfico");
  await expect.poll(() => ign(calls).some((url) => url.includes("mapa-raster"))).toBe(true);
  await expect(attribution(page)).toContainText("Mapa topográfico cedido por © Instituto Geográfico Nacional");
});

test("when tiles fail: one quiet notice, and back to the map", async ({ page }) => {
  await prepare(page);
  await fakeTiles(page, 500);
  await page.goto(BILBAO);
  await waitForPins(page);
  await chooseLayer(page, "Satélite");
  await expect(page.getByText("No se han podido cargar las imágenes de esta capa.")).toBeVisible();
  await expect(page.locator(".layer-control__notice")).toHaveCount(1);
  await moveAlong(page);
  await page.getByRole("button", { name: "Volver al mapa" }).click();
  await expect(page.getByText("No se han podido cargar las imágenes de esta capa.")).toHaveCount(0);
  await expect(page.locator(".map-view").first()).toHaveAttribute("data-imagery", "false");
  await expect(page.locator(".map-pin, .map-cluster").first()).toBeVisible();
});

test("the selector works from the keyboard alone and passes axe", async ({ page }) => {
  await prepare(page);
  const calls = await fakeTiles(page);
  await page.goto(BILBAO);
  await waitForPins(page);
  const button = page.getByRole("button", { name: "Capas", exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: "Mapa", exact: true })).toBeFocused();

  // Pins go wherever the map puts them, sometimes under a floating control:
  // the exception already recorded for the map view in docs/ACCEPTANCE.md.
  const audit = await new AxeBuilder({ page }).exclude(".maplibregl-marker").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "Satélite" })).toBeFocused();
  await expect(page.getByRole("radio", { name: "Satélite" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => ign(calls).length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("radiogroup")).toHaveCount(0);
  await expect(button).toBeFocused();

  // Every option is a 44 px target.
  await button.click();
  for (const radio of await page.getByRole("radio").all()) {
    expect((await radio.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test("the map for adding a place has the same selector, and it fits", async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await fakeTiles(page);
  await page.goto(BILBAO);
  await waitForPins(page);
  await page.getByRole("button", { name: "Añadir lugar" }).click();
  await page.getByRole("button", { name: "Elegir en el mapa" }).click();
  const picker = page.locator(".location-picker");
  await expect(picker.locator("canvas")).toBeVisible();
  await picker.getByRole("button", { name: "Capas", exact: true }).click();

  const group = picker.getByRole("radiogroup");
  const inside = await group.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const frame = element.closest(".location-picker")!.getBoundingClientRect();
    return box.top >= frame.top && box.bottom <= frame.bottom && box.left >= frame.left && box.right <= frame.right;
  });
  expect(inside, "the options are not cut off by the small map").toBe(true);
  await page.screenshot({ path: "test-results/screens/picker-layers-390.png", fullPage: true });

  await picker.getByRole("radio", { name: "Satélite" }).click();
  await expect.poll(() => ign(calls).length).toBeGreaterThan(0);
  await expect(picker.locator(".maplibregl-ctrl-attrib")).toContainText("PNOA cedido");
  await page.locator(".location-picker canvas").click();
  await expect(page.getByRole("img", { name: "Ubicación elegida" })).toBeVisible();
});
