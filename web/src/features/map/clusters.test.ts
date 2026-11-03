import { describe, expect, it } from "vitest";

import type { PlaceFeature } from "../../lib/api";
import { buildIndex, clustersFor } from "./clusters";

const feature = (id: string, lon: number, lat: number): PlaceFeature => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { name: `Place ${id}` },
});

describe("clusters", () => {
  const nearby = Array.from({ length: 10 }, (_, i) => feature(`b${i}`, -2.93 + i * 0.001, 43.26));
  const far = feature("far", 2.17, 41.39);

  it("groups nearby places when zoomed out, with a count", () => {
    const items = clustersFor(buildIndex([...nearby, far]), [-10, 35, 5, 45], 5);
    const cluster = items.find((i) => i.kind === "cluster");
    expect(cluster).toMatchObject({ kind: "cluster", count: 10 });
    expect(items.find((i) => i.kind === "place")).toMatchObject({ id: "far", name: "Place far" });
  });

  it("shows every place on its own when zoomed in", () => {
    const items = clustersFor(buildIndex(nearby), [-3, 43.2, -2.8, 43.3], 17);
    expect(items).toHaveLength(10);
    expect(items.every((i) => i.kind === "place")).toBe(true);
  });

  it("handles a view across the date line", () => {
    const index = buildIndex([feature("east", 179.5, -17), feature("west", -179.5, -17), feature("zero", 0, -17)]);
    const ids = clustersFor(index, [179, -20, -179, -10], 10)
      .map((i) => (i.kind === "place" ? i.id : "cluster"))
      .sort();
    expect(ids).toEqual(["east", "west"]);
  });
});
