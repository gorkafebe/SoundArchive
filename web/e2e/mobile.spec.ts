// The phone, emulated: 390 x 844, touch, in both orientations. A real phone
// has not been tested; see docs/PHONE_SETUP.md for what to check there.
import type { Page } from "@playwright/test";

import { MEDIA } from "./constants";
import { expect, pastKnownPlaces, prepare, test } from "./fixtures";
import { audioTime, createPlace, uploadAudio } from "./helpers";

/** Every visible control is at least 44 x 44 px. */
async function checkTargets(page: Page, where: string) {
  const small = await page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, label:has(input[type=radio])")];
    return items
      .filter((element) => {
        if (element.closest(".maplibregl-ctrl-attrib, .visually-hidden")) return false;
        if (element.matches("input[type=radio], input[type=file], label input[type=checkbox]")) return false;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return box.height < 43.5 || box.width < 43.5;
      })
      .map((element) => `${element.tagName} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}" ${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)}`);
  });
  expect(small, `controls under 44 px in ${where}`).toEqual([]);
}

test("place sheet: dragged by touch through its heights", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "En el móvil");
  await page.goto(`/?place=${placeId}`);
  const handle = page.locator(".place-sheet__handle");
  await expect(handle).toBeVisible();
  const sheet = page.locator(".place-sheet");
  await expect(sheet).toHaveClass(/place-sheet--half/);

  // A drag dispatched as pointer events, as a finger produces them.
  await handle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const fire = (type: string, y: number) =>
      element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "touch", clientX: box.x + 20, clientY: y }));
    fire("pointerdown", box.y + 10);
    fire("pointermove", 120);
    fire("pointerup", 120);
  });
  await expect(sheet).toHaveClass(/place-sheet--full/);
  await page.screenshot({ path: "test-results/screens/mobile-sheet-full.png" });
  await checkTargets(page, "place sheet");
});

test("list view and map are usable at 390 px, in both orientations", async ({ page }) => {
  await prepare(page);
  await page.goto("/?view=list");
  await expect(page.locator(".place-list__item").first()).toBeVisible();
  await checkTargets(page, "list");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".place-list__item").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/screens/mobile-landscape-list.png" });

  await page.goto("/");
  await expect(page.locator(".maplibregl-ctrl-attrib")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/mobile-landscape-map.png" });
});

test("recording and listening work by touch", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Toque");
  await page.goto(`/record?place=${placeId}`);
  await page.getByRole("button", { name: "Continuar" }).tap();
  await expect(page.getByTestId("meter")).toBeVisible();
  await checkTargets(page, "record, ready");
  await page.getByRole("button", { name: "Empezar a grabar" }).tap();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Detener la grabación" }).tap();
  await page.getByLabel("Título").fill("Desde el teléfono");
  await checkTargets(page, "record, review");
  await page.getByRole("button", { name: "Publicar" }).tap();
  await expect(page).toHaveURL(/\/recordings\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  await checkTargets(page, "recording page");
  await page.locator(".player-top").getByRole("button", { name: /^Reproducir/ }).tap();
  await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(0.2);
  await expect(page.getByTestId("mini-player")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/mobile-recording.png", fullPage: true });
});

test("upload, ambient and compare screens fit and have large targets", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Pantallas");
  await uploadAudio(page.request, placeId, "tone-a.wav", "Primera", { recorded_at: "2024-06-08T10:00:00Z" });
  const second = await uploadAudio(page.request, placeId, "tone-b.wav", "Segunda");

  for (const [where, url] of [
    ["ambient", `/recordings/${second}/ambient`],
    ["compare", `/places/${placeId}/compare`],
    ["upload", `/upload?place=${placeId}`],
    ["account", "/account"],
    ["admin", "/admin"],
  ] as const) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (where === "upload") await page.getByTestId("file-input").setInputFiles(`${MEDIA}/short.wav`);
    await checkTargets(page, where);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), `overflow in ${where}`).toBe(false);
    await page.screenshot({ path: `test-results/screens/mobile-${where}.png`, fullPage: true });
  }
});

test("adding a place from the location, on a phone", async ({ page }) => {
  await prepare(page);
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 42.31, longitude: -2.31, accuracy: 5 });
  await page.goto("/");
  await page.getByRole("button", { name: "Añadir lugar" }).click();
  await expect(page.getByRole("button", { name: /Usar mi ubicación actual/ })).toBeVisible();
  await checkTargets(page, "add place, first step");
  await page.screenshot({ path: "test-results/screens/add-first-390.png", fullPage: true });
  await page.getByRole("button", { name: /Usar mi ubicación actual/ }).click();
  await expect(page.getByText("Precisión: ±5 m")).toBeVisible();
  await expect(page.locator(".location-picker canvas")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/add-located-390.png", fullPage: true });
  await page.getByRole("button", { name: "Siguiente" }).click();
  await pastKnownPlaces(page);
  await page.getByRole("textbox", { name: "Nombre", exact: true }).fill(`Móvil ${Date.now()}`);
  await page.getByRole("button", { name: "Siguiente" }).click();
  await page.getByRole("button", { name: "Crear el lugar" }).click();
  await expect(page.locator(".place-sheet")).toBeVisible();
});

test("the camera on a phone opens straight from the field", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, `Foto móvil ${Date.now()}`);
  await page.goto(`/?place=${placeId}`);
  await page.getByRole("button", { name: "Añadir una foto" }).click();
  const input = page.getByTestId("camera-input");
  await expect(input).toHaveAttribute("capture", "environment");
  await expect(input).toHaveAttribute("accept", "image/*");
  await expect(page.getByText("Hacer una foto", { exact: true })).toBeVisible();
  await checkTargets(page, "photo form");

  // If capture is ignored it is an ordinary file field: the upload still works.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
    "base64",
  );
  await input.setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("img", { name: "Foto lista para añadir" })).toBeVisible();
  await page.locator("form.photo-form").getByRole("button", { name: "Añadir una foto" }).click();
  await expect(page.locator(".photo-strip__item img")).toBeVisible();
});

test("the layer selector fits on a phone", async ({ page }) => {
  await prepare(page);
  await page.route("https://www.ign.es/**", (route) =>
    route.fulfill({ path: "e2e/assets/tile.png", contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } }),
  );
  await page.goto("/?view=map&lat=43.26300&lon=-2.93500&z=14.00");
  await expect(page.locator(".map-pin, .map-cluster").first()).toBeVisible();
  await page.getByRole("button", { name: "Capas", exact: true }).click();
  await checkTargets(page, "layer selector");
  await page.screenshot({ path: "test-results/screens/layers-open-390.png" });
  await page.getByRole("radio", { name: "Satélite" }).click();
  await expect(page.locator(".maplibregl-ctrl-attrib").first()).toContainText("PNOA cedido");
  await expect(page.locator(".maplibregl-ctrl-attrib").first()).toBeInViewport();
});
