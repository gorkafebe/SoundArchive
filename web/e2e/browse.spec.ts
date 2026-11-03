// Browsing: map with data, opening a place, list view and search.
import { expect, prepare, test, waitForPins } from "./fixtures";

// Zoomed in on the example places around Bilbao (make seed-dev): single pins.
const BILBAO = "/?view=map&lat=43.26300&lon=-2.93500&z=14.00";

test.describe("browsing (es)", () => {
  test("opens a place from its pin, moves the focus, and returns it on close", async ({ page }) => {
    await prepare(page);
    await page.goto(BILBAO);
    await waitForPins(page);

    const pin = page.locator(".map-pin").first();
    const name = (await pin.getAttribute("aria-label"))!;
    await pin.click();

    const panel = page.getByRole("complementary", { name: "Ficha del lugar" });
    const heading = panel.getByRole("heading", { level: 2, name });
    await expect(heading).toBeFocused();
    await expect(panel.getByText("Aún sin grabaciones")).toBeVisible();
    await expect(page).toHaveURL(/place=[0-9a-f-]{36}/);
    // The selected pin says so, and is drawn bigger.
    const selected = page.locator(".map-pin--selected");
    await expect(selected).toHaveAttribute("aria-label", `${name}, seleccionado`);

    await panel.getByRole("button", { name: "Cerrar" }).click();
    await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
    await expect(page).not.toHaveURL(/place=/);
  });

  test("zooms into a cluster", async ({ page }) => {
    await prepare(page);
    await page.goto("/?view=map&lat=40.5&lon=-2.5&z=5.5");
    await waitForPins(page);
    const cluster = page.locator(".map-cluster").first();
    await expect(cluster).toHaveAttribute("aria-label", /Grupo de \d+ lugares/);
    const zoomBefore = Number(new URL(page.url()).searchParams.get("z"));
    await cluster.click();
    await expect.poll(() => Number(new URL(page.url()).searchParams.get("z"))).toBeGreaterThan(zoomBefore);
  });

  test("list view: search, open a place and show it on the map", async ({ page }) => {
    await prepare(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Lista" }).click();
    await expect(page).toHaveURL(/view=list/);
    await expect(page.getByRole("heading", { name: "Lista de lugares" })).toBeVisible();

    await page.getByRole("searchbox", { name: "Buscar lugares" }).fill("Harbour");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(page.getByText(/^\d+ lugar(es)?$/)).toBeVisible();
    await expect(page).toHaveURL(/q=Harbour/);

    const first = page.locator(".place-list__item").first();
    await expect(first).toContainText("Harbour");
    await first.click();
    const heading = page.getByRole("complementary").getByRole("heading", { level: 2 });
    await expect(heading).toBeFocused();
    await expect(heading).toContainText("Harbour");

    await page.getByRole("button", { name: "Ver en el mapa" }).click();
    await expect(page).toHaveURL(/view=map/);
    await expect(page.locator(".map-pin--selected")).toBeVisible();
  });
});

test.describe("browsing (en)", () => {
  test("the same flow in English", async ({ page }) => {
    await prepare(page, { language: "en" });
    await page.goto(BILBAO);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await waitForPins(page);
    await page.locator(".map-pin").first().click();
    await expect(page.getByRole("complementary", { name: "Place details" }).getByText("No recordings yet")).toBeVisible();
    await page.getByRole("button", { name: "List" }).click();
    await expect(page.getByRole("heading", { name: "List of places" })).toBeVisible();
  });

  test("the language switch changes the texts and <html lang>", async ({ page }) => {
    await prepare(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Cambiar el idioma: English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Add place" })).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en"); // remembered
  });
});
