// Renders docs/design/handoff/screens/*.html to PNG, as the design reference.
// Runs inside the Playwright image (see `make design-screens`). Requests to
// Google Fonts are blocked: the mocks use them, the product must not.
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.SCREENS_DIR ?? "/repo/docs/design/handoff/screens";
const out = process.env.OUT_DIR ?? "/out";

(async () => {
  const browser = await chromium.launch();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort()) {
    const number = Number(file.slice(0, 2));
    const width = number >= 12 ? 1440 : 390;
    const height = number >= 12 ? 900 : 844;
    const page = await browser.newPage({ viewport: { width, height } });
    await page.route("**/*", (route) =>
      route.request().url().startsWith("file:") ? route.continue() : route.abort(),
    );
    await page.goto(`file://${path.join(dir, file)}`);
    await page.screenshot({ path: path.join(out, file.replace(".html", ".png")), fullPage: true });
    await page.close();
    console.log(file, width, height);
  }
  await browser.close();
})();
