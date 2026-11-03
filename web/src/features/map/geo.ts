// Turning what the map shows into the rectangle the API expects.
//
// MapLibre can show several copies of the world side by side, so the visible
// longitudes can go past 180 (e.g. west 170, east 200). The API accepts
// -180..180 only, and reads minLon > maxLon as "crosses the 180° meridian"
// (see backend/app/places.py). So:
//   - a view 360° wide or more  -> the whole world
//   - otherwise, wrap both edges into -180..180; if west ends up east of
//     east, the view crosses the date line, which the API understands.

export type Bbox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat

export function wrapLongitude(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  // Keep +180 as +180 rather than turning it into -180.
  return wrapped === -180 && lon > 0 ? 180 : wrapped;
}

const clampLat = (lat: number) => Math.max(-90, Math.min(90, lat));

export function boundsToBbox(west: number, south: number, east: number, north: number): Bbox {
  if (east - west >= 360) return [-180, clampLat(south), 180, clampLat(north)];
  return [wrapLongitude(west), clampLat(south), wrapLongitude(east), clampLat(north)];
}

/** Coordinates for people: "43.26300° N, 2.93500° W" (decimal mark per language). */
export function formatCoordinates(
  lat: number,
  lon: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
  language: string,
): string {
  const format = new Intl.NumberFormat(language, { minimumFractionDigits: 5, maximumFractionDigits: 5 });
  return t("coords.value", {
    lat: format.format(Math.abs(lat)),
    ns: t(lat >= 0 ? "coords.north" : "coords.south"),
    lon: format.format(Math.abs(lon)),
    ew: t(lon >= 0 ? "coords.east" : "coords.west"),
  });
}
