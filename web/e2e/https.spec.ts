// The site over real HTTPS: the browser's own validation accepts the private
// CA (no "ignore certificate errors" anywhere), which is what makes it a
// secure context, the condition for the microphone and geolocation.
import { expect, prepare, test } from "./fixtures";

test("HTTPS is trusted and the page is a secure context", async ({ page }) => {
  await prepare(page); // no request leaves for the real tile server
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).protocol).toBe("https:");
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  expect(await page.evaluate(() => typeof navigator.mediaDevices?.getUserMedia)).toBe("function");
});

test("security headers are present on the page", async ({ page }) => {
  await prepare(page); // no request leaves for the real tile server
  const response = await page.goto("/");
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("same-origin");
  expect(headers["permissions-policy"]).toContain("microphone=(self)");
  expect(headers["permissions-policy"]).toContain("geolocation=(self)");
  // HSTS stays off on purpose: see infra/caddy/Caddyfile.tailnet.
  expect(headers["strict-transport-security"]).toBeUndefined();
  expect(headers.server).toBeUndefined();
});
