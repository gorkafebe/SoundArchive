// The message of a failed search: every language, theme and width, and the
// keyboard. The position is simulated: no real location service is contacted.
import AxeBuilder from "@axe-core/playwright";

import { GEO_LAT, GEO_LON, GEO_SCENARIOS, installGeoScenario } from "../src/test/geoScenarios";
import { expect, prepare, test } from "./fixtures";

for (const { language, theme, width, height, show, details, retry } of [
  { language: "es", theme: "light", width: 390, height: 844, show: "Mostrar mi ubicación", details: "Detalles técnicos", retry: "Reintentar" },
  { language: "es", theme: "dark", width: 1440, height: 900, show: "Mostrar mi ubicación", details: "Detalles técnicos", retry: "Reintentar" },
  { language: "en", theme: "light", width: 1440, height: 900, show: "Show my location", details: "Technical details", retry: "Try again" },
  { language: "en", theme: "dark", width: 390, height: 844, show: "Show my location", details: "Technical details", retry: "Try again" },
] as const) {
  test(`the failure message (${language}, ${theme}, ${width})`, async ({ page }) => {
    await prepare(page, { language, theme });
    await page.addInitScript(installGeoScenario, GEO_SCENARIOS.unavailable2);
    await page.setViewportSize({ width, height });
    await page.goto(`/?view=map&lat=${GEO_LAT + 0.5}&lon=${GEO_LON + 0.7}&z=13.00`);
    await page.getByRole("button", { name: show, exact: true }).click();

    const notice = page.locator(".locate-notice");
    await expect(notice).toBeVisible({ timeout: 22_000 });
    await expect(notice).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Not under the map's other controls.
    const box = (await notice.boundingBox())!;
    const layers = (await page.locator(".layer-control__button").boundingBox())!;
    expect(box.x + box.width <= layers.x || box.y + box.height <= layers.y || box.y >= layers.y + layers.height).toBe(true);

    const summary = notice.getByText(details);
    const link = notice.getByRole("link");
    const again = notice.getByRole("button", { name: retry });

    // Reachable by keyboard, in reading order.
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(notice).toContainText("403");
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(again).toBeFocused();

    for (const control of [summary, link, again]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(notice).toBeInViewport();

    const audit = await new AxeBuilder({ page }).exclude(".maplibregl-marker:not(.map-me)").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

    // Pressing "retry" searches again and ends the same way.
    await again.click();
    await expect(notice).toBeVisible({ timeout: 22_000 });
  });
}
