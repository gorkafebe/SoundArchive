// MANUAL check with the real basemap provider (internet needed). Not part of
// `make e2e`; run it on purpose with `make e2e-real-tiles`.
//
// It loads the app with the styles from /api/config as they are (OpenFreeMap
// by default) and checks that the style, tiles, fonts and icons are requested
// from the provider and load, that the Content-Security-Policy lets them
// through, and that the attribution is visible. The browser talks to the
// provider; nothing about the user is sent other than the normal requests a
// map makes (which area is being looked at). Screenshots go to
// test-results/screens/real-tiles-*.png.
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`real basemap (${theme})`, async ({ page }) => {
    const provider: { url: string; status: number }[] = [];
    const cspErrors: string[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== "http://caddy") {
        provider.push({ url: `${url.origin}${url.pathname}`, status: response.status() });
      }
    });
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) cspErrors.push(message.text());
    });
    await page.addInitScript((t) => localStorage.setItem("sa.theme", t), theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=map&lat=43.26300&lon=-2.93500&z=13.00");
    await expect(page.locator(".map-pin, .map-cluster").first()).toBeVisible();
    await page.waitForTimeout(4000); // let tiles, fonts and icons arrive

    const attribution = page.locator(".maplibregl-ctrl-attrib");
    await expect(attribution).toBeVisible();
    console.log(`[${theme}] attribution: ${(await attribution.innerText()).replace(/\s+/g, " ")}`);
    const summary = new Map<string, number[]>();
    for (const r of provider) {
      const key = r.url.replace(/\/\d+\/\d+\/\d+\.pbf$/, "/{z}/{x}/{y}.pbf").replace(/\/fonts\/.*$/, "/fonts/...");
      summary.set(key, [...(summary.get(key) ?? []), r.status]);
    }
    for (const [url, statuses] of summary) console.log(`[${theme}] ${statuses.length}x ${url} -> ${[...new Set(statuses)].join(",")}`);
    await page.screenshot({ path: `test-results/screens/real-tiles-${theme}.png` });

    expect(cspErrors).toEqual([]);
    expect(provider.some((r) => r.url.includes("/styles/") && r.status === 200)).toBe(true);
    expect(provider.some((r) => r.url.endsWith(".pbf") && r.status === 200)).toBe(true);
    await expect(attribution).toContainText("OpenStreetMap");
  });
}
