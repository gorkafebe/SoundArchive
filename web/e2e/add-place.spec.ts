// Adding a place, end to end: the real API writes to the dev database.
// Created places are named "E2E ..." so they are easy to recognise there.
import { expect, freshCoordinates, openAdvanced, pastKnownPlaces, prepare, test, waitForPins } from "./fixtures";

test("creates a place by tapping the map, then shows it on the map and in the list (es)", async ({ page }) => {
  await prepare(page);
  await page.goto("/?view=map&lat=43.26300&lon=-2.93500&z=14.00");
  await waitForPins(page);

  await page.getByRole("button", { name: "Añadir lugar" }).click();
  await expect(page.getByRole("heading", { level: 2 })).toContainText("Paso 1 de 3: Ubicación");
  await expect(page.getByRole("heading", { level: 2 })).toBeFocused();

  // Tap the middle of the small map.
  await page.getByRole("button", { name: "Elegir en el mapa" }).click();
  const picker = page.locator(".location-picker canvas");
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByLabel("Latitud")).not.toHaveValue("");
  await expect(page.getByRole("img", { name: "Ubicación elegida" })).toBeVisible();
  await page.getByRole("button", { name: "Siguiente" }).click();
  await pastKnownPlaces(page);

  const name = `E2E plaza ${Date.now()}`;
  await page.getByRole("textbox", { name: "Nombre" }).fill(name);
  await page.getByLabel("Descripción (opcional)").fill("Creado por la prueba de extremo a extremo.");
  await page.getByRole("button", { name: "Siguiente" }).click();
  await expect(page.getByText(name)).toBeVisible();
  await page.getByRole("button", { name: "Crear el lugar" }).click();

  // Back on the map, with the new place's panel open and its pin selected.
  const heading = page.getByRole("complementary").getByRole("heading", { level: 2, name });
  await expect(heading).toBeFocused();
  await expect(page.locator(".map-pin--selected")).toHaveAttribute("aria-label", `${name}, seleccionado`);

  // ...and in the list.
  await page.getByRole("button", { name: "Lista" }).click();
  await page.getByRole("searchbox", { name: "Buscar lugares" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.locator(".place-list__item")).toHaveCount(1);
});

test("creates a place by typing coordinates (en)", async ({ page }) => {
  await prepare(page, { language: "en" });
  await page.goto("/");
  await page.getByRole("button", { name: "Add place" }).click();
  await openAdvanced(page);
  const coordinates = freshCoordinates("en");
  await page.getByLabel("Latitude").fill(coordinates.lat);
  await page.getByLabel("Longitude").fill(coordinates.lon);
  await page.getByRole("button", { name: "Next" }).click();
  const name = `E2E square ${Date.now()}`;
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Create place" }).click();
  await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name })).toBeFocused();
  await expect(page.getByText(`${coordinates.rawLat}0° N, ${coordinates.rawLon.slice(1)}0° W`)).toBeVisible();
});

test("validation errors move the focus to the first wrong field", async ({ page }) => {
  await prepare(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Añadir lugar" }).click();
  await openAdvanced(page);
  await page.getByLabel("Longitud").fill("200");
  await page.getByRole("button", { name: "Siguiente" }).click();
  await expect(page.getByLabel("Latitud")).toBeFocused();
  await expect(page.getByLabel("Latitud")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Longitud")).toHaveAccessibleDescription(/entre −180 y 180/);
});

for (const language of ["es", "en"] as const) {
  test(`writes disabled: the button explains it instead of failing (${language})`, async ({ page }) => {
    await prepare(page, { writesEnabled: false, language });
    await page.goto("/");
    const add = page.getByRole("button", { name: language === "es" ? "Añadir lugar" : "Add place" });
    await expect(add).toBeVisible();
    await add.click();
    await expect(
      page.getByText(
        language === "es"
          ? "La creación de lugares está desactivada en este servidor"
          : "Creating places is disabled on this server",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: language === "es" ? "Volver" : "Back" }).click();
    await expect(add).toBeFocused();
  });
}

test("a 403 from the server while submitting shows the disabled message", async ({ page }) => {
  await prepare(page);
  await page.route("**/api/places", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 403, json: { detail: { code: "writes_disabled" } } })
      : route.fallback(),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Añadir lugar" }).click();
  await openAdvanced(page);
  const coordinates = freshCoordinates();
  await page.getByLabel("Latitud").fill(coordinates.lat);
  await page.getByLabel("Longitud").fill(coordinates.lon);
  await page.getByRole("button", { name: "Siguiente" }).click();
  await page.getByRole("textbox", { name: "Nombre" }).fill("No se guardará");
  await page.getByRole("button", { name: "Siguiente" }).click();
  await page.getByRole("button", { name: "Crear el lugar" }).click();
  await expect(page.getByRole("alert")).toHaveText("La creación de lugares está desactivada en este servidor");
  await expect(page.getByText("No se guardará")).toBeVisible(); // nothing lost
});
