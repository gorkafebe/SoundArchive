// Shared steps of the audio, account and moderation tests. They go through the
// real API, as the browser would.
import { readFileSync } from "node:fs";

import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

import { BASE_URL, MEDIA, USER_PASSWORD } from "./constants";
import { expect } from "./fixtures";

export async function csrfOf(request: APIRequestContext): Promise<string> {
  const me = await request.get("/api/auth/me");
  expect(me.ok()).toBeTruthy();
  return (await me.json()).csrf_token;
}

export async function apiPost(request: APIRequestContext, url: string, data: unknown, method = "POST") {
  return request.fetch(url, {
    method,
    data: data as never,
    headers: { "X-CSRF-Token": await csrfOf(request), Origin: BASE_URL, "Content-Type": "application/json" },
  });
}

export async function createPlace(request: APIRequestContext, name: string): Promise<string> {
  const response = await apiPost(request, "/api/places", {
    name,
    latitude: 43.3 + Math.random() / 50,
    longitude: -2.5 + Math.random() / 50,
    location_accuracy_m: 50,
  });
  expect(response.status()).toBe(201);
  return (await response.json()).id;
}

/** Upload a test file through the API, and wait until it is processed. */
export async function uploadAudio(
  request: APIRequestContext,
  placeId: string,
  file: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const data = readFileSync(`${MEDIA}/${file}`);
  const created = await apiPost(request, "/api/recordings", {
    place_id: placeId,
    title,
    heard: `Se oye ${title}`,
    recorded_at: "2026-10-12T08:42:00+02:00",
    capture_method: "upload",
    size: data.length,
    filename: file,
    license: "all-rights-reserved",
    ...extra,
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json()).id as string;
  const sent = await request.fetch(`/api/recordings/${id}/upload`, {
    method: "PATCH",
    data,
    headers: {
      "X-CSRF-Token": await csrfOf(request),
      Origin: BASE_URL,
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes 0-${data.length - 1}/${data.length}`,
    },
  });
  expect(sent.status(), await sent.text()).toBe(200);
  await expect
    .poll(async () => (await (await request.get(`/api/recordings/${id}`)).json()).status, { timeout: 60_000 })
    .toBe("ready");
  return id;
}

let counter = 0;

/** A second person, with their own browser and a real invitation. */
export async function newUser(
  browser: Browser,
  adminRequest: APIRequestContext,
  name = `user${Date.now() % 100000}${counter++}`,
): Promise<{ context: BrowserContext; page: Page; name: string }> {
  const invite = await apiPost(adminRequest, "/api/admin/invitations", { days: 1 });
  expect(invite.status()).toBe(201);
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  const response = await page.request.post("/api/auth/register", {
    headers: { Origin: BASE_URL },
    data: { code: (await invite.json()).code, username: name, password: USER_PASSWORD, language: "es" },
  });
  expect(response.status()).toBe(201);
  return { context, page, name };
}

/** currentTime of the app's audio element. */
export const audioTime = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid="global-audio"]') as HTMLAudioElement).currentTime);

export const audioPaused = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid="global-audio"]') as HTMLAudioElement).paused);
