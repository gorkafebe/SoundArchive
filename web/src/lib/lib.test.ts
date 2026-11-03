import { describe, expect, it, vi } from "vitest";

import { boundsToBbox, wrapLongitude } from "../features/map/geo";
import { initialLanguage, translate } from "../i18n/i18n";
import { readStored, writeStored } from "./storage";
import { initialThemeChoice } from "./theme";
import { parseUrlState, toSearch } from "./urlState";

describe("translate", () => {
  it("fills placeholders and formats numbers per language", () => {
    expect(translate("es", "list.page", { page: 2, pages: 7 })).toBe("Página 2 de 7");
    expect(translate("en", "list.page", { page: 2, pages: 1200 })).toBe("Page 2 of 1,200");
    expect(translate("en", "add.step", { step: 1, total: 3, name: "Location" })).toBe("Step 1 of 3: Location");
  });

  it("picks the plural form", () => {
    expect(translate("es", "list.results", { count: 1 })).toBe("1 lugar");
    expect(translate("es", "list.results", { count: 5 })).toBe("5 lugares");
    expect(translate("en", "list.results", { count: 1 })).toBe("1 place");
  });

  it("shows the key when a text is missing", () => {
    expect(translate("en", "does.not.exist")).toBe("does.not.exist");
  });
});

describe("initialLanguage", () => {
  it("uses English only when the browser prefers English", () => {
    expect(initialLanguage(null, ["en-GB", "es"])).toBe("en");
    expect(initialLanguage(null, ["es-ES", "en"])).toBe("es");
    expect(initialLanguage(null, ["fr-FR"])).toBe("es");
    expect(initialLanguage(null, [])).toBe("es");
  });
  it("prefers the saved choice", () => {
    expect(initialLanguage("en", ["es"])).toBe("en");
    expect(initialLanguage("xx", ["en"])).toBe("en");
  });
});

describe("theme", () => {
  it("is light unless the user chose otherwise", () => {
    expect(initialThemeChoice(null)).toBe("light");
    expect(initialThemeChoice("dark")).toBe("dark");
    expect(initialThemeChoice("system")).toBe("system");
    expect(initialThemeChoice("purple")).toBe("light");
  });
});

describe("storage", () => {
  it("survives a localStorage that throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readStored("x")).toBeNull();
    expect(() => writeStored("x", "y")).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe("url state", () => {
  it("round-trips a shared view", () => {
    const state = {
      view: "map" as const,
      lat: 43.263,
      lon: -2.935,
      zoom: 13,
      place: "0e3f1d2a-1111-4222-8333-944455556666",
    };
    expect(parseUrlState(toSearch(state))).toEqual({ ...state, q: undefined, page: undefined });
  });

  it("ignores invalid values", () => {
    const parsed = parseUrlState("?view=nope&lat=95&lon=10&z=abc&place=../etc&page=-3");
    expect(parsed).toEqual({ view: "map", zoom: undefined, place: undefined, q: undefined, page: undefined });
  });

  it("keeps list search and page", () => {
    expect(parseUrlState("?view=list&q=harbour&page=3")).toMatchObject({ view: "list", q: "harbour", page: 3 });
  });
});

describe("map rectangle", () => {
  it("wraps longitudes into -180..180", () => {
    expect(wrapLongitude(190)).toBe(-170);
    expect(wrapLongitude(-190)).toBe(170);
    expect(wrapLongitude(180)).toBe(180);
    expect(wrapLongitude(-180)).toBe(-180);
    expect(wrapLongitude(45)).toBe(45);
  });

  it("turns a view across the date line into minLon > maxLon", () => {
    expect(boundsToBbox(170, -20, 190, -10)).toEqual([170, -20, -170, -10]);
  });

  it("uses the whole world when the view is wider than 360°", () => {
    expect(boundsToBbox(-300, -95, 200, 95)).toEqual([-180, -90, 180, 90]);
  });
});
