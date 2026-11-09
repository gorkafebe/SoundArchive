// With the microphone denied: this project has no fake microphone and the
// permission is not granted, so getUserMedia fails as in real life.
import AxeBuilder from "@axe-core/playwright";

import { expect, prepare, test } from "./fixtures";
import { createPlace } from "./helpers";

test("the camera refused or missing: says so and offers a file", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, `Sin camara ${Date.now()}`);
  await page.goto(`/?place=${placeId}`);
  await page.getByRole("button", { name: "Añadir una foto" }).click();
  await page.getByRole("button", { name: "Hacer una foto" }).click();
  await page.getByRole("button", { name: "Activar la cámara" }).click();
  await expect(page.getByRole("alert")).toContainText(/bloqueada la cámara|No encontramos ninguna cámara/);
  await page.screenshot({ path: "test-results/screens/camera-blocked-es.png" });
  await page.getByRole("button", { name: "Elegir un archivo en su lugar" }).click();
  await expect(page.getByTestId("photo-input")).toBeVisible();
});

for (const [language, heading, cont, upload] of [
  ["es", "No podemos usar el micrófono", "Continuar", "Subir un archivo"],
  ["en", "We cannot use the microphone", "Continue", "Upload a file"],
] as const) {
  test(`shows the blocked state, with a way out (${language})`, async ({ page }) => {
    await prepare(page, { language });
    const placeId = await createPlace(page.request, "Sin permiso");
    await page.goto(`/record?place=${placeId}`);
    await page.getByRole("button", { name: cont }).click();
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await page.screenshot({ path: `test-results/screens/mic-blocked-${language}.png` });
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    await page.getByRole("button", { name: upload }).click();
    await expect(page).toHaveURL(/\/upload\?place=/);
  });
}
