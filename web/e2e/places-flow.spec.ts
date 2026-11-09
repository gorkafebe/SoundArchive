// Adding a place from the current location: suggestions, duplicates, and what
// happens when the outside service misbehaves. The real API talks to a local
// stand-in for Overpass (infra/e2e/overpass-mock.py): nothing reaches the internet.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, openAdvanced, prepare, test } from "./fixtures";

const MOCK = "http://sa-e2e-overpass-mock:8080";
const SIZE = 0.003;

/** The middle of a random grid cell, inside the area the stand-in serves. */
function spot() {
  const latIndex = Math.floor(37.1 / SIZE) + Math.floor(Math.random() * 100);
  const lonIndex = Math.floor(-3.4 / SIZE) + Math.floor(Math.random() * 100);
  return { lat: (latIndex + 0.5) * SIZE, lon: (lonIndex + 0.5) * SIZE };
}

const COPY = {
  es: {
    add: "Añadir lugar",
    useMine: /Usar mi ubicación actual/,
    accuracy: "Precisión: ±5 m",
    next: "Siguiente",
    sitesTitle: "¿Es alguno de estos sitios?",
    pickPaco: "Es este: Panadería Paco",
    none: "Ninguno de estos",
    sameTitle: "¿Es el mismo lugar?",
    distinct: "No, es un lugar distinto",
    name: "Nombre",
    create: "Crear el lugar",
    attribution: "© colaboradores de OpenStreetMap",
    toggle: "Sugerir sitios de OpenStreetMap",
  },
  en: {
    add: "Add place",
    useMine: /Use my current location/,
    accuracy: "Accuracy: ±5 m",
    next: "Next",
    sitesTitle: "Is it one of these sites?",
    pickPaco: "This one: Panadería Paco",
    none: "None of these",
    sameTitle: "Is it the same place?",
    distinct: "No, it is a different place",
    name: "Name",
    create: "Create place",
    attribution: "© OpenStreetMap contributors",
    toggle: "Suggest sites from OpenStreetMap",
  },
};

async function calls(page: Page): Promise<number> {
  return (await (await page.request.get(`${MOCK}/__calls`)).json()).calls;
}

async function setMode(page: Page, mode: "ok" | "down" | "slow") {
  await page.request.get(`${MOCK}/__mode?m=${mode}`);
}

async function locateAt(page: Page, where: { lat: number; lon: number }) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: where.lat, longitude: where.lon, accuracy: 5 });
}

async function nearbyCount(page: Page, where: { lat: number; lon: number }): Promise<number> {
  const response = await page.request.get(`/api/places/nearby?lat=${where.lat}&lon=${where.lon}&radius=100`);
  return (await response.json()).items.length;
}

async function startAndLocate(page: Page, language: "es" | "en" = "es") {
  const copy = COPY[language];
  await page.goto("/");
  await page.getByRole("button", { name: copy.add }).click();
  await page.getByRole("button", { name: copy.useMine }).click();
  await expect(page.getByText(copy.accuracy)).toBeVisible();
  await page.getByRole("button", { name: copy.next }).click();
}

async function finishWithName(page: Page, name: string, language: "es" | "en" = "es") {
  const copy = COPY[language];
  await page.getByRole("textbox", { name: copy.name, exact: true }).fill(name);
  await page.getByRole("button", { name: copy.next }).click();
  await page.getByRole("button", { name: copy.create }).click();
  await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name })).toBeFocused();
}

test.afterEach(async ({ page }) => {
  await setMode(page, "ok");
});

for (const { language, theme, width, height } of [
  { language: "es", theme: "light", width: 390, height: 844 },
  { language: "es", theme: "dark", width: 1440, height: 900 },
  { language: "en", theme: "light", width: 1440, height: 900 },
  { language: "en", theme: "dark", width: 390, height: 844 },
] as const) {
  test(`a suggested site fills the name and keeps its reference (${language}, ${theme}, ${width})`, async ({ page }) => {
    const here = spot();
    const copy = COPY[language];
    await prepare(page, { language, theme });
    await page.setViewportSize({ width, height });
    await locateAt(page, here);
    await startAndLocate(page, language);

    await expect(page.getByRole("heading", { level: 3, name: copy.sitesTitle })).toBeVisible();
    await expect(page.getByRole("link", { name: copy.attribution })).toBeVisible();
    await page.screenshot({ path: `test-results/screens/suggest-${language}-${theme}-${width}.png`, fullPage: true });
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

    await page.getByRole("button", { name: copy.pickPaco }).click();
    const name = page.getByRole("textbox", { name: copy.name, exact: true });
    await expect(name).toHaveValue("Panadería Paco");
    await page.getByRole("button", { name: copy.next }).click();
    await page.getByRole("button", { name: copy.create }).click();
    await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name: "Panadería Paco" })).toBeFocused();

    const nearby = await (await page.request.get(`/api/places/nearby?lat=${here.lat}&lon=${here.lon}`)).json();
    const place = await (await page.request.get(`/api/places/${nearby.items[0].id}`)).json();
    expect(place.external_source).toBe("osm");
    expect(place.external_id).toMatch(/^node\/\d+$/);
  });
}

test("the same spot again: yes opens the one that exists, no creates another", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await locateAt(page, here);

  // The first place, from the suggestion.
  await startAndLocate(page);
  await page.getByRole("button", { name: COPY.es.pickPaco }).click();
  await page.getByRole("button", { name: COPY.es.next }).click();
  await page.getByRole("button", { name: COPY.es.create }).click();
  await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name: "Panadería Paco" })).toBeFocused();
  expect(await nearbyCount(page, here)).toBe(1);

  // "Yes, this one": its panel opens, nothing is created.
  await startAndLocate(page);
  await expect(page.getByRole("heading", { level: 3, name: COPY.es.sameTitle })).toBeFocused();
  await page.screenshot({ path: "test-results/screens/same-place-es.png", fullPage: true });
  await page.getByRole("button", { name: "Sí, es este: Panadería Paco" }).click();
  await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name: "Panadería Paco" })).toBeVisible();
  expect(await nearbyCount(page, here)).toBe(1);

  // "No": the site already used is no longer offered, the other one is.
  await startAndLocate(page);
  await page.getByRole("button", { name: COPY.es.distinct }).click();
  await expect(page.getByRole("heading", { level: 3, name: COPY.es.sitesTitle })).toBeVisible();
  await expect(page.getByRole("button", { name: "Es este: Panadería Paco" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Es este: Café Central" })).toBeVisible();
  await page.getByRole("button", { name: COPY.es.none }).click();
  await finishWithName(page, `E2E distinto ${Date.now()}`);
  expect(await nearbyCount(page, here)).toBe(2);
});

test("a 409 at the last moment asks the question there, and nothing typed is lost", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await locateAt(page, here);
  await startAndLocate(page);
  await page.getByRole("button", { name: COPY.es.none }).click();
  const name = `E2E carrera ${Date.now()}`;
  await page.getByRole("textbox", { name: "Nombre", exact: true }).fill(name);
  await page.getByRole("button", { name: COPY.es.next }).click();

  // Someone else creates a place on that spot in the meantime.
  const csrf = (await (await page.request.get("/api/auth/me")).json()).csrf_token;
  const other = await page.request.post("/api/places", {
    headers: { "X-CSRF-Token": csrf, Origin: new URL(page.url()).origin },
    data: { name: "Otro más rápido", latitude: here.lat, longitude: here.lon },
  });
  expect(other.status()).toBe(201);

  await page.getByRole("button", { name: COPY.es.create }).click();
  await expect(page.getByRole("heading", { level: 3, name: COPY.es.sameTitle })).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
  await page.getByRole("button", { name: COPY.es.distinct }).click();
  await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name })).toBeFocused();
  expect(await nearbyCount(page, here)).toBe(2);
});

for (const mode of ["down", "slow"] as const) {
  test(`with the outside service ${mode}, a place can still be added`, async ({ page }) => {
    const here = spot();
    await prepare(page);
    await setMode(page, mode);
    await locateAt(page, here);
    await startAndLocate(page);
    await expect(page.getByRole("textbox", { name: "Nombre", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await finishWithName(page, `E2E sin sugerencias ${mode} ${Date.now()}`);
  });
}

test("the switch off: nothing is asked outside, and it is remembered", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await locateAt(page, here);
  await page.goto("/");
  await page.getByRole("button", { name: COPY.es.add }).click();
  const box = page.getByRole("checkbox", { name: COPY.es.toggle });
  await expect(box).toBeChecked();
  await box.uncheck();

  const before = await calls(page);
  await page.getByRole("button", { name: COPY.es.useMine }).click();
  await expect(page.getByText(COPY.es.accuracy)).toBeVisible();
  await page.getByRole("button", { name: COPY.es.next }).click();
  await expect(page.getByRole("textbox", { name: "Nombre", exact: true })).toBeVisible();
  expect(await calls(page)).toBe(before);

  await page.reload();
  await page.getByRole("button", { name: COPY.es.add }).click();
  await expect(page.getByRole("checkbox", { name: COPY.es.toggle })).not.toBeChecked();
});

test("the position sent to the outside is the cell, not the point", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await locateAt(page, { lat: here.lat + 0.000213, lon: here.lon - 0.000177 });
  await startAndLocate(page);
  await expect(page.getByRole("heading", { level: 3, name: COPY.es.sitesTitle })).toBeVisible();
  const { last } = await (await page.request.get(`${MOCK}/__calls`)).json();
  expect(last).toContain("[bbox:");
  expect(last).not.toContain((here.lat + 0.000213).toFixed(5));
  expect(last).not.toContain((here.lon - 0.000177).toFixed(5));
});

test("location refused: the state is shown and the map comes forward", async ({ page }) => {
  await prepare(page);
  await page.context().clearPermissions();
  await page.goto("/");
  await page.getByRole("button", { name: COPY.es.add }).click();
  await page.getByRole("button", { name: COPY.es.useMine }).click();
  await expect(page.getByText(/tiene bloqueado el acceso a tu ubicación/)).toBeVisible();
  await expect(page.locator(".location-picker canvas")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/location-denied-es.png", fullPage: true });
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("the coordinates still work, the keyboard way", async ({ page }) => {
  await prepare(page);
  await page.goto("/");
  await page.getByRole("button", { name: COPY.es.add }).click();
  await openAdvanced(page);
  await page.getByLabel("Latitud").fill("42,5000");
  await page.getByLabel("Longitud").fill("-2,8000");
  await page.getByRole("button", { name: COPY.es.next }).click();
  await expect(page.getByRole("textbox", { name: "Nombre", exact: true })).toBeVisible();
});

/** Press Tab until the focused element's name matches. */
async function tabTo(page: Page, name: RegExp) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return element.getAttribute("aria-label") ?? element.textContent ?? "";
    });
    if (name.test(label.trim())) return;
  }
  throw new Error(`Tab never reached ${name}`);
}

test("the whole flow from the keyboard alone: location, not the same place, a site, create", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await locateAt(page, here);
  await page.goto("/");
  const csrf = (await (await page.request.get("/api/auth/me")).json()).csrf_token;
  const first = await page.request.post("/api/places", {
    headers: { "X-CSRF-Token": csrf, Origin: new URL(page.url()).origin },
    data: { name: "Ya estaba", latitude: here.lat, longitude: here.lon },
  });
  expect(first.status()).toBe(201);

  await tabTo(page, /^Añadir lugar$/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2 })).toBeFocused();
  await tabTo(page, /^Usar mi ubicación actual/);
  await page.keyboard.press("Enter");
  await expect(page.getByText(COPY.es.accuracy)).toBeVisible();
  await tabTo(page, /^Siguiente$/);
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 3, name: COPY.es.sameTitle })).toBeFocused();
  await tabTo(page, /^No, es un lugar distinto$/);
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 3, name: COPY.es.sitesTitle })).toBeFocused();
  await tabTo(page, /^Es este: Café Central$/);
  await page.keyboard.press("Enter");

  const name = page.getByRole("textbox", { name: "Nombre", exact: true });
  await expect(name).toHaveValue("Café Central");
  await tabTo(page, /^Siguiente$/);
  await page.keyboard.press("Enter");
  await tabTo(page, /^Crear el lugar$/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name: "Café Central" })).toBeFocused();
  expect(await nearbyCount(page, here)).toBe(2);
});
