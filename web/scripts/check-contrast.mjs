// Checks the colour pairs the interface uses against WCAG 2.2 AA, in both
// themes: 4.5:1 for text, 3:1 for interface parts (borders, focus ring, pins).
// Reads the hex colours straight from src/styles/tokens.css, so changing a
// token re-checks it. Run: npm run check:contrast (part of npm run check).
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function block(selectorRegex) {
  const match = css.match(selectorRegex);
  if (!match) throw new Error(`No block for ${selectorRegex}`);
  const tokens = {};
  for (const [, name, hex] of match[1].matchAll(/--(color-[a-z-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    tokens[name] = hex;
  }
  return tokens;
}

const themes = {
  light: block(/\[data-theme="light"\]\s*\{([^}]*)\}/),
  dark: block(/\[data-theme="dark"\]\s*\{([^}]*)\}/),
};

// Relative luminance and contrast ratio, as defined in WCAG 2.x.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum, what it is]
const TEXT = 4.5;
const UI = 3;
const pairs = [
  ["text", "bg", TEXT, "body text"],
  ["text", "surface", TEXT, "text in panels"],
  ["text", "surface-sunken", TEXT, "text on hover/selected rows"],
  ["text", "accent-soft", TEXT, "text in info boxes"],
  ["text", "danger-soft", TEXT, "text in error boxes"],
  ["text-muted", "bg", TEXT, "secondary text"],
  ["text-muted", "surface", TEXT, "secondary text in panels"],
  ["text-muted", "surface-sunken", TEXT, "secondary text on hover"],
  ["text-on-accent", "accent", TEXT, "label of the main button, pin count"],
  ["text-on-accent", "accent-hover", TEXT, "main button on hover"],
  ["accent", "bg", TEXT, "links"],
  ["accent", "surface", TEXT, "links in panels"],
  ["danger", "bg", TEXT, "error text"],
  ["danger", "surface", TEXT, "error text in panels"],
  ["danger", "danger-soft", TEXT, "error box text"],
  ["border", "bg", UI, "input and button borders"],
  ["border", "surface", UI, "borders in panels"],
  ["focus", "bg", UI, "focus ring"],
  ["focus", "surface", UI, "focus ring in panels"],
  // No "focus on accent" pair: the ring is always drawn with a gap
  // (outline-offset in base.css), so it sits on the page or panel colour,
  // never touching the accent button.
  ["accent", "surface", UI, "pin dot against its ring"],
  ["danger", "surface", UI, "invalid input border"],
];

let failures = 0;
for (const [theme, t] of Object.entries(themes)) {
  for (const [fg, bg, min, what] of pairs) {
    const a = t[`color-${fg}`];
    const b = t[`color-${bg}`];
    if (!a || !b) {
      console.error(`FAIL ${theme}: missing --color-${fg} or --color-${bg}`);
      failures++;
      continue;
    }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) failures++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${theme.padEnd(5)} ${r.toFixed(2).padStart(5)}:1 (min ${min}) ${fg} on ${bg} - ${what}`,
    );
  }
}
if (failures) {
  console.error(`\n${failures} colour pair(s) below the WCAG AA minimum.`);
  process.exit(1);
}
console.log("\nAll colour pairs meet WCAG AA in both themes.");
