// Accounts end to end: invitation, entering, creating a place, leaving.
import AxeBuilder from "@axe-core/playwright";

import { ADMIN_PASSWORD, BASE_URL, USER_PASSWORD } from "./constants";
import { expect, prepare, test, waitForPins } from "./fixtures";
import { apiPost } from "./helpers";

const FRESH = { cookies: [], origins: [] };

test.describe("signed out", () => {
  test.use({ storageState: FRESH });

  test("the site shows only the sign-in screen", async ({ page }) => {
    await prepare(page);
    await page.goto("/?view=list");
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Crear cuenta con invitación" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Lista" })).toHaveCount(0);
    await page.screenshot({ path: "test-results/screens/signin-1440.png", fullPage: true });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`the sign-in screen passes the audit (${theme})`, async ({ page }) => {
      await prepare(page, { theme });
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(audit.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    });
  }

  test("a wrong password gets a neutral message", async ({ page }) => {
    await prepare(page);
    await page.goto("/");
    await page.getByLabel("Usuario").first().fill("e2e-admin");
    await page.getByLabel("Contraseña").first().fill("not the right password");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toHaveText("El usuario o la contraseña no son correctos.");
  });

  test("an invalid invitation is refused beside its field", async ({ page }) => {
    await prepare(page);
    await page.goto("/");
    await page.getByLabel("Código de invitación").fill("SA-AAAA-BBBB-CCCC-DDDD");
    await page.getByRole("textbox", { name: /Usuario/ }).nth(1).fill("alguien");
    await page.locator('input[autocomplete="new-password"]').fill(USER_PASSWORD);
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    await expect(page.getByText("Este código no es válido o ya se ha usado")).toBeVisible();
  });
});

test("invitation, sign up, create a place, sign out, sign in again", async ({ page, browser }) => {
  const invite = await apiPost(page.request, "/api/admin/invitations", { days: 1 });
  const { code } = await invite.json();
  const name = `viajera${Date.now() % 100000}`;

  const context = await browser.newContext({ storageState: FRESH });
  const visitor = await context.newPage();
  await prepare(visitor);
  await visitor.goto(`/?code=${code}`);
  await expect(visitor.getByLabel("Código de invitación")).toHaveValue(code);
  await visitor.locator('input[autocomplete="username"]').nth(1).fill(name);
  await visitor.locator('input[autocomplete="new-password"]').fill(USER_PASSWORD);
  await visitor.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(visitor.getByRole("button", { name: "Mapa" })).toBeVisible();

  // The session cookie has the attributes the design requires.
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-sa_session")!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.secure).toBe(true);
  expect(cookie.sameSite).toBe("Lax");
  expect(cookie.path).toBe("/");

  await visitor.getByRole("button", { name: "Añadir lugar" }).click();
  await visitor.getByLabel("Latitud").fill("43,2630");
  await visitor.getByLabel("Longitud").fill("-2,9350");
  await visitor.getByRole("button", { name: "Siguiente" }).click();
  await visitor.getByLabel("Nombre", { exact: true }).fill(`Lugar de ${name}`);
  await visitor.getByRole("button", { name: "Siguiente" }).click();
  await visitor.getByRole("button", { name: "Crear el lugar" }).click();
  await expect(visitor.getByRole("heading", { level: 2, name: `Lugar de ${name}` })).toBeVisible();

  await visitor.getByRole("button", { name }).click();
  await visitor.getByRole("button", { name: "Salir" }).click();
  await expect(visitor.getByRole("heading", { name: "Entrar" })).toBeVisible();

  await visitor.getByLabel("Usuario").first().fill(name);
  await visitor.getByLabel("Contraseña").first().fill(USER_PASSWORD);
  await visitor.getByRole("button", { name: "Entrar" }).click();
  await expect(visitor.getByRole("button", { name: "Mapa" })).toBeVisible();
  await context.close();
});

test("when the session ends, the sign-in screen explains it", async ({ browser }) => {
  const context = await browser.newContext({ storageState: FRESH });
  const page = await context.newPage();
  await prepare(page);
  await page.goto("/");
  await page.getByLabel("Usuario").first().fill("e2e-admin");
  await page.getByLabel("Contraseña").first().fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await waitForPins(page);
  await context.clearCookies();
  await page.getByRole("button", { name: "Lista" }).click();
  await expect(page.getByText("Tu sesión ha terminado")).toBeVisible();
  await context.close();
});

test("the same site refuses a write without the CSRF token", async ({ page }) => {
  await prepare(page);
  const response = await page.request.post("/api/places", {
    headers: { Origin: BASE_URL },
    data: { name: "x", latitude: 0, longitude: 0 },
  });
  expect(response.status()).toBe(403);
});
