// Checks that es.json and en.json have exactly the same keys, that no value
// is empty, and that both use the same {placeholders} in each text.
// A missing key would show the raw key name to people using that language.
// Run: npm run check:i18n (part of npm run check).
import { readFileSync } from "node:fs";

const load = (lang) =>
  JSON.parse(readFileSync(new URL(`../src/i18n/${lang}.json`, import.meta.url), "utf8"));
const languages = { es: load("es"), en: load("en") };

// Nested objects become dotted keys: {"map": {"title": ".."}} -> "map.title".
function flatten(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

const flat = Object.fromEntries(Object.entries(languages).map(([l, d]) => [l, flatten(d)]));
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

const errors = [];
const [a, b] = Object.keys(flat);
for (const [x, y] of [
  [a, b],
  [b, a],
]) {
  for (const key of Object.keys(flat[x])) {
    if (!(key in flat[y])) errors.push(`"${key}" is in ${x}.json but missing from ${y}.json`);
  }
}
for (const [lang, dict] of Object.entries(flat)) {
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value !== "string" || value.trim() === "") errors.push(`${lang}.json: "${key}" is empty`);
  }
}
for (const key of Object.keys(flat[a])) {
  if (key in flat[b] && placeholders(flat[a][key]) !== placeholders(flat[b][key])) {
    errors.push(`"${key}": placeholders differ ({${placeholders(flat[a][key])}} vs {${placeholders(flat[b][key])}})`);
  }
}

if (errors.length) {
  console.error("Translation files do not match:\n");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`OK: es.json and en.json have the same ${Object.keys(flat[a]).length} keys and placeholders.`);
