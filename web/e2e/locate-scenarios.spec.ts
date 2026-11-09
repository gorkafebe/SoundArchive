// What a person sees after pressing "where am I?", with browsers that behave
// the way real ones do: slow, silent, approximate or refusing. Every test ends
// by asking the question that matters: 20 seconds later, what is on the screen?
//
// The position is simulated by a start-up script: no real location service is
// ever contacted.
import type { Page } from "@playwright/test";

import { GEO_LAT, GEO_LON, GEO_SCENARIOS, CHROMIUM_NO_PROVIDER, installGeoScenario, type GeoLog, type GeoScenarioName } from "../src/test/geoScenarios";
import { expect, prepare, test } from "./fixtures";

const SHOW = "Mostrar mi ubicación";
const STOP = "Dejar de mostrar mi ubicación";
const ACCEPT = "Continuar";
/** Long enough for anything the button may do; if it is still busy, that is the bug. */
const WITHIN = { timeout: 22_000 };

async function pressButton(page: Page, name: GeoScenarioName) {
  await prepare(page);
  await page.addInitScript(installGeoScenario, GEO_SCENARIOS[name]);
  await page.goto(`/?view=map&lat=${GEO_LAT + 0.5}&lon=${GEO_LON + 0.7}&z=13.00`);
  const button = page.getByRole("button", { name: SHOW, exact: true });
  await expect(button).toBeVisible();
  await expect(page.locator(".maplibregl-canvas").first()).toBeVisible();
  await button.click();
  // Permission not settled yet: the app explains first.
  const { permission } = GEO_SCENARIOS[name];
  if (permission === "prompt" || permission === "absent") {
    await page.getByRole("dialog").getByRole("button", { name: ACCEPT }).click();
  }
}

const log = (page: Page) => page.evaluate(() => (globalThis as unknown as { __geoLog: GeoLog }).__geoLog);

/** On: the marker is drawn, at the real position, in the middle of the view (B7, B8). */
async function expectShown(page: Page, label?: RegExp) {
  await expect(page.getByRole("button", { name: STOP, exact: true })).toBeVisible(WITHIN);
  const marker = page.locator(".map-me");
  await expect(marker).toBeVisible();
  if (label) await expect(marker).toHaveAttribute("aria-label", label);

  await expect
    .poll(async () => {
      const url = new URL(page.url());
      return Math.hypot(Number(url.searchParams.get("lat")) - GEO_LAT, Number(url.searchParams.get("lon")) - GEO_LON);
    }, WITHIN)
    .toBeLessThan(0.01);

  const box = (await marker.boundingBox())!;
  const map = (await page.locator(".maplibregl-canvas").first().boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (map.x + map.width / 2))).toBeLessThan(30);
  expect(Math.abs(box.y + box.height / 2 - (map.y + map.height / 2))).toBeLessThan(30);
  await expect(page.locator(".locate-control__button")).toHaveAttribute("aria-busy", "false");
}

/** Failed: says why, the button is usable again, nothing keeps listening. */
async function expectError(page: Page, message: RegExp) {
  const notice = page.locator(".locate-notice");
  await expect(notice).toBeVisible(WITHIN);
  await expect(notice).toContainText(message);
  await expect(page.locator(".locate-control__button")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".map-me")).toHaveCount(0);
  expect((await log(page)).openWatches).toBe(0);
}

const TIMEOUT = /tardó demasiado/;
const UNAVAILABLE = /No se pudo saber tu ubicación/;
const DENIED = /tiene bloqueado el acceso/;
const NO_RESPONSE = /no ha respondido/;

test.describe("what the person sees", () => {
  test("immediate and precise: shown", { tag: "@engines" }, async ({ page }) => {
    await pressButton(page, "immediate");
    await expectShown(page, /±8 m$/);
  });

  test("first reading after 3 s: shown", async ({ page }) => {
    await pressButton(page, "after3s");
    await expectShown(page, /±30 m$/);
  });

  test("first reading after 9 s (cold GPS, A5): shown", async ({ page }) => {
    await pressButton(page, "after9s");
    await expectShown(page, /±30 m$/);
  });

  test("first reading after 15 s (cold GPS, A5): shown", async ({ page }) => {
    await pressButton(page, "after15s");
    await expectShown(page, /±30 m$/);
  });

  test("error 1, refused in the browser's dialog: says it is blocked", { tag: "@engines" }, async ({ page }) => {
    await pressButton(page, "denied1");
    await expectError(page, DENIED);
  });

  test("error 2, no location provider (A1): says unavailable", async ({ page }) => {
    await pressButton(page, "unavailable2");
    await expectError(page, UNAVAILABLE);
  });

  test("error 3, the browser's own timeout: says so", async ({ page }) => {
    await pressButton(page, "timeout3");
    await expectError(page, TIMEOUT);
  });

  test("total silence, no callback at all (A2, B1): never stuck, says no response", async ({ page }) => {
    await pressButton(page, "silence");
    await expectError(page, NO_RESPONSE);
    await expect(page.getByRole("button", { name: SHOW, exact: true })).toBeVisible();
  });

  test("one reading and nothing else (B3): shown", async ({ page }) => {
    await pressButton(page, "single");
    await expectShown(page, /±300 m$/);
  });

  test("accuracy that improves (5000, 200, 20 m): the best one wins (B2)", async ({ page }) => {
    await pressButton(page, "improving");
    await expectShown(page, /±20 m$/);
  });

  test("terrible accuracy, position from the IP address (A4, B8): shown, warned, not zoomed out to a continent", async ({ page }) => {
    await pressButton(page, "byIp");
    await expectShown(page);
    await expect(page.locator(".map-status").filter({ hasText: /muy aproximada \(±50 km\)/ })).toBeVisible();
    await expect.poll(async () => Number(new URL(page.url()).searchParams.get("z")), WITHIN).toBeGreaterThanOrEqual(10);
  });

  test("high accuracy fails, low accuracy works (B6): shown", async ({ page }) => {
    await pressButton(page, "highFails");
    await expectShown(page, /±900 m$/);
  });

  test("high accuracy says nothing, low accuracy works (B6): shown", async ({ page }) => {
    await pressButton(page, "highSilent");
    await expectShown(page, /±900 m$/);
  });

  test("no Permissions API (B9): explained, then shown", { tag: "@engines" }, async ({ page }) => {
    await pressButton(page, "noPermissionsApi");
    await expectShown(page, /±8 m$/);
  });

  test("permission in 'prompt' (B9): explained, then shown", { tag: "@engines" }, async ({ page }) => {
    await pressButton(page, "promptState");
    await expectShown(page, /±8 m$/);
  });

  test("permission 'granted' (B9): straight to the position", async ({ page }) => {
    await pressButton(page, "immediate");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectShown(page);
    expect((await log(page)).calls.length).toBeGreaterThan(0);
  });

  test("permission 'denied' (B9): says so without asking the browser", async ({ page }) => {
    await pressButton(page, "deniedState");
    await expectError(page, DENIED);
    expect((await log(page)).calls).toEqual([]);
  });

  test("the browser's permission dialog stays open 12 s (B11): shown once allowed", async ({ page }) => {
    await pressButton(page, "slowDialog");
    await expectShown(page, /±30 m$/);
  });

  test("the page is hidden during the search and comes back (B12): shown", async ({ page }) => {
    await pressButton(page, "after3s");
    await page.waitForTimeout(500);
    const setHidden = (hidden: boolean) =>
      page.evaluate((value) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await setHidden(true);
    await page.waitForTimeout(1000);
    expect((await log(page)).openWatches).toBe(0); // no GPS while nobody looks
    await setHidden(false);
    await expectShown(page, /±30 m$/);
  });

  test("error details: the browser's own words are there, the coordinates are not (B5)", async ({ page }) => {
    await pressButton(page, "unavailable2");
    const notice = page.locator(".locate-notice");
    await expect(notice).toBeVisible(WITHIN);
    await notice.getByText("Detalles técnicos").click({ timeout: 5000 });
    await expect(notice).toContainText(CHROMIUM_NO_PROVIDER);
    await expect(notice).toContainText("2");
    await expect(notice.getByRole("link", { name: /Diagnóstico/ })).toHaveAttribute("href", "/diagnostico-ubicacion");
  });
});
