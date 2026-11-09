// The "where am I?" button. The position is simulated (a generic spot), the
// imagery comes from a file in the repository, and nothing reaches the internet.
import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";

import { expect, prepare, test } from "./fixtures";
import { apiPost } from "./helpers";

const COPY = {
  es: {
    show: "Mostrar mi ubicación",
    stop: "Dejar de mostrar mi ubicación",
    center: "Centrar en mi ubicación",
    accept: "Continuar",
    decline: "Ahora no",
    dialog: "Verte en el mapa",
    me: /^Tu ubicación, precisión ±\d+ m$/,
    denied: /tiene bloqueado el acceso a tu ubicación/,
    list: "Lista",
  },
  en: {
    show: "Show my location",
    stop: "Stop showing my location",
    center: "Centre on my location",
    accept: "Continue",
    decline: "Not now",
    dialog: "See yourself on the map",
    me: /^Your location, accuracy ±\d+ m$/,
    denied: /blocks access to your location/,
    list: "List",
  },
};

/** A generic point in open country, different on each run, away from other tests. */
function spot() {
  return { lat: 41.5 + Math.random() * 0.4, lon: -5.5 + Math.random() * 0.4 };
}

async function fakeTiles(page: Page) {
  const answer = (route: Route) =>
    route.fulfill({ path: "e2e/assets/tile.png", contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } });
  await page.route("https://www.ign.es/**", answer);
  await page.route("https://tiles.maps.eox.at/**", answer);
}

async function openMap(page: Page, where: { lat: number; lon: number }, language: "es" | "en" = "es") {
  // Start a little away from the person, so that being centred can be seen.
  await page.goto(`/?view=map&lat=${(where.lat + 0.02).toFixed(5)}&lon=${where.lon.toFixed(5)}&z=13.00`);
  await expect(page.getByRole("button", { name: COPY[language].show, exact: true })).toBeVisible();
  await expect(page.locator(".maplibregl-canvas").first()).toBeVisible();
}

async function grant(page: Page, where: { lat: number; lon: number }, accuracy = 5) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: where.lat, longitude: where.lon, accuracy });
}

async function turnOn(page: Page, language: "es" | "en" = "es") {
  await page.getByRole("button", { name: COPY[language].show, exact: true }).click();
  await expect(page.getByRole("button", { name: COPY[language].stop, exact: true })).toBeVisible();
}

const myMarker = (page: Page, language: "es" | "en" = "es") => page.getByRole("img", { name: COPY[language].me });

async function panAway(page: Page) {
  await page.locator(".maplibregl-canvas").first().focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
}

async function noSeriousAxe(page: Page) {
  // Pins go wherever the map puts them: the exception recorded in docs/ACCEPTANCE.md.
  const audit = await new AxeBuilder({ page }).exclude(".maplibregl-marker:not(.map-me)").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
}

async function createPlaceAt(page: Page, name: string, where: { lat: number; lon: number }) {
  const response = await apiPost(page.request, "/api/places", { name, latitude: where.lat, longitude: where.lon, confirm_distinct: true });
  expect(response.status()).toBe(201);
}

/** None of the corner controls may sit on another, and the credit stays visible. */
async function expectNoOverlap(page: Page) {
  const overlaps = await page.evaluate(() => {
    const items = [".locate-control__button", ".maplibregl-ctrl-attrib", ".map-add", ".layer-control__button", ".maplibregl-ctrl-group"]
      .map((selector) => ({ selector, box: document.querySelector(selector)?.getBoundingClientRect() }))
      .filter((item): item is { selector: string; box: DOMRect } => Boolean(item.box));
    const found: string[] = [];
    items.forEach((a, i) =>
      items.slice(i + 1).forEach((b) => {
        if (a.box.left < b.box.right && a.box.right > b.box.left && a.box.top < b.box.bottom && a.box.bottom > b.box.top) {
          found.push(`${a.selector} on ${b.selector}`);
        }
      }),
    );
    return found;
  });
  expect(overlaps).toEqual([]);
  await expect(page.locator(".maplibregl-ctrl-attrib").first()).toBeInViewport();
  await expect(page.locator(".locate-control__button")).toBeInViewport();
}

for (const { language, theme, width, height } of [
  { language: "es", theme: "light", width: 390, height: 844 },
  { language: "es", theme: "dark", width: 1440, height: 900 },
  { language: "en", theme: "light", width: 1440, height: 900 },
  { language: "en", theme: "dark", width: 390, height: 844 },
] as const) {
  test(`first time: explanation, then the marker; off again (${language}, ${theme}, ${width})`, async ({ page }) => {
    const here = spot();
    const copy = COPY[language];
    await prepare(page, { language, theme });
    await page.setViewportSize({ width, height });
    await openMap(page, here, language);

    const button = page.getByRole("button", { name: copy.show, exact: true });
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeGreaterThan(width * 0.8);
    expect(box.y + box.height).toBeGreaterThan(height * 0.7);
    await expectNoOverlap(page);
    await noSeriousAxe(page);

    await button.click();
    const dialog = page.getByRole("dialog", { name: copy.dialog });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: copy.accept })).toBeFocused();
    await expect(myMarker(page, language)).toHaveCount(0);
    await noSeriousAxe(page);

    await grant(page, here);
    await dialog.getByRole("button", { name: copy.accept }).click();
    await expect(page.getByRole("button", { name: copy.stop, exact: true })).toBeVisible();
    await expect(myMarker(page, language)).toBeVisible();
    await expectNoOverlap(page);
    await noSeriousAxe(page);

    // Not a place: not a button, not a pin, no Tab stop.
    await expect(page.locator(".map-me")).not.toHaveClass(/map-pin/);
    await expect(page.locator(".map-me")).not.toHaveAttribute("tabindex", /.*/);

    await page.getByRole("button", { name: copy.stop, exact: true }).click();
    await expect(page.getByRole("button", { name: copy.show, exact: true })).toBeVisible();
    await expect(myMarker(page, language)).toHaveCount(0);
  });
}

test("no second explanation once permission is granted", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await grant(page, here);
  await openMap(page, here);
  await page.getByRole("button", { name: COPY.es.show, exact: true }).click();
  await expect(myMarker(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("moved away: the button centres; centred: it turns off", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await grant(page, here);
  await openMap(page, here);
  await turnOn(page);

  await panAway(page);
  const center = page.getByRole("button", { name: COPY.es.center, exact: true });
  await expect(center).toBeVisible();
  await expect(myMarker(page)).toBeVisible();

  await center.click();
  const stop = page.getByRole("button", { name: COPY.es.stop, exact: true });
  await expect(stop).toBeVisible();
  await expect(myMarker(page)).toBeVisible();

  const box = (await page.locator(".map-me").boundingBox())!;
  const canvas = (await page.locator(".maplibregl-canvas").first().boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(26);

  await stop.click();
  await expect(myMarker(page)).toHaveCount(0);
});

test("refused: a clear message, and the rest of the app keeps working", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await page.context().clearPermissions();
  await openMap(page, here);
  await page.getByRole("button", { name: COPY.es.show, exact: true }).click();
  await page.getByRole("dialog", { name: COPY.es.dialog }).getByRole("button", { name: COPY.es.accept }).click();

  const notice = page.locator(".locate-notice");
  await expect(notice).toContainText(COPY.es.denied, { timeout: 15_000 });
  await expect(notice).toContainText(/abre los ajustes del sitio/);
  await expect(page.getByRole("button", { name: COPY.es.show, exact: true })).toHaveAttribute("aria-busy", "false");
  await page.screenshot({ path: "test-results/screens/locate-denied-es.png" });
  await noSeriousAxe(page);

  await page.getByRole("button", { name: "Cerrar" }).click();
  await expect(notice).toHaveCount(0);
  await page.getByRole("button", { name: COPY.es.list, exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Buscar lugares" })).toBeVisible();
});

test("the marker survives changes of layer and of theme, with places close by", async ({ page }) => {
  const here = spot();
  // No saved theme: it follows the system, so it can change with the map open.
  await prepare(page);
  await page.addInitScript(() => localStorage.setItem("sa.theme", "system"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeTiles(page);
  await grant(page, here, 80);
  await createPlaceAt(page, `Junto a mí ${Date.now()}`, { lat: here.lat + 0.0004, lon: here.lon + 0.0004 });
  await openMap(page, here);
  await turnOn(page);
  await expect(page.locator(".map-pin").first()).toBeVisible();

  const choose = async (name: string) => {
    await page.getByRole("button", { name: "Capas", exact: true }).click();
    await page.getByRole("radio", { name, exact: true }).click();
    await expect(myMarker(page)).toBeVisible();
  };
  for (let i = 0; i < 2; i++) {
    await choose("Satélite");
    await expect(page.locator(".map-view").first()).toHaveAttribute("data-imagery", "true");
    await choose("Mapa topográfico");
    await choose("Mapa");
    await expect(page.locator(".map-view").first()).toHaveAttribute("data-imagery", "false");
  }

  for (const value of ["dark", "light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: value });
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
    await expect(myMarker(page)).toBeVisible();
  }
  await expect(page.getByRole("button", { name: COPY.es.stop, exact: true })).toBeVisible();
  await expect(page.locator(".map-pin").first()).toBeVisible();
});

test("a click on a place underneath the marker opens that place", async ({ page }) => {
  const here = spot();
  const name = `Debajo de mí ${Date.now()}`;
  await prepare(page);
  await grant(page, here);
  await createPlaceAt(page, name, here);
  await openMap(page, here);
  await turnOn(page);
  await expect(myMarker(page)).toBeVisible();

  const pin = page.getByRole("button", { name, exact: true });
  await expect(pin).toBeVisible();
  // The point in the middle of the marker belongs to the pin, not to the marker.
  const topmost = await pin.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button")?.getAttribute("aria-label");
  });
  expect(topmost).toBe(name);
  await pin.click();
  await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(myMarker(page)).toBeVisible();
});

test("the marker never joins a cluster of places", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await grant(page, here);
  for (let i = 0; i < 3; i++) await createPlaceAt(page, `Grupo ${i} ${Date.now()}`, { lat: here.lat + i * 0.00002, lon: here.lon });
  await page.goto(`/?view=map&lat=${here.lat.toFixed(5)}&lon=${here.lon.toFixed(5)}&z=10.00`);
  await expect(page.locator(".map-cluster").first()).toBeVisible();
  const before = await page.locator(".map-cluster__count").first().innerText();
  await turnOn(page);
  // Centring zooms in to 16, so go back to where the group shows.
  await page.locator(".maplibregl-canvas").first().focus();
  await expect(myMarker(page)).toBeVisible();
  for (let i = 0; i < 18; i++) await page.keyboard.press("Minus");
  await expect(page.locator(".map-cluster").first()).toBeVisible();
  await expect(page.locator(".map-cluster__count").first()).toHaveText(before);
  await expect(myMarker(page)).toBeVisible();
});

test("with the tab hidden the tracking stops, and comes back", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await grant(page, here);
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    const watch = geo.watchPosition.bind(geo);
    const clear = geo.clearWatch.bind(geo);
    const live = new Set<number>();
    const page = window as unknown as { __liveWatches: () => number; __setHidden: (value: boolean) => void };
    geo.watchPosition = (ok, fail, options) => {
      const id = watch(ok, fail, options);
      live.add(id);
      return id;
    };
    geo.clearWatch = (id) => {
      live.delete(id);
      clear(id);
    };
    page.__liveWatches = () => live.size;
    let hidden = false;
    Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
    page.__setHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  const live = () => page.evaluate(() => (window as unknown as { __liveWatches: () => number }).__liveWatches());
  const setHidden = (value: boolean) => page.evaluate((v) => (window as unknown as { __setHidden: (x: boolean) => void }).__setHidden(v), value);

  await openMap(page, here);
  expect(await live()).toBe(0);
  await turnOn(page);
  await expect.poll(live).toBe(1);

  await setHidden(true);
  await expect.poll(live).toBe(0);
  await expect(myMarker(page)).toBeVisible();

  await setHidden(false);
  await expect.poll(live).toBe(1);
  await expect(page.getByRole("button", { name: COPY.es.stop, exact: true })).toBeVisible();

  // Going to the list counts as leaving the map: everything is turned off.
  await page.getByRole("button", { name: COPY.es.list, exact: true }).click();
  await expect.poll(live).toBe(0);
  await page.getByRole("button", { name: "Mapa", exact: true }).click();
  await expect(page.getByRole("button", { name: COPY.es.show, exact: true })).toBeVisible();
  await expect(myMarker(page)).toHaveCount(0);
});

test("the position goes nowhere: no request of its own, nothing stored, off after a reload", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await grant(page, here);
  await openMap(page, here);
  await page.waitForTimeout(600);

  const requests: { method: string; url: string; body: string | null }[] = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url(), body: request.postData() }));
  const before = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));

  await turnOn(page);
  await expect(myMarker(page)).toBeVisible();
  await page.waitForTimeout(1500);

  // Moving the map to you loads that area's pins, like any other move of the
  // map: the rectangle on screen is all those requests carry.
  const own = requests.filter((request) => !/\/api\/places\?bbox=/.test(request.url) && !/^data:|^blob:/.test(request.url));
  expect(own).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  for (const digits of [here.lat.toFixed(4), here.lon.toFixed(4)]) {
    expect(requests.filter((request) => `${request.url}${request.body ?? ""}`.includes(digits))).toEqual([]);
  }

  expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).toBe(before);

  await page.reload();
  await expect(page.getByRole("button", { name: COPY.es.show, exact: true })).toBeVisible();
  await expect(myMarker(page)).toHaveCount(0);
});

test("from the keyboard alone: reach it, turn it on, hear it, turn it off", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await grant(page, here);
  await openMap(page, here);
  await page.locator("body").press("Tab");
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    reached = await page.evaluate((name) => document.activeElement?.getAttribute("aria-label") === name, COPY.es.show);
    if (!reached) await page.keyboard.press("Tab");
  }
  expect(reached).toBe(true);
  await page.keyboard.press("Enter");
  const stop = page.getByRole("button", { name: COPY.es.stop, exact: true });
  await expect(stop).toBeVisible();
  await expect(page.locator(".locate-live")).toContainText("Ubicación encontrada");
  await expect(stop).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: COPY.es.show, exact: true })).toBeFocused();
  await expect(myMarker(page)).toHaveCount(0);
});

test("a rough position is marked as approximate", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await grant(page, here, 1800);
  await openMap(page, here);
  await page.getByRole("button", { name: COPY.es.show, exact: true }).click();
  await expect(page.getByText(/Ubicación aproximada/)).toBeVisible({ timeout: 15_000 });
  await expect(myMarker(page)).toBeVisible();
});

test("the corner stays tidy with the long satellite credit on a phone", async ({ page }) => {
  const here = spot();
  await prepare(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeTiles(page);
  await grant(page, here);
  await openMap(page, here);
  await page.getByRole("button", { name: "Capas", exact: true }).click();
  await page.getByRole("radio", { name: "Satélite" }).click();
  await turnOn(page);
  await expect(page.locator(".maplibregl-ctrl-attrib").first()).toContainText("Instituto Geográfico");
  await expectNoOverlap(page);
});

test("the headers are the same: geolocation for this site, nothing wider", async ({ page }) => {
  const policy = (await page.request.get("/")).headers()["permissions-policy"];
  expect(policy).toBe("microphone=(self), geolocation=(self), camera=(self), screen-wake-lock=(self), payment=(), usb=()");
});
