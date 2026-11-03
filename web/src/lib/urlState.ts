// What the web address remembers, so a view can be shared or bookmarked:
//   ?view=map&lat=43.26300&lon=-2.93500&z=13.00&place=<id>
//   ?view=list&q=harbour&page=2&place=<id>
// Values that are missing or invalid are simply ignored (a hand-edited or
// truncated link still opens the app). The app updates the address with
// history.replaceState, so moving the map does not fill the Back button.

export type View = "map" | "list";

export interface UrlState {
  view: View;
  lat?: number;
  lon?: number;
  zoom?: number;
  place?: string;
  q?: string;
  page?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function number(value: string | null, min: number, max: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const lat = number(params.get("lat"), -90, 90);
  const lon = number(params.get("lon"), -180, 180);
  const place = params.get("place") ?? undefined;
  const page = number(params.get("page"), 1, 100000);
  const q = params.get("q")?.slice(0, 200) || undefined;
  return {
    view: params.get("view") === "list" ? "list" : "map",
    // A centre needs both numbers.
    ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
    zoom: number(params.get("z"), 0, 22),
    place: place && UUID.test(place) ? place.toLowerCase() : undefined,
    q,
    page: page !== undefined ? Math.floor(page) : undefined,
  };
}

export function toSearch(state: UrlState): string {
  const params = new URLSearchParams();
  params.set("view", state.view);
  if (state.lat !== undefined && state.lon !== undefined) {
    params.set("lat", state.lat.toFixed(5));
    params.set("lon", state.lon.toFixed(5));
  }
  if (state.zoom !== undefined) params.set("z", state.zoom.toFixed(2));
  if (state.place) params.set("place", state.place);
  if (state.q) params.set("q", state.q);
  if (state.page && state.page > 1) params.set("page", String(state.page));
  return `?${params.toString()}`;
}
