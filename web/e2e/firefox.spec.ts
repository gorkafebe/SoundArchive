// The listening copy (Opus in WebM) also plays in Firefox. The private CA is
// not installed in this browser's store, so this project alone ignores
// certificate errors; HTTPS trust is proven in https.spec.ts with Chromium.
import { expect, prepare, test } from "./fixtures";
import { audioTime, createPlace, uploadAudio } from "./helpers";

test("the listening copy plays in Firefox", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Firefox");
  const id = await uploadAudio(page.request, placeId, "tone-a.wav", "En Firefox");
  await page.goto(`/recordings/${id}`);
  await page.getByRole("button", { name: "Reproducir En Firefox" }).click();
  await expect.poll(() => audioTime(page), { timeout: 20_000 }).toBeGreaterThan(0.5);
});
