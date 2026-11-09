// MANUAL: the failure message and the diagnosis screen, for a person to look at.
//   make e2e-manual E2E_ARGS=diagnosis-screens
// A simulated position. No internet.
import { GEO_LAT, GEO_LON, GEO_SCENARIOS, installGeoScenario } from "../src/test/geoScenarios";
import { expect, prepare, test } from "./fixtures";

for (const { theme, width, height } of [
  { theme: "light", width: 390, height: 844 },
  { theme: "dark", width: 390, height: 844 },
  { theme: "light", width: 1440, height: 900 },
] as const) {
  test(`failure message and diagnosis (${theme}, ${width})`, async ({ page }) => {
    await prepare(page, { theme, language: "es" });
    await page.addInitScript(installGeoScenario, GEO_SCENARIOS.highFails);
    await page.setViewportSize({ width, height });

    await page.goto("/diagnostico-ubicacion");
    await page.getByRole("button", { name: "Probar ahora" }).click();
    await expect(page.getByText("Pruebas terminadas.")).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `test-results/screens/diagnostico-${theme}-${width}.png`, fullPage: true });
  });

  test(`the button's failure message (${theme}, ${width})`, async ({ page }) => {
    await prepare(page, { theme, language: "es" });
    await page.addInitScript(installGeoScenario, GEO_SCENARIOS.unavailable2);
    await page.setViewportSize({ width, height });
    await page.goto(`/?view=map&lat=${GEO_LAT + 0.5}&lon=${GEO_LON + 0.7}&z=13.00`);
    await page.getByRole("button", { name: "Mostrar mi ubicación", exact: true }).click();
    const notice = page.locator(".locate-notice");
    await expect(notice).toBeVisible({ timeout: 22_000 });
    await notice.getByText("Detalles técnicos").click();
    await page.screenshot({ path: `test-results/screens/error-${theme}-${width}.png` });
  });

  test(`a very approximate position (${theme}, ${width})`, async ({ page }) => {
    await prepare(page, { theme, language: "es" });
    await page.addInitScript(installGeoScenario, GEO_SCENARIOS.byIp);
    await page.setViewportSize({ width, height });
    await page.goto(`/?view=map&lat=${GEO_LAT + 0.5}&lon=${GEO_LON + 0.7}&z=13.00`);
    await page.getByRole("button", { name: "Mostrar mi ubicación", exact: true }).click();
    await expect(page.getByText(/muy aproximada/)).toBeVisible({ timeout: 22_000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `test-results/screens/aproximada-${theme}-${width}.png` });
  });
}
