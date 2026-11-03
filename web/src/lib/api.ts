// Talks to the API. Same origin as the page (Caddy serves both), so plain
// relative URLs work on localhost, a LAN address, Tailscale or a domain.
// Every function takes an AbortSignal, so a newer request can cancel an
// older one (e.g. when the map moves again before the answer arrives).

export interface PublicConfig {
  writes_enabled: boolean;
  map_style_url: string;
  map_style_url_dark: string;
}

export interface Place {
  id: string;
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  created_at: string;
  updated_at: string;
}

export interface PlaceList {
  items: Place[];
  total: number;
  limit: number;
  offset: number;
}

export interface PlaceFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: { name: string };
}

export interface PlaceFeatureCollection {
  type: "FeatureCollection";
  features: PlaceFeature[];
  truncated: boolean;
}

export interface NewPlace {
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
}

/** status 0 = no answer at all (offline, server down, request blocked). */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { Accept: "application/json", ...init.headers } });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(0, "Network error");
  }
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = await response.json();
      code = typeof body?.detail?.code === "string" ? body.detail.code : undefined;
    } catch {
      // Not JSON (e.g. a proxy error page); the status is enough.
    }
    throw new ApiError(response.status, `HTTP ${response.status}`, code);
  }
  return (await response.json()) as T;
}

export function getConfig(signal?: AbortSignal): Promise<PublicConfig> {
  return request("/api/config", { signal });
}

export function getPlacesInArea(
  bbox: [number, number, number, number],
  signal?: AbortSignal,
  limit = 1000,
): Promise<PlaceFeatureCollection> {
  const params = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(6)).join(","), limit: String(limit) });
  return request(`/api/places?${params}`, { signal });
}

export function listPlaces(
  options: { q?: string; limit: number; offset: number },
  signal?: AbortSignal,
): Promise<PlaceList> {
  const params = new URLSearchParams({ limit: String(options.limit), offset: String(options.offset) });
  if (options.q) params.set("q", options.q);
  return request(`/api/places/list?${params}`, { signal });
}

export function getPlace(id: string, signal?: AbortSignal): Promise<Place> {
  return request(`/api/places/${encodeURIComponent(id)}`, { signal });
}

export function createPlace(place: NewPlace, signal?: AbortSignal): Promise<Place> {
  return request("/api/places", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(place),
    signal,
  });
}
