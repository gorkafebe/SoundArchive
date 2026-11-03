// A fake API for component tests: replaces window.fetch and answers by URL.
import { vi } from "vitest";

import type { Place, PublicConfig } from "../lib/api";

export const CONFIG: PublicConfig = {
  writes_enabled: true,
  map_style_url: "/test-style.json",
  map_style_url_dark: "/test-style-dark.json",
};

export function makePlace(n: number, extra: Partial<Place> = {}): Place {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Place ${n}`,
    description: n % 2 ? `Description ${n}` : null,
    latitude: 43 + n / 100,
    longitude: -3 + n / 100,
    created_at: "2026-11-03T10:00:00Z",
    updated_at: "2026-11-03T10:00:00Z",
    ...extra,
  };
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Install a fetch that calls handler(url); returns the mock to inspect calls. */
export function mockFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return handler(url, init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** A small database of places with list, search, detail and create. */
export function fakeServer(places: Place[], config: PublicConfig = CONFIG) {
  const db = [...places];
  return mockFetch(async (url, init) => {
    if (url.pathname === "/api/config") return json(config);
    if (url.pathname === "/api/places/list") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const found = db.filter((p) => !q || p.name.toLowerCase().includes(q));
      return json({ items: found.slice(offset, offset + limit), total: found.length, limit, offset });
    }
    if (url.pathname === "/api/places" && init?.method === "POST") {
      if (!config.writes_enabled) return json({ detail: { code: "writes_disabled" } }, 403);
      const body = JSON.parse(String(init.body));
      const place = makePlace(db.length + 1000, { ...body });
      db.unshift(place);
      return json(place, 201);
    }
    const match = url.pathname.match(/^\/api\/places\/([\w-]+)$/);
    if (match) {
      const place = db.find((p) => p.id === match[1]);
      return place ? json(place) : json({ detail: "Place not found" }, 404);
    }
    return json({ detail: "not found" }, 404);
  });
}
