// MANUAL: the marker next to a place, for a person to look at.
//   make e2e-manual E2E_ARGS=locate-screens
// A simulated, generic position. Uses the test image as imagery: no internet.
import type { Route } from "@playwright/test";

import { expect, prepare, test } from "./fixtures";
import { apiPost } from "./helpers";

for (const { theme, width, height } of [
  { theme: "light", width: 390, height: 844 },
  { theme: "dark", width: 390, height: 844 },
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 1440, height: 900 },
] as const) {
  test(`marker and places (${theme}, ${width})`, async ({ page }) => {
    const here = { lat: 41.7 + Math.random() * 0.1, lon: -5.3 + Math.random() * 0.1 };
    await prepare(page, { theme, language: "es" });
    await page.setViewportSize({ width, height });
    const answer = (route: Route) =>
      route.fulfill({ path: "e2e/assets/tile.png", contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" } });
    await page.route("https://www.ign.es/**", answer);
    await page.context().grantPermissions(["geolocation"]);
    await page.context().setGeolocation({ latitude: here.lat, longitude: here.lon, accuracy: 60 });

    const ids: string[] = [];
    for (const [name, dLat, dLon] of [
      ["Lugar cercano", 0.0009, 0.0011],
      ["Otro lugar", -0.0012, -0.0008],
    ] as const) {
      const response = await apiPost(page.request, "/api/places", {
        name: `${name} ${Date.now()}`,
        latitude: here.lat + dLat,
        longitude: here.lon + dLon,
        confirm_distinct: true,
      });
      ids.push((await response.json()).id);
    }

    const shot = (name: string) => page.screenshot({ path: `test-results/screens/me-${name}-${theme}-${width}.png` });

    await page.goto(`/?view=map&lat=${here.lat.toFixed(5)}&lon=${here.lon.toFixed(5)}&z=15.00`);
    await expect(page.locator(".map-pin").first()).toBeVisible();
    await shot("off");
    await page.getByRole("button", { name: "Mostrar mi ubicación", exact: true }).click();
    await expect(page.locator(".map-me")).toBeVisible();
    await page.waitForTimeout(900);
    await shot("mapa");
    await page.getByRole("button", { name: "Capas", exact: true }).click();
    await page.getByRole("radio", { name: "Satélite" }).click();
    await page.waitForTimeout(900);
    await shot("satelite");
    await page.getByRole("button", { name: "Capas", exact: true }).click();
    await page.getByRole("radio", { name: "Mapa", exact: true }).click();

    // A selected place, the marker's closest look-alike.
    await page.locator(".map-pin").first().click();
    await page.waitForTimeout(900);
    await shot("seleccionado");
  });
}
