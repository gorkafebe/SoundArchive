// Pins and clusters as real HTML <button>s placed on the map.
//
// Why buttons rather than shapes drawn in WebGL: a button can be reached
// with Tab, activated with Enter or Space, has a name a screen reader reads
// ("Fountain 12"), and its clickable area can be 44 x 44 px while the
// visible dot stays small. MapLibre's Marker keeps each one at its
// coordinates while the map moves.
import * as maplibregl from "maplibre-gl";

import type { ClusterItem } from "./clusters";

export interface MarkerHandlers {
  onPlace: (id: string) => void;
  onCluster: (clusterId: number, lon: number, lat: number) => void;
}

export interface MarkerLabels {
  place: (name: string, selected: boolean) => string;
  cluster: (count: number) => string;
}

type Entry = { marker: maplibregl.Marker; element: HTMLButtonElement; item: ClusterItem };

const keyOf = (item: ClusterItem) => (item.kind === "place" ? `p:${item.id}` : `c:${item.clusterId}`);

export class MarkerLayer {
  private entries = new Map<string, Entry>();
  private selectedId: string | null = null;
  private readonly map: maplibregl.Map;
  private readonly handlers: MarkerHandlers;
  private labels: MarkerLabels;

  constructor(map: maplibregl.Map, handlers: MarkerHandlers, labels: MarkerLabels) {
    this.map = map;
    this.handlers = handlers;
    this.labels = labels;
  }

  /** Show exactly these items: add new markers, keep existing, remove the rest. */
  update(items: ClusterItem[]): void {
    const wanted = new Map(items.map((item) => [keyOf(item), item]));
    for (const [key, entry] of this.entries) {
      if (!wanted.has(key)) {
        entry.marker.remove();
        this.entries.delete(key);
      }
    }
    for (const [key, item] of wanted) {
      const existing = this.entries.get(key);
      if (existing) {
        existing.item = item;
        existing.marker.setLngLat([item.lon, item.lat]);
        this.decorate(existing);
        continue;
      }
      const element = document.createElement("button");
      element.type = "button";
      element.dataset.key = key;
      const entry: Entry = { element, item, marker: new maplibregl.Marker({ element, anchor: "center" }) };
      element.addEventListener("click", (event) => {
        event.stopPropagation(); // not a click on the map itself
        const current = entry.item;
        if (current.kind === "place") this.handlers.onPlace(current.id);
        else this.handlers.onCluster(current.clusterId, current.lon, current.lat);
      });
      this.decorate(entry);
      entry.marker.setLngLat([item.lon, item.lat]).addTo(this.map);
      this.entries.set(key, entry);
    }
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    for (const entry of this.entries.values()) this.decorate(entry);
  }

  setLabels(labels: MarkerLabels): void {
    this.labels = labels;
    for (const entry of this.entries.values()) this.decorate(entry);
  }

  /** Where a place's pin is, if it is on the map right now. */
  positionOf(id: string): [number, number] | null {
    const item = this.entries.get(`p:${id}`)?.item;
    return item ? [item.lon, item.lat] : null;
  }

  /** Move keyboard focus to a place's pin. False if it is not on screen (e.g. inside a cluster). */
  focusPlace(id: string): boolean {
    const entry = this.entries.get(`p:${id}`);
    if (!entry) return false;
    entry.element.focus();
    return true;
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.marker.remove();
    this.entries.clear();
  }

  private decorate({ element, item }: Entry): void {
    if (item.kind === "place") {
      const selected = item.id === this.selectedId;
      setClasses(element, { "map-pin": true, "map-pin--selected": selected, "map-cluster": false, "map-cluster--large": false });
      element.setAttribute("aria-label", this.labels.place(item.name, selected));
      element.setAttribute("aria-pressed", String(selected));
      element.replaceChildren(dot());
      // The selected pin is drawn above its neighbours.
      element.style.zIndex = selected ? "2" : "1";
    } else {
      setClasses(element, {
        "map-pin": false,
        "map-pin--selected": false,
        "map-cluster": true,
        "map-cluster--large": item.count >= 100,
      });
      element.setAttribute("aria-label", this.labels.cluster(item.count));
      element.removeAttribute("aria-pressed");
      const count = document.createElement("span");
      count.className = "map-cluster__count";
      count.setAttribute("aria-hidden", "true"); // the label already says it
      count.textContent = item.count >= 1000 ? `${Math.floor(item.count / 1000)}k` : String(item.count);
      element.replaceChildren(count);
      element.style.zIndex = "1";
    }
  }
}

// classList, not className: MapLibre adds its own classes to the element.
function setClasses(element: HTMLElement, classes: Record<string, boolean>): void {
  for (const [name, on] of Object.entries(classes)) element.classList.toggle(name, on);
}

function dot(): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "map-pin__dot";
  span.setAttribute("aria-hidden", "true");
  return span;
}
