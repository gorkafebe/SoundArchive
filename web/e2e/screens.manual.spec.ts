// MANUAL: screenshots of the new screens, for a person to look at.
//   make e2e-manual E2E_ARGS=screens
// Saved as test-results/screens/new-*.png. Uses the stand-ins, not the internet.
import type { Page } from "@playwright/test";

import { expect, prepare, test } from "./fixtures";
import { createPlace } from "./helpers";

const SIZE = 0.003;
function spot() {
  const latIndex = Math.floor(37.1 / SIZE) + Math.floor(Math.random() * 100);
  const lonIndex = Math.floor(-3.4 / SIZE) + Math.floor(Math.random() * 100);
  return { lat: (latIndex + 0.5) * SIZE, lon: (lonIndex + 0.5) * SIZE };
}

async function tiles(page: Page) {
  const answer = (route: import("@playwright/test").Route) =>
    route.fulfill({ path: "e2e/assets/tile.png", contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } });
  await page.route("https://www.ign.es/**", answer);
}

for (const { theme, width, height } of [
  { theme: "light", width: 390, height: 844 },
  { theme: "dark", width: 390, height: 844 },
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 1440, height: 900 },
] as const) {
  const shot = (page: Page, name: string, fullPage = true) =>
    page.screenshot({ path: `test-results/screens/new-${name}-${theme}-${width}.png`, fullPage });

  test(`new screens (${theme}, ${width})`, async ({ page }) => {
    test.setTimeout(240_000);
    await prepare(page, { theme, language: "es" });
    await page.setViewportSize({ width, height });
    await tiles(page);
    const here = spot();
    await page.context().grantPermissions(["geolocation"]);

    // The first step.
    await page.goto("/");
    await page.getByRole("button", { name: "Añadir lugar" }).click();
    await expect(page.getByRole("button", { name: /Usar mi ubicación actual/ })).toBeVisible();
    await shot(page, "01-inicio");

    // A rough position.
    await page.context().setGeolocation({ latitude: here.lat, longitude: here.lon, accuracy: 240 });
    await page.getByRole("button", { name: /Usar mi ubicación actual/ }).click();
    await expect(page.getByText("La ubicación es aproximada", { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await shot(page, "02-aproximada");

    // Advanced, unfolded.
    await page.locator("details.add-place__advanced summary").click();
    await shot(page, "03-avanzado");
    await page.getByRole("button", { name: "Cancelar" }).click();

    // A precise position, then the suggestions.
    await page.context().setGeolocation({ latitude: here.lat, longitude: here.lon, accuracy: 5 });
    await page.getByRole("button", { name: "Añadir lugar" }).click();
    await page.getByRole("button", { name: /Usar mi ubicación actual/ }).click();
    await expect(page.getByText("Precisión: ±5 m")).toBeVisible();
    await page.getByRole("button", { name: "Elegir en el mapa" }).click();
    await page.waitForTimeout(800);
    await shot(page, "04-precisa");
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(page.getByRole("heading", { level: 3, name: "¿Es alguno de estos sitios?" })).toBeVisible();
    await shot(page, "05-sugerencias");

    // Create it, so the next one asks whether it is the same.
    await page.getByRole("button", { name: "Es este: Panadería Paco" }).click();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await page.getByRole("button", { name: "Crear el lugar" }).click();
    await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name: "Panadería Paco" })).toBeVisible();
    await page.getByRole("button", { name: "Añadir lugar" }).click();
    await page.getByRole("button", { name: /Usar mi ubicación actual/ }).click();
    await expect(page.getByText("Precisión: ±5 m")).toBeVisible();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(page.getByRole("heading", { level: 3, name: "¿Es el mismo lugar?" })).toBeVisible();
    await shot(page, "06-mismo-lugar");
    await page.getByRole("button", { name: "Cancelar" }).click();

    // The camera.
    const placeId = await createPlace(page.request, `Capturas ${Date.now()}`);
    await page.goto(`/?place=${placeId}`);
    await page.getByRole("button", { name: "Añadir una foto" }).click();
    await shot(page, "07-foto-opciones", false);
    await page.getByRole("button", { name: "Hacer una foto" }).click();
    await shot(page, "08-camara-explicacion", false);
    await page.getByRole("button", { name: "Activar la cámara" }).click();
    await expect(page.getByRole("button", { name: "Hacer foto", exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
    await shot(page, "09-camara-viva", false);
    await page.getByRole("button", { name: "Hacer foto", exact: true }).click();
    await expect(page.getByRole("button", { name: "Usar esta foto" })).toBeVisible();
    await shot(page, "10-camara-revisar", false);

    // Layers.
    await page.goto("/?view=map&lat=43.26300&lon=-2.93500&z=14.00");
    await expect(page.locator(".map-pin, .map-cluster").first()).toBeVisible();
    await page.getByRole("button", { name: "Capas", exact: true }).click();
    await shot(page, "11-capas", false);
    await page.getByRole("radio", { name: "Satélite" }).click();
    await page.waitForTimeout(800);
    await shot(page, "12-satelite", false);
    await page.getByRole("button", { name: "Capas", exact: true }).click();
    await page.getByRole("radio", { name: "Mapa", exact: true }).click();
  });
}
