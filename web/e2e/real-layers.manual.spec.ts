// @real: MANUAL check with the real imagery providers (internet needed). Not
// part of `make e2e`; run it on purpose:  make e2e-manual E2E_ARGS=real-layers
//
// The real style, the real tiles and the real Content-Security-Policy of Caddy:
// if CORS or a domain were wrong, this is where it would show. A few tiles of a
// city centre are requested, and nothing about any person other than the normal
// requests a map makes. Screenshots: test-results/screens/real-*.png
import { expect, test, type Page } from "@playwright/test";

function watch(page: Page) {
  const seen: { host: string; status: number; type: string }[] = [];
  const csp: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.hostname === "www.ign.es" || url.hostname === "tiles.maps.eox.at") {
      seen.push({ host: url.hostname, status: response.status(), type: response.headers()["content-type"] ?? "" });
    }
  });
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) csp.push(message.text());
  });
  return { seen, csp };
}

async function choose(page: Page, name: string) {
  await page.getByRole("button", { name: "Capas", exact: true }).click();
  await page.getByRole("radio", { name, exact: true }).click();
}

for (const { theme, width, height } of [
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 390, height: 844 },
  { theme: "dark", width: 1440, height: 900 },
  { theme: "light", width: 390, height: 844 },
] as const) {
  test(`@real IGN imagery under the real CSP (${theme}, ${width})`, async ({ page }) => {
    const { seen, csp } = watch(page);
    await page.addInitScript((value) => localStorage.setItem("sa.theme", value), theme);
    await page.addInitScript(() => localStorage.setItem("sa.language", "es"));
    await page.setViewportSize({ width, height });
    // The example places around central Madrid: pins and clusters to look at.
    await page.goto("/?view=map&lat=40.41700&lon=-3.70300&z=13.50");
    await expect(page.locator(".map-pin, .map-cluster").first()).toBeVisible();
    await page.waitForTimeout(1500);
    expect(seen, "nothing asked of the IGN before choosing").toEqual([]);

    await choose(page, "Satélite");
    await expect.poll(() => seen.filter((r) => r.status === 200).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `test-results/screens/real-ign-${theme}-${width}.png` });

    expect(csp).toEqual([]);
    expect(new Set(seen.map((r) => r.host))).toEqual(new Set(["www.ign.es"]));
    expect(seen.every((r) => r.type.startsWith("image/"))).toBe(true);
    await expect(page.locator(".maplibregl-ctrl-attrib").first()).toContainText("PNOA cedido por © Instituto Geográfico Nacional");
    const statuses = [...new Set(seen.map((r) => r.status))].join(",");
    console.log(`[${theme} ${width}] ${seen.length} tiles from www.ign.es, status ${statuses}`);
  });
}

test("@real EOX imagery outside Spain", async ({ page }) => {
  const { seen, csp } = watch(page);
  await page.addInitScript(() => localStorage.setItem("sa.language", "es"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?view=map&lat=45.76000&lon=4.84000&z=9.00");
  await page.waitForTimeout(1500);
  await choose(page, "Satélite");
  await expect.poll(() => seen.filter((r) => r.host === "tiles.maps.eox.at" && r.status === 200).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "test-results/screens/real-eox-1440.png" });
  expect(csp).toEqual([]);
  expect(seen.filter((r) => r.host === "www.ign.es")).toEqual([]);
  await expect(page.locator(".maplibregl-ctrl-attrib").first()).toContainText("Copernicus Sentinel data 2025");
  console.log(`EOX: ${seen.length} tiles, status ${[...new Set(seen.map((r) => r.status))].join(",")}`);
});

test("@real the topographic map", async ({ page }) => {
  const { seen, csp } = watch(page);
  await page.addInitScript(() => localStorage.setItem("sa.language", "es"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?view=map&lat=40.41700&lon=-3.70300&z=13.50");
  await expect(page.locator(".map-pin, .map-cluster").first()).toBeVisible();
  await choose(page, "Mapa topográfico");
  await expect.poll(() => seen.filter((r) => r.status === 200).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "test-results/screens/real-topo-1440.png" });
  expect(csp).toEqual([]);
});
