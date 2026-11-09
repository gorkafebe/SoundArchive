// Quality checks: automatic accessibility audit (axe), keyboard-only use,
// target sizes, reduced motion, and screenshots for a human to look at.
import { mkdirSync, writeFileSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { freshCoordinates, expect, prepare, test, waitForPins } from "./fixtures";

const SCREENS = "test-results/screens";
const SPAIN = "/?view=map&lat=40.50000&lon=-2.50000&z=5.50";
const BILBAO = "/?view=map&lat=43.26300&lon=-2.93500&z=14.00";

/** The main screens, each reached the way a person would. */
const screens: Record<string, (page: Page) => Promise<void>> = {
  map: async (page) => {
    await page.goto(SPAIN);
    await waitForPins(page);
  },
  "map-place-open": async (page) => {
    await page.goto(BILBAO);
    await waitForPins(page);
    await page.locator(".map-pin").first().click();
    await expect(page.getByRole("complementary").getByRole("heading", { level: 2 })).toBeFocused();
    await page.waitForTimeout(1000); // the map may re-centre on the selected pin
  },
  list: async (page) => {
    await page.goto("/?view=list");
    await expect(page.locator(".place-list__item").first()).toBeVisible();
  },
  "list-place-open": async (page) => {
    await page.goto("/?view=list");
    await page.locator(".place-list__item").first().click();
    await expect(page.getByRole("complementary").getByRole("heading", { level: 2 })).toBeFocused();
  },
  "add-step-1": async (page) => {
    await page.goto(BILBAO);
    await page.getByRole("button", { name: "Añadir lugar" }).click();
    await page.getByRole("button", { name: "Elegir en el mapa" }).click();
    await expect(page.locator(".location-picker canvas")).toBeVisible();
  },
  "add-errors": async (page) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Añadir lugar" }).click();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await expect(page.getByLabel("Latitud")).toHaveAttribute("aria-invalid", "true");
  },
};

test.describe("axe accessibility audit", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const [name, open] of Object.entries(screens)) {
      test(`${name}, ${theme} theme: no serious or critical violations`, async ({ page }) => {
        await prepare(page, { theme });
        await open(page);
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
          .analyze();
        // Keep the full result for the report, whatever its impact.
        mkdirSync("test-results/axe", { recursive: true });
        const summary = results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
        }));
        writeFileSync(
          `test-results/axe/${name}-${theme}.json`,
          JSON.stringify({ passes: results.passes.length, violations: summary }, null, 2),
        );
        // Justified exception: a pin that happens to sit under the floating top
        // bar counts as a covered target. The list view reaches every place.
        // (A pin, not any other control: checked in the page itself.)
        const isPin = (selector: string) =>
          page.evaluate((s) => document.querySelector(s)?.closest(".map-pin, .map-cluster") != null, selector);
        const serious = [];
        for (const v of results.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
          const pins = await Promise.all(v.nodes.map((n) => isPin(n.target.join(" "))));
          if (v.id === "target-size" && pins.every(Boolean)) continue;
          serious.push({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) });
        }
        expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
      });
    }
  }
});

test.describe("keyboard only", () => {
  /** Press Tab until the focused element matches, like a person would. */
  async function tabTo(page: Page, accessibleName: RegExp, max = 40) {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press("Tab");
      const name = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? el.getAttribute("aria-label") || el.textContent || "" : "";
      });
      if (accessibleName.test(name.trim())) return;
    }
    throw new Error(`Never reached ${accessibleName} with Tab`);
  }

  test("main flow: skip link, map, pin, panel, list, search, add a place", async ({ page }) => {
    await prepare(page);
    await page.goto(BILBAO);
    await waitForPins(page);

    // 1. The first Tab reaches the skip link, which jumps to the content.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Saltar al contenido" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    // 2. The main action comes first, then the map: arrow keys move it, + zooms in.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Añadir lugar" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(".maplibregl-canvas")).toBeFocused();
    const before = new URL(page.url()).searchParams;
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => new URL(page.url()).searchParams.get("lon")).not.toBe(before.get("lon"));
    await page.keyboard.press("Equal"); // the "=" / "+" key
    await expect.poll(() => Number(new URL(page.url()).searchParams.get("z"))).toBeGreaterThan(Number(before.get("z")));

    // 3. A pin: Enter opens its panel and the focus goes there; Escape
    //    closes it and the focus returns to the pin.
    await page.keyboard.press("Tab");
    const pin = page.locator(".map-pin:focus, .map-cluster:focus");
    await expect(pin).toHaveCount(1);
    if (await page.locator(".map-pin:focus").count()) {
      const name = (await pin.getAttribute("aria-label"))!;
      await page.keyboard.press("Enter");
      await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
    }

    // 4. The list: from the top of the (reloaded) page.
    await page.reload();
    await waitForPins(page);
    await tabTo(page, /^Lista$/);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/view=list/);
    await tabTo(page, /^$/); // the search box has no text content; its label names it
    await expect(page.getByRole("searchbox", { name: "Buscar lugares" })).toBeFocused();
    await page.keyboard.type("Fountain");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/q=Fountain/);
    await tabTo(page, /^Buscar$/);
    await tabTo(page, /Fountain/);
    await page.keyboard.press("Enter");
    const heading = page.getByRole("complementary").getByRole("heading", { level: 2 });
    await expect(heading).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".place-list__item:focus")).toHaveCount(1);

    // 5. Add a place, all from the keyboard, from the top of the page.
    await page.reload();
    await expect(page.getByRole("button", { name: "Añadir lugar" })).toBeVisible();
    await tabTo(page, /^Añadir lugar$/);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 2 })).toBeFocused();
    await tabTo(page, /^Avanzado/);
    await page.keyboard.press("Enter"); // unfolds the coordinates
    await tabTo(page, /^$/);
    await expect(page.getByLabel("Latitud")).toBeFocused();
    const coordinates = freshCoordinates();
    await page.keyboard.type(coordinates.lat);
    await page.keyboard.press("Tab");
    await page.keyboard.type(coordinates.lon);
    await page.keyboard.press("Enter"); // submits the step
    const name = page.getByRole("textbox", { name: "Nombre" });
    await expect(name).toBeVisible();
    await tabTo(page, /^$/);
    await expect(name).toBeFocused();
    await page.keyboard.type(`E2E teclado ${Date.now()}`);
    await page.keyboard.press("Enter");
    await tabTo(page, /^Crear el lugar$/);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("complementary").getByRole("heading", { level: 2, name: /E2E teclado/ })).toBeFocused();
  });
});

test.describe("target size", () => {
  for (const [name, open] of Object.entries(screens)) {
    test(`${name}: every control is at least 44 x 44 px`, async ({ page }) => {
      await prepare(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page);
      const small = await page.evaluate(() => {
        const selector = "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1']), [role='button']";
        return [...document.querySelectorAll<HTMLElement>(selector)]
          .filter((el) => {
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || el.closest("[hidden]")) return false;
            // Exceptions allowed by WCAG 2.5.8: links inside a sentence
            // (the map attribution line). The map canvas is the whole map.
            if (el.closest(".maplibregl-ctrl-attrib")) return false;
            if (el.classList.contains("maplibregl-canvas")) return false;
            // A checkbox inside its label: the whole 44 px label is the target.
            if (el.matches("label input[type=checkbox]")) return false;
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && (box.width < 43.5 || box.height < 43.5);
          })
          .map((el) => {
            const box = el.getBoundingClientRect();
            return `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`;
          });
      });
      expect(small).toEqual([]);
    });
  }
  test("the skip link is 44 px tall when it appears", async ({ page }) => {
    await prepare(page);
    await page.goto("/");
    await page.keyboard.press("Tab");
    const box = await page.getByRole("link", { name: "Saltar al contenido" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("reduced motion", () => {
  async function longestTransition(page: Page) {
    return page.evaluate(() =>
      Math.max(
        0,
        ...[...document.querySelectorAll("*")].flatMap((el) => {
          const style = getComputedStyle(el);
          return [...style.transitionDuration.split(","), ...style.animationDuration.split(",")].map(
            (d) => parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000),
          );
        }),
      ),
    );
  }

  test("with prefers-reduced-motion, nothing on the page animates", async ({ page }) => {
    await prepare(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await screens["map-place-open"](page);
    expect(await longestTransition(page)).toBe(0);
  });

  test("without it, the calm transitions are there (so the check above means something)", async ({ page }) => {
    await prepare(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await screens["map-place-open"](page);
    expect(await longestTransition(page)).toBeGreaterThan(0);
  });
});

test.describe("screenshots", () => {
  const viewports = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } };
  for (const [device, viewport] of Object.entries(viewports)) {
    for (const theme of ["light", "dark"] as const) {
      test(`${device} ${theme}`, async ({ page }) => {
        mkdirSync(SCREENS, { recursive: true });
        await prepare(page, { theme });
        await page.setViewportSize(viewport);
        for (const name of ["map", "map-place-open", "list-place-open", "add-step-1", "add-errors"]) {
          await screens[name](page);
          await page.waitForTimeout(300); // let the map finish drawing
          await page.screenshot({ path: `${SCREENS}/${device}-${theme}-${name}.png` });
        }
      });
    }
  }
  test("phone light, English, list", async ({ page }) => {
    await prepare(page, { language: "en" });
    await page.setViewportSize(viewports.phone);
    await page.goto("/?view=list");
    await expect(page.locator(".place-list__item").first()).toBeVisible();
    await page.screenshot({ path: `${SCREENS}/phone-light-en-list.png` });
  });
});
