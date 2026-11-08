// Photos without EXIF, reporting, and administration.
import { deflateSync } from "node:zlib";

import { BASE_URL } from "./constants";
import { expect, prepare, test } from "./fixtures";
import { apiPost, createPlace, newUser, uploadAudio } from "./helpers";

/** A small PNG with a hidden "GPS" text chunk, built by hand. */
function pngWithSecret(width = 40, height = 30): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 90)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from("GPSPosition\0SECRET-LOCATION-43.26", "latin1")),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a photo: hidden data removed, description in the enlarged view, Esc closes", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Con fotos");
  await page.goto(`/?place=${placeId}`);
  await page.getByRole("button", { name: "Añadir una foto" }).click();
  await page.getByTestId("photo-input").setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: pngWithSecret() });
  await page.getByLabel("Descripción de la imagen").fill("Una pared gris");
  await page.getByLabel("Pie de foto (opcional)").fill("La pared");
  await page.locator("form.photo-form").getByRole("button", { name: "Añadir una foto" }).click();
  const thumb = page.getByRole("button", { name: "Ampliar la foto: Una pared gris" });
  await expect(thumb).toBeVisible();

  const photos = await (await page.request.get(`/api/places/${placeId}/photos`)).json();
  const served = await page.request.get(`/api/photos/${photos[0].id}/large`);
  expect(served.headers()["content-type"]).toBe("image/jpeg");
  expect((await served.body()).includes("SECRET-LOCATION")).toBe(false);

  await thumb.click();
  const dialog = page.getByRole("dialog", { name: "Foto ampliada" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("img")).toHaveAttribute("alt", "Una pared gris");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a false image is refused with a clear message", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Foto falsa");
  await page.goto(`/?place=${placeId}`);
  await page.getByRole("button", { name: "Añadir una foto" }).click();
  await page.getByTestId("photo-input").setInputFiles({ name: "foto.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image") });
  await page.locator("form.photo-form").getByRole("button", { name: "Añadir una foto" }).click();
  await expect(page.getByRole("alert")).toContainText("no es una imagen");
});

test("report, the administrator removes it, it disappears, restore brings it back", async ({ page, browser }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Denunciada");
  const title = `Ruido de obra ${Date.now()}`;
  const id = await uploadAudio(page.request, placeId, "short.wav", title);
  const reader = await newUser(browser, page.request);
  await prepare(reader.page);

  // Someone reports it.
  await reader.page.goto(`/recordings/${id}`);
  await reader.page.getByRole("button", { name: "Denunciar" }).click();
  await reader.page.getByLabel("Motivo").fill("Ruido ajeno al lugar");
  await reader.page.getByRole("button", { name: "Enviar la denuncia" }).click();
  await expect(reader.page.getByText("Denuncia enviada")).toBeVisible();

  // The administrator sees it first in the list, with the reason.
  await page.goto("/admin");
  const row = page.getByTestId("admin-row").filter({ hasText: title });
  await expect(row).toContainText("Denunciada");
  await expect(row).toContainText("Ruido ajeno al lugar");
  await page.screenshot({ path: "test-results/screens/admin.png", fullPage: true });

  await row.getByRole("button", { name: "Retirar" }).click();
  await page.getByLabel("Motivo (solo lo ves tú)").fill("Ruido ajeno");
  await page.locator("form.admin-remove").getByRole("button", { name: "Retirar" }).click();
  await expect(row).toContainText("Retirada");

  // Gone for everybody else, and from every way of finding it.
  await reader.page.reload();
  await expect(reader.page.getByText("Esta grabación ya no está disponible.")).toBeVisible();
  await reader.page.goto(`/?place=${placeId}`);
  await expect(reader.page.getByText(title)).toHaveCount(0);

  await row.getByRole("button", { name: "Restaurar" }).click();
  await expect(row).toContainText("Publicada");
  await reader.page.goto(`/recordings/${id}`);
  await expect(reader.page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await reader.context.close();
});

test("the author can remove their own recording", async ({ page }) => {
  await prepare(page);
  const placeId = await createPlace(page.request, "Propia");
  const id = await uploadAudio(page.request, placeId, "short.wav", "La retiro yo");
  await page.goto(`/recordings/${id}`);
  await page.getByRole("button", { name: "Retirar" }).click();
  await page.getByRole("button", { name: "Sí, retirarla" }).click();
  await expect(page).toHaveURL(new RegExp(`place=${placeId}`));
  await expect(page.getByText("Grabación retirada")).toBeVisible();
});

test("a person who is not an administrator does not reach the administration", async ({ page, browser }) => {
  const user = await newUser(browser, page.request);
  await prepare(user.page);
  for (const path of ["/api/admin/users", "/api/admin/invitations", "/api/admin/content", "/api/admin/audit"]) {
    expect((await user.page.request.get(path)).status()).toBe(403);
  }
  const attempt = await apiPost(user.page.request, "/api/admin/invitations", {});
  expect(attempt.status()).toBe(403);
  await user.page.goto("/admin");
  await expect(user.page.getByRole("heading", { name: "Aquí no hay nada" })).toBeVisible();
  await user.context.close();
});

test("admin screens: invitations show the code once, users can be deactivated", async ({ page, browser }) => {
  await prepare(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Invitaciones" }).click();
  await page.getByRole("button", { name: "Crear invitación" }).click();
  await expect(page.getByTestId("new-invitation")).toHaveText(/^SA-/);
  await page.screenshot({ path: "test-results/screens/admin-invitations.png", fullPage: true });

  const user = await newUser(browser, page.request);
  await page.getByRole("button", { name: "Usuarios" }).click();
  const row = page.getByTestId("admin-user").filter({ hasText: user.name });
  await row.getByRole("button", { name: "Desactivar" }).click();
  await expect(row).toContainText("Desactivado");
  expect((await user.page.request.get("/api/auth/me")).status()).toBe(401);
  await user.context.close();
  await page.getByRole("button", { name: "Registro" }).click();
  await expect(page.getByText("user.deactivated").first()).toBeVisible();
  void BASE_URL;
});
