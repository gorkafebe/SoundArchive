// Clustering: when many pins would overlap, show one circle with a count.
//
// Supercluster (the same library MapLibre uses inside) groups the points for
// a zoom level. We render the result as HTML buttons (see markers.ts), not
// as WebGL circles, because buttons are reachable with the keyboard, have
// accessible names, and can be made 44 px tall.
import Supercluster, { type ClusterProperties } from "supercluster";

import type { PlaceFeature } from "../../lib/api";
import type { Bbox } from "./geo";

export type PlaceProps = { id: string; name: string };

export type ClusterItem =
  | { kind: "place"; id: string; name: string; lon: number; lat: number }
  | { kind: "cluster"; clusterId: number; count: number; lon: number; lat: number };

export function buildIndex(features: PlaceFeature[]): Supercluster<PlaceProps> {
  // radius: how close (in screen pixels) pins must be to merge.
  // maxZoom: from this zoom on, every place shows on its own.
  const index = new Supercluster<PlaceProps>({ radius: 56, maxZoom: 16 });
  index.load(
    features.map((f) => ({
      type: "Feature" as const,
      geometry: f.geometry,
      properties: { id: f.id, name: f.properties.name },
    })),
  );
  return index;
}

export function clustersFor(index: Supercluster<PlaceProps>, bbox: Bbox, zoom: number): ClusterItem[] {
  // Supercluster handles minLon > maxLon (crossing the date line) itself.
  return index.getClusters(bbox, Math.floor(zoom)).map((feature) => {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties as Partial<ClusterProperties> & Partial<PlaceProps>;
    if (props.cluster) {
      return { kind: "cluster", clusterId: props.cluster_id!, count: props.point_count!, lon, lat };
    }
    return { kind: "place", id: props.id!, name: props.name!, lon, lat };
  });
}
