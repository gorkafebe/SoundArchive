// Fails if a colour or a font name appears outside src/styles/tokens.css.
//
// Why: the visual design is not done yet. When it arrives, replacing one file
// (tokens.css) must be enough. A colour hard-coded in a component would
// survive the swap and look wrong. Components use var(--color-...) instead.
//
// What counts as a colour: #rgb/#rrggbb/#rrggbbaa codes, rgb()/rgba()/hsl()/
// hsla()/oklch()/lab()/color() functions, and CSS named colours used as a
// value (red, white, black...). What counts as a font: a font-family
// declaration or a well-known font name.
//
// Run: npm run check:tokens (part of npm run check).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const TOKENS = join(root, "src/styles/tokens.css");
const SCAN = [join(root, "src"), join(root, "index.html")];
const EXTENSIONS = /\.(css|tsx?|html|json)$/;

const NAMED = [
  "black", "white", "red", "green", "blue", "yellow", "orange", "purple", "gray", "grey",
  "silver", "maroon", "navy", "teal", "olive", "lime", "aqua", "fuchsia", "pink", "brown",
  "beige", "ivory", "khaki", "salmon", "gold", "crimson", "indigo", "violet", "tan",
];
const FONTS = [
  "Arial", "Helvetica", "Roboto", "Segoe UI", "Inter", "Noto Sans", "Open Sans", "Lato",
  "Georgia", "Times New Roman", "Courier", "Menlo", "Consolas", "system-ui", "sans-serif",
  "serif", "monospace",
];

const rules = [
  { name: "hex colour", re: /#[0-9a-f]{3,8}\b(?![-\w])/gi, cssOnly: false },
  { name: "colour function", re: /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/gi, cssOnly: false },
  // A font-family that is only a token (var(--font-...)) or inherit is fine.
  { name: "font-family", re: /font-family\s*:(?!\s*(?:var\(--font-|inherit))/gi, cssOnly: false },
  { name: "fontFamily", re: /fontFamily\s*:(?!\s*["']var\(--font-)/g, cssOnly: false },
  {
    name: "named colour",
    re: new RegExp(`(?:color|background|border|fill|stroke|outline)[\\w-]*\\s*:\\s*[^;]*\\b(?:${NAMED.join("|")})\\b`, "gi"),
    cssOnly: true,
  },
  {
    name: "font name",
    re: new RegExp(`["'](?:${FONTS.join("|")})["']`, "g"),
    cssOnly: false,
  },
];

function files(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

// Lines in test files may mention colours to test them; none do yet, so no
// exceptions are needed. i18n JSON files are scanned too (no colours there).
const problems = [];
for (const file of SCAN.flatMap(files)) {
  if (file === TOKENS || !EXTENSIONS.test(file)) continue;
  const isCss = file.endsWith(".css");
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // Comments may talk about colours; skip lines that are only a comment.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
    for (const rule of rules) {
      if (rule.cssOnly && !isCss) continue;
      rule.re.lastIndex = 0;
      if (rule.re.test(line)) {
        problems.push(`${relative(root, file)}:${i + 1}: ${rule.name}: ${trimmed}`);
      }
    }
  });
}

if (problems.length) {
  console.error("Colours or fonts outside src/styles/tokens.css:\n");
  for (const p of problems) console.error("  " + p);
  console.error("\nUse a var(--...) from tokens.css instead (add the token there if needed).");
  process.exit(1);
}
console.log("OK: no colours or font names outside src/styles/tokens.css.");
