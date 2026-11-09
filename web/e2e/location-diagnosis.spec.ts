// The location diagnosis in a browser. The position is simulated: no real
// location service is contacted.
import AxeBuilder from "@axe-core/playwright";

import { GEO_SCENARIOS, installGeoScenario } from "../src/test/geoScenarios";
import { expect, prepare, test } from "./fixtures";

for (const { language, theme, width, height, button, done } of [
  { language: "es", theme: "light", width: 390, height: 844, button: "Probar ahora", done: "Pruebas terminadas." },
  { language: "en", theme: "dark", width: 1440, height: 900, button: "Test now", done: "Tests finished." },
] as const) {
  test(`runs the three attempts and sends nothing (${language}, ${theme}, ${width})`, async ({ page }) => {
    await prepare(page, { language, theme });
    await page.addInitScript(installGeoScenario, GEO_SCENARIOS.highFails);
    await page.setViewportSize({ width, height });
    await page.goto("/diagnostico-ubicacion");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // From here on, the page must not ask the network for anything.
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const stored = await page.evaluate(() => Object.keys(localStorage).sort());

    const start = page.getByRole("button", { name: button });
    await start.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(done)).toBeVisible({ timeout: 20_000 });
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(stored);

    const report = await page.getByRole("textbox").inputValue();
    expect(report).toContain("T1");
    expect(report).toContain("403");
    expect(report).not.toContain("41.65");
    expect(report).not.toContain("0.88");
    expect(report).toContain("index-");
  });
}
