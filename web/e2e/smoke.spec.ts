import { expect, prepare, test, waitForPins } from "./fixtures";

test("the map loads with WebGL and shows clustered places", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Over plain HTTP on a host other than localhost (here http://caddy, or
    // the MSI over Tailscale) Chromium ignores the COOP header and says so.
    // Harmless; it takes effect once the site has HTTPS.
    if (message.type() === "error" && !message.text().includes("Cross-Origin-Opener-Policy header has been ignored")) {
      errors.push(message.text());
    }
  });
  const { blocked } = await prepare(page);

  await page.goto("/?view=map&lat=40.5&lon=-2.5&z=5.5");
  await waitForPins(page);

  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  expect(webgl).toBe(true);
  await expect(page.locator(".map-cluster").first()).toBeVisible();
  await expect(page.locator(".maplibregl-ctrl-attrib")).toBeVisible();
  await expect(page.getByRole("link", { name: "© OpenStreetMap" })).toBeVisible();
  expect(errors).toEqual([]);
  expect(blocked).toEqual([]);
});
