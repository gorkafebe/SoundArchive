// The whole journey with two people and an administrator: invite, sign up,
// create a place, record, upload, photos, ambient, compare, report, remove and
// restore. In both languages, both themes and both screen sizes.
import { deflateSync } from "node:zlib";

import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { BASE_URL, MEDIA, USER_PASSWORD } from "./constants";
import { expect, prepare, test } from "./fixtures";
import { apiPost, audioTime } from "./helpers";

const FRESH = { cookies: [], origins: [] };

const COPY = {
  es: {
    create: "Crear cuenta", add: "Añadir lugar", lat: "Latitud", lon: "Longitud", name: "Nombre", next: "Siguiente", place: "Crear el lugar",
    record: "Grabar", cont: "Continuar", start: "Empezar a grabar", stop: "Detener la grabación", title: "Título", publish: "Publicar",
    upload: "Subir", uploadSubmit: "Subir y publicar", photo: "Añadir una foto", alt: "Descripción de la imagen",
    back: "Atrás", ambient: "Modo ambiente", exit: "Salir", compare: "Comparar en el tiempo", switch: "Alternar A / B",
    report: "Denunciar", reason: "Motivo", send: "Enviar la denuncia", gone: "Esta grabación ya no está disponible.",
    remove: "Retirar", adminReason: "Motivo (solo lo ves tú)", restore: "Restaurar", play: "Reproducir",
  },
  en: {
    create: "Create account", add: "Add place", lat: "Latitude", lon: "Longitude", name: "Name", next: "Next", place: "Create place",
    record: "Record", cont: "Continue", start: "Start recording", stop: "Stop recording", title: "Title", publish: "Publish",
    upload: "Upload", uploadSubmit: "Upload and publish", photo: "Add a photo", alt: "Image description",
    back: "Back", ambient: "Ambient mode", exit: "Exit", compare: "Compare across time", switch: "Switch A / B",
    report: "Report", reason: "Reason", send: "Send the report", gone: "This recording is no longer available.",
    remove: "Remove", adminReason: "Reason (only you see this)", restore: "Restore", play: "Play",
  },
};

function tinyPng(): Buffer {
  // 2x2 PNG, enough for the photo step (moderation.spec checks the stripping).
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(typed));
    return Buffer.concat([size, typed, check]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.from([0, 200, 80, 30, 30, 80, 200]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat([row, row]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function person(
  browser: Browser,
  admin: Page,
  name: string,
  language: "es" | "en",
  theme: "light" | "dark",
  viewport: { width: number; height: number },
  label: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const invite = await apiPost(admin.request, "/api/admin/invitations", { days: 1 });
  const context = await browser.newContext({ storageState: FRESH, viewport });
  const page = await context.newPage();
  await prepare(page, { language, theme });
  await page.goto(`/?code=${(await invite.json()).code}`);
  await page.locator('input[autocomplete="username"]').nth(1).fill(name);
  await page.locator('input[autocomplete="new-password"]').fill(USER_PASSWORD);
  await page.screenshot({ path: `test-results/screens/${label}-register.png`, fullPage: true });
  await page.getByRole("button", { name: COPY[language].create }).click();
  await expect(page.locator(".top-bar")).toBeVisible();
  return { context, page };
}

async function axe(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
  expect(serious, `${where}: ${JSON.stringify(serious)}`).toEqual([]);
}

const COMBINATIONS = [
  { language: "es", theme: "light", width: 390, height: 844 },
  { language: "en", theme: "dark", width: 1440, height: 900 },
  { language: "es", theme: "dark", width: 1440, height: 900 },
  { language: "en", theme: "light", width: 390, height: 844 },
] as const;

for (const { language, theme, width, height } of COMBINATIONS) {
  const copy = COPY[language];
  const label = `journey-${language}-${theme}-${width}`;

  test(`full journey: ${language}, ${theme}, ${width} px`, async ({ page, browser }) => {
    test.setTimeout(240_000);
    await prepare(page, { language, theme });
    const stamp = Date.now() % 1_000_000;
    const ana = await person(browser, page, `ana${stamp}`, language, theme, { width, height }, `${label}-ana`);
    const luis = await person(browser, page, `luis${stamp}`, language, theme, { width, height }, `${label}-luis`);

    // Ana creates a place.
    const a = ana.page;
    const placeName = `Plaza ${stamp}`;
    await a.getByRole("button", { name: copy.add }).click();
    await a.getByLabel(copy.lat).fill(language === "es" ? "43,2630" : "43.2630");
    await a.getByLabel(copy.lon).fill(language === "es" ? "-2,9350" : "-2.9350");
    await a.getByRole("button", { name: copy.next }).click();
    await a.getByLabel(copy.name, { exact: true }).fill(placeName);
    await a.getByRole("button", { name: copy.next }).click();
    await a.getByRole("button", { name: copy.place }).click();
    await expect(a.getByRole("heading", { level: 2, name: placeName })).toBeVisible();
    const placeId = new URL(a.url()).searchParams.get("place")!;
    await a.screenshot({ path: `test-results/screens/${label}-place-empty.png` });
    await axe(a, "place, empty");

    // Records one.
    await a.getByRole("button", { name: copy.record, exact: true }).first().click();
    await a.getByRole("button", { name: copy.cont }).click();
    await a.getByRole("button", { name: copy.start }).click();
    await a.waitForTimeout(3000);
    await a.getByRole("button", { name: copy.stop }).click();
    await a.getByLabel(copy.title).fill("Una toma");
    await a.screenshot({ path: `test-results/screens/${label}-review.png`, fullPage: true });
    await axe(a, "review");
    await a.getByRole("button", { name: copy.publish, exact: true }).click();
    await expect(a).toHaveURL(/\/recordings\//, { timeout: 90_000 });
    await a.screenshot({ path: `test-results/screens/${label}-recording.png`, fullPage: true });
    await axe(a, "recording");

    // Uploads another.
    await a.goto(`/upload?place=${placeId}`);
    await a.getByTestId("file-input").setInputFiles(`${MEDIA}/tone-b.wav`);
    await a.getByLabel(copy.title).fill("Otra toma");
    await a.screenshot({ path: `test-results/screens/${label}-upload.png`, fullPage: true });
    await axe(a, "upload");
    await a.getByRole("button", { name: copy.uploadSubmit }).click();
    await expect(a).toHaveURL(/\/recordings\//, { timeout: 90_000 });
    const secondId = a.url().split("/").pop()!;

    // A photo.
    await a.goto(`/?place=${placeId}`);
    await a.getByRole("button", { name: copy.photo }).click();
    await a.getByTestId("photo-input").setInputFiles({ name: "p.png", mimeType: "image/png", buffer: tinyPng() });
    await a.getByLabel(copy.alt).fill("Una plaza");
    await a.locator("form.photo-form").getByRole("button", { name: copy.photo }).click();
    await expect(a.locator(".photo-strip__item")).toHaveCount(1);
    await a.screenshot({ path: `test-results/screens/${label}-place.png` });
    await axe(a, "place with recordings");

    // Ambient mode, then the comparison.
    await a.goto(`/recordings/${secondId}/ambient`);
    await a.locator(".ambient__controls").getByRole("button", { name: new RegExp(`^${copy.play}`) }).click();
    await expect.poll(() => audioTime(a), { timeout: 15_000 }).toBeGreaterThan(0.2);
    await a.screenshot({ path: `test-results/screens/${label}-ambient.png`, fullPage: true });
    await axe(a, "ambient");
    await a.goto(`/places/${placeId}/compare`);
    await expect(a.getByRole("button", { name: copy.switch })).toBeVisible();
    await a.screenshot({ path: `test-results/screens/${label}-compare.png`, fullPage: true });
    await axe(a, "compare");

    // Luis listens, and reports one.
    const l = luis.page;
    await l.goto(`/recordings/${secondId}`);
    await l.getByRole("button", { name: copy.report, exact: true }).click();
    await l.getByLabel(copy.reason, { exact: true }).fill("Prueba de denuncia");
    await l.getByRole("button", { name: copy.send }).click();

    // The administrator removes it, and restores it.
    await page.setViewportSize({ width, height });
    await page.goto("/admin");
    const row = page.getByTestId("admin-row").filter({ hasText: "Otra toma" }).filter({ hasText: "Prueba de denuncia" });
    await expect(row).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${label}-admin.png`, fullPage: true });
    await axe(page, "admin");
    await row.getByRole("button", { name: copy.remove }).click();
    await page.getByLabel(copy.adminReason).fill("Prueba");
    await page.locator("form.admin-remove").getByRole("button", { name: copy.remove }).click();
    await l.reload();
    await expect(l.getByText(copy.gone)).toBeVisible();
    await l.screenshot({ path: `test-results/screens/${label}-removed.png` });
    await axe(l, "removed");
    const removedRow = page.getByTestId("admin-row").filter({ hasText: "Otra toma" }).first();
    await removedRow.getByRole("button", { name: copy.restore }).click();
    await expect(removedRow.getByRole("button", { name: copy.remove })).toBeVisible();
    await l.reload();
    await expect(l.getByRole("heading", { level: 1, name: "Otra toma" })).toBeVisible();

    await ana.context.close();
    await luis.context.close();
    void BASE_URL;
  });
}
