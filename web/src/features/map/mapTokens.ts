// Colours of the provider's vector style, taken from our design tokens.
import type * as maplibregl from "maplibre-gl";

const token = (css: CSSStyleDeclaration, name: string) => css.getPropertyValue(name).trim();

function setPaint(map: maplibregl.Map, layerId: string, property: string, value: string): void {
  try {
    map.setPaintProperty(layerId, property as never, value as never);
  } catch {
    // A layer that does not take this property keeps its look.
  }
}

/**
 * The quiet basemap of the design: land, water, roads and labels in the
 * --map-* tokens, whatever colours the provider's style came with. Layers are
 * matched by the usual names; one that is not recognised keeps its colour.
 */
export function applyMapTokens(map: maplibregl.Map): void {
  const css = getComputedStyle(document.documentElement);
  const land = token(css, "--map-land");
  const water = token(css, "--map-water");
  const road = token(css, "--map-road");
  const label = token(css, "--map-label");
  if (!land) return;
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith("sa-")) continue;
    if (layer.type === "background") setPaint(map, layer.id, "background-color", land);
    else if (layer.type === "fill" && /water|ocean|lake|river/.test(layer.id)) setPaint(map, layer.id, "fill-color", water);
    else if (layer.type === "fill") setPaint(map, layer.id, "fill-color", land);
    else if (layer.type === "line" && /water|river|canal/.test(layer.id)) setPaint(map, layer.id, "line-color", water);
    else if (layer.type === "line") setPaint(map, layer.id, "line-color", road);
    else if (layer.type === "symbol") {
      setPaint(map, layer.id, "text-color", label);
      setPaint(map, layer.id, "text-halo-color", land);
    }
  }
}

/** Roads and labels that can be read on top of a photograph. */
export function applyImageryTokens(map: maplibregl.Map): void {
  const css = getComputedStyle(document.documentElement);
  const label = token(css, "--map-label-on-image");
  const halo = token(css, "--map-halo-on-image");
  const road = token(css, "--map-road-on-image");
  if (!label) return;
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith("sa-")) continue;
    if (layer.type === "line") setPaint(map, layer.id, "line-color", road);
    else if (layer.type === "symbol") {
      setPaint(map, layer.id, "text-color", label);
      setPaint(map, layer.id, "text-halo-color", halo);
    }
  }
}
