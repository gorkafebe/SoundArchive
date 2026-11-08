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
  for (const [, name, hex] of match[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) {
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
  ["ink", "surface-100", TEXT, "body text"],
  ["ink", "surface-200", TEXT, "text on cards and sheets"],
  ["ink", "surface-300", TEXT, "text on chips"],
  ["ink", "accent-soft", TEXT, "text on the playing card"],
  ["ink-muted", "surface-100", TEXT, "secondary text"],
  ["ink-muted", "surface-200", TEXT, "secondary text on cards"],
  ["ink-muted", "surface-300", TEXT, "secondary text on chips"],
  ["on-accent", "accent", TEXT, "label on a solid accent"],
  ["accent", "surface-100", TEXT, "accent text"],
  ["accent", "surface-200", TEXT, "accent text on cards"],
  ["accent", "surface-300", TEXT, "accent text on chips"],
  ["accent", "accent-soft", TEXT, "accent text on the playing card"],
  ["success", "surface-300", TEXT, "success badge"],
  ["warning", "surface-300", TEXT, "warning badge"],
  ["danger", "surface-300", TEXT, "danger badge"],
  ["danger", "surface-100", TEXT, "error text"],
  ["danger", "surface-200", TEXT, "error text on cards"],
  ["surface-100", "ink", TEXT, "toast"],
  ["line-strong", "surface-100", UI, "control borders"],
  ["line-strong", "surface-200", UI, "control borders on cards"],
  ["focus-ring", "surface-100", UI, "focus ring"],
  ["focus-ring", "surface-200", UI, "focus ring on cards"],
  ["accent", "surface-200", UI, "pin dot against its ring"],
  ["danger", "surface-200", UI, "danger button border"],
];

let failures = 0;
for (const [theme, t] of Object.entries(themes)) {
  for (const [fg, bg, min, what] of pairs) {
    const a = t[fg];
    const b = t[bg];
    if (!a || !b) {
      console.error(`FAIL ${theme}: missing --${fg} or --${bg}`);
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
