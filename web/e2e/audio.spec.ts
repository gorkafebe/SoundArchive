// Recording and listening, with a fake microphone that "hears" a known tone
// (Chromium's --use-file-for-fake-audio-capture, see playwright.config.ts).
// The browser's own permission prompt cannot appear in a test; the app's
// explanation before it can, and is checked.
import { MEDIA } from "./constants";
import { expect, prepare, test } from "./fixtures";
import { audioPaused, audioTime, createPlace, uploadAudio } from "./helpers";

const WAIT_READY = { timeout: 90_000 };

test("records 10 s, reviews, publishes, processes, plays to the end", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Mercado de prueba");
  await page.goto(`/record?place=${placeId}`);

  // The explanation first; the microphone only after the tap.
  await expect(page.getByRole("heading", { name: "¿Usar el micrófono?" })).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  await page.screenshot({ path: "test-results/screens/record-1-permission.png" });
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByTestId("meter")).toBeVisible();
  await page.getByRole("button", { name: "Empezar a grabar" }).click();
  await expect(page.getByRole("button", { name: "Detener la grabación" })).toBeVisible();
  // The level meter really moves: some bars are lit by the fake microphone.
  await expect.poll(() => page.locator('[data-testid="meter"] b.on').count()).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/screens/record-2-recording.png" });
  await page.waitForTimeout(10_000);
  await page.getByRole("button", { name: "Detener la grabación" }).click();

  await expect(page.getByRole("heading", { name: "Revisar y publicar" })).toBeVisible();
  await expect(page.getByTestId("preview-audio")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/record-3-review.png", fullPage: true });
  // Publishing without a title keeps you here and says why.
  await page.getByRole("button", { name: "Publicar" }).click();
  await expect(page.getByText("Escribe un título.")).toBeVisible();

  await page.getByLabel("Título").fill("Tono de prueba");
  await page.getByLabel("Qué se oye").fill("Un tono continuo de referencia.");
  await page.getByRole("button", { name: "Publicar" }).click();
  await expect(page).toHaveURL(/\/recordings\/[0-9a-f-]{36}$/, WAIT_READY);

  await expect(page.getByRole("heading", { level: 1, name: "Tono de prueba" })).toBeVisible();
  await expect(page.getByText("Un tono continuo de referencia.")).toBeVisible();
  await expect(page.getByTestId("sha256")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("loudness")).toContainText("LUFS");
  // What the browser really did with the signal is on the page.
  await expect(page.getByTestId("browser-processing")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/recording-page.png", fullPage: true });

  // Nothing plays until someone presses play.
  expect(await audioPaused(page)).toBe(true);

  await page.getByRole("button", { name: "Reproducir Tono de prueba" }).click();
  await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(0.5);
  const ended = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const audio = document.querySelector('[data-testid="global-audio"]') as HTMLAudioElement;
        audio.addEventListener("ended", () => resolve(true), { once: true });
      }),
  );
  // The position control works from the keyboard, and takes us near the end.
  const slider = page.getByRole("slider", { name: "Posición" });
  await slider.focus();
  await slider.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await ended).toBe(true);
  await expect(page.locator(".player-top").getByRole("button", { name: "Reproducir Tono de prueba" })).toBeVisible();

  // And it is in the place's list.
  await page.goto(`/?place=${placeId}`);
  await expect(page.getByTestId("recording-card").filter({ hasText: "Tono de prueba" })).toBeVisible();
});

test("compressed capture: a browser WebM with no duration in it still gets one", async ({ page }) => {
  await prepare(page, { language: "en" });
  const placeId = await createPlace(page.request, "Compressed place");
  await page.goto(`/record?place=${placeId}`);
  await expect(page.getByRole("heading", { name: "Use the microphone?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: "Compressed" }).check({ force: true });
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByRole("heading", { name: "Review and publish" })).toBeVisible();
  await page.getByLabel("Title").fill("Compressed take");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/recordings\/[0-9a-f-]{36}$/, WAIT_READY);
  await expect(page.getByText("opus")).toBeVisible();
  await expect(page.getByTestId("timecode")).not.toContainText("–:––");
});

for (const language of ["es", "en"] as const) {
  const text = {
    es: { pick: "Elegir archivo", title: "Título", submit: "Subir y publicar", play: "Reproducir" },
    en: { pick: "Choose file", title: "Title", submit: "Upload and publish", play: "Play" },
  }[language];

  test(`uploads a file with real progress and plays it (${language})`, async ({ page }) => {
    await prepare(page, { language });
    const placeId = await createPlace(page.request, `Upload ${language}`);
    await page.goto(`/upload?place=${placeId}`);
    await expect(page.getByRole("button", { name: text.pick })).toBeVisible();
    await page.getByTestId("file-input").setInputFiles(`${MEDIA}/tone-a.wav`);
    await expect(page.getByText("tone-a.wav")).toBeVisible();
    await page.getByLabel(text.title).fill("Archivo subido");
    await page.screenshot({ path: `test-results/screens/upload-${language}.png`, fullPage: true });
    await page.getByRole("button", { name: text.submit }).click();
    await expect(page).toHaveURL(/\/recordings\/[0-9a-f-]{36}$/, WAIT_READY);
    await page.getByRole("button", { name: `${text.play} Archivo subido` }).click();
    await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(0.3);
    await expect(page.getByTestId("loudness")).toContainText("LUFS");
  });
}

test("a connection cut in the middle of an upload is recovered by the browser", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Corte de red");
  let cuts = 0;
  await page.route("**/api/recordings/*/upload", async (route) => {
    if (route.request().method() === "PATCH" && cuts === 0) {
      cuts += 1;
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await page.goto(`/upload?place=${placeId}`);
  await page.getByTestId("file-input").setInputFiles(`${MEDIA}/tone-a.wav`);
  await page.getByLabel("Título").fill("Tras el corte");
  await page.getByRole("button", { name: "Subir y publicar" }).click();
  await expect(page).toHaveURL(/\/recordings\/[0-9a-f-]{36}$/, WAIT_READY);
  expect(cuts).toBe(1);
  await expect(page.getByTestId("sha256")).toHaveText(/^[0-9a-f]{64}$/);
});

test("a file that is not audio gets an understandable error, and what was typed stays", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "No audio");
  await page.goto(`/upload?place=${placeId}`);
  await page.getByTestId("file-input").setInputFiles(`${MEDIA}/not-audio.wav`);
  await page.getByLabel("Título").fill("Esto no suena");
  await page.getByRole("button", { name: "Subir y publicar" }).click();
  await expect(page.getByRole("alert")).toContainText("no parece contener audio", WAIT_READY);
  await expect(page.getByLabel("Título")).toHaveValue("Esto no suena");
});

test("through Caddy, the listening copy answers range requests", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Rangos");
  const id = await uploadAudio(page.request, placeId, "short.wav", "Rango");
  const part = await page.request.get(`/api/recordings/${id}/audio`, { headers: { Range: "bytes=0-99" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
  expect((await part.body()).length).toBe(100);
  // Audio is not compressed on the way, or the ranges would not add up.
  expect(part.headers()["content-encoding"]).toBeUndefined();
});

test("ambient mode loops, stops with the timer, and the mini-player survives navigation", async ({ page }) => {
  await page.clock.install();
  await prepare(page);
  const placeId = await createPlace(page.request, "Ambiente");
  const id = await uploadAudio(page.request, placeId, "tone-a.wav", "Bucle");
  await page.goto(`/recordings/${id}`);
  await page.getByRole("button", { name: "Modo ambiente" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Bucle" })).toBeVisible();
  await page.screenshot({ path: "test-results/screens/ambient.png", fullPage: true });

  expect(await audioPaused(page)).toBe(true); // nothing without a tap
  await page.getByRole("button", { name: "Reproducir Bucle" }).click();
  await expect.poll(() => audioTime(page), { timeout: 15_000 }).toBeGreaterThan(0.3);
  expect(await page.evaluate(() => (document.querySelector('[data-testid="global-audio"]') as HTMLAudioElement).loop)).toBe(true);

  // Near the end, it comes back to the start without stopping.
  await page.evaluate(() => {
    (document.querySelector('[data-testid="global-audio"]') as HTMLAudioElement).currentTime = 7.5;
  });
  await expect.poll(() => audioTime(page), { timeout: 10_000 }).toBeLessThan(2);
  expect(await audioPaused(page)).toBe(false);

  // The sound carries on while moving around.
  await page.getByRole("radio", { name: "15 min" }).check({ force: true });
  await expect(page.getByTestId("mini-player")).toContainText("se apaga en");
  await page.getByRole("button", { name: "Salir" }).click();
  await page.getByRole("button", { name: "Atrás" }).click();
  await expect(page.getByRole("button", { name: "Lista" })).toBeVisible();
  await expect(page.getByTestId("mini-player")).toBeVisible();
  expect(await audioPaused(page)).toBe(false);

  // Leaving ambient mode turned the loop off: back on to test the timer.
  await page.getByRole("button", { name: "Lista" }).click();
  expect(await audioPaused(page)).toBe(false);

  // The timer, with a simulated clock: past 15 minutes, then the fade.
  await page.clock.fastForward("15:05");
  await page.clock.runFor(4000);
  await expect.poll(() => audioPaused(page), { timeout: 10_000 }).toBe(true);
  await expect(page.getByText("El temporizador ha terminado")).toBeVisible();

  // Closing the mini-player stops it for good.
  await page.getByRole("button", { name: "Cerrar el reproductor y detener el sonido" }).click();
  await expect(page.getByTestId("mini-player")).toHaveCount(0);
});

test("comparing: switching keeps the position and changes the sound", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Comparación");
  await uploadAudio(page.request, placeId, "tone-a.wav", "Grave", { recorded_at: "2024-06-08T10:00:00Z" });
  await uploadAudio(page.request, placeId, "tone-b.wav", "Agudo", { recorded_at: "2026-10-12T08:42:00Z" });

  await page.goto(`/?place=${placeId}`);
  await page.getByRole("button", { name: "Comparar en el tiempo" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("a lo largo del tiempo");
  await expect(page.getByText("no se corrige")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/compare.png", fullPage: true });

  const time = (slot: "A" | "B") =>
    page.evaluate((s) => (document.querySelector(`[data-testid="audio-${s}"]`) as HTMLAudioElement).currentTime, slot);
  const paused = (slot: "A" | "B") =>
    page.evaluate((s) => (document.querySelector(`[data-testid="audio-${s}"]`) as HTMLAudioElement).paused, slot);
  const source = (slot: "A" | "B") => page.getByTestId(`audio-${slot}`).getAttribute("src");

  expect(await source("A")).not.toBe(await source("B"));
  await page.getByRole("button", { name: "Reproducir" }).click();
  await expect.poll(() => time("A"), { timeout: 15_000 }).toBeGreaterThan(2);
  await expect(page.getByTestId("track-A")).toHaveAttribute("data-active", "true");

  const before = await time("A");
  await page.getByRole("button", { name: "Alternar A / B" }).click();
  await expect(page.getByTestId("track-B")).toHaveAttribute("data-active", "true");
  expect(await paused("A")).toBe(true);
  await expect.poll(() => paused("B")).toBe(false);
  // Same point (allowing for the time the click itself takes).
  expect(Math.abs((await time("B")) - before)).toBeLessThan(0.8);

  // Keyboard: the same action from the focused button.
  await page.getByRole("button", { name: "Alternar A / B" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("track-A")).toHaveAttribute("data-active", "true");
});

test("a recording kept private is only for its author", async ({ page, browser }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Privado");
  const id = await uploadAudio(page.request, placeId, "short.wav", "Secreta", { visibility: "private" });
  const { newUser } = await import("./helpers");
  const other = await newUser(browser, page.request);
  expect((await other.page.request.get(`/api/recordings/${id}`)).status()).toBe(404);
  expect((await other.page.request.get(`/api/recordings/${id}/audio`)).status()).toBe(404);
  await other.context.close();
});
