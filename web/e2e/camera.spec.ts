// A photo from the camera. Chromium's fake camera provides the picture; the
// app, the upload and the re-encoding on the server are the real ones.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, prepare, test } from "./fixtures";
import { createPlace } from "./helpers";

/** Remember every stream the page asks for, to check that they are stopped. */
async function watchStreams(page: Page) {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const streams: MediaStream[] = [];
    (window as unknown as { __streams: MediaStream[] }).__streams = streams;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      streams.push(stream);
      return stream;
    };
  });
}

const liveTracks = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __streams: MediaStream[] }).__streams
      .flatMap((stream) => stream.getTracks())
      .filter((track) => track.readyState === "live").length,
  );

const streamCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length);

for (const { language, theme, width, height, words } of [
  {
    language: "es",
    theme: "light",
    width: 1440,
    height: 900,
    words: { add: "Añadir una foto", takeOne: "Hacer una foto", on: "Activar la cámara", take: "Hacer foto", repeat: "Repetir", use: "Usar esta foto" },
  },
  {
    language: "en",
    theme: "dark",
    width: 1440,
    height: 900,
    words: { add: "Add a photo", takeOne: "Take a photo", on: "Turn on the camera", take: "Take photo", repeat: "Repeat", use: "Use this photo" },
  },
] as const) {
  test(`take, repeat and use a photo; the camera ends up off (${language}, ${theme})`, async ({ page }) => {
    await prepare(page, { language, theme });
    await page.setViewportSize({ width, height });
    await watchStreams(page);
    const placeId = await createPlace(page.request, `Con cámara ${Date.now()}`);
    await page.goto(`/?place=${placeId}`);

    await page.getByRole("button", { name: words.add }).click();
    await page.getByRole("button", { name: words.takeOne }).click();
    expect(await streamCount(page)).toBe(0); // nothing until the explained tap
    await page.screenshot({ path: `test-results/screens/camera-intro-${language}.png` });

    await page.getByRole("button", { name: words.on }).click();
    const take = page.getByRole("button", { name: words.take, exact: true });
    await expect(take).toBeVisible();
    expect(await liveTracks(page)).toBeGreaterThan(0);
    await expect
      .poll(() => page.locator("video.photo-camera__frame").evaluate((video: HTMLVideoElement) => video.videoWidth))
      .toBeGreaterThan(0);
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

    await take.click();
    await page.getByRole("button", { name: words.use }).waitFor();
    expect(await liveTracks(page)).toBe(0);

    await page.getByRole("button", { name: words.repeat }).click();
    await expect(take).toBeVisible();
    await expect
      .poll(() => page.locator("video.photo-camera__frame").evaluate((video: HTMLVideoElement) => video.videoWidth))
      .toBeGreaterThan(0);
    await take.click();
    await page.getByRole("button", { name: words.use }).click();
    expect(await liveTracks(page)).toBe(0);

    await page.locator("form.photo-form").getByRole("button", { name: words.add }).click();
    await expect(page.locator(".photo-strip__item img")).toBeVisible();

    const photos = await (await page.request.get(`/api/places/${placeId}/photos`)).json();
    expect(photos).toHaveLength(1);
    const served = await page.request.get(`/api/photos/${photos[0].id}/large`);
    const bytes = await served.body();
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(bytes.includes(Buffer.from("Exif"))).toBe(false);
  });
}

test("leaving the place stops the camera", async ({ page }) => {
  await prepare(page);
  await watchStreams(page);
  const placeId = await createPlace(page.request, `Camara y salir ${Date.now()}`);
  await page.goto(`/?place=${placeId}`);
  await page.getByRole("button", { name: "Añadir una foto" }).click();
  await page.getByRole("button", { name: "Hacer una foto" }).click();
  await page.getByRole("button", { name: "Activar la cámara" }).click();
  await expect(page.getByRole("button", { name: "Hacer foto", exact: true })).toBeVisible();
  expect(await liveTracks(page)).toBeGreaterThan(0);
  await page.locator("form.photo-form").getByRole("button", { name: "Cancelar" }).click();
  expect(await liveTracks(page)).toBe(0);
});

test("the headers allow the camera for this site, and nothing else new", async ({ page }) => {
  const response = await page.request.get("/");
  const policy = response.headers()["permissions-policy"];
  expect(policy).toContain("camera=(self)");
  expect(policy).toContain("microphone=(self)");
  expect(policy).toContain("geolocation=(self)");
  expect(policy).toContain("payment=()");
  expect(policy).toContain("usb=()");
});
