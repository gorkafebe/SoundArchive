// The clocks of the search, on simulated browsers and a simulated clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GEO_SCENARIOS, installGeoScenario, removeGeoScenario, type GeoLog, type GeoScenario } from "../../test/geoScenarios";
import { DECISION_MS, HIGH_ACCURACY_MS, LOW_ACCURACY_MS, permissionDecided, searchPosition, type SearchEnd } from "./searchPosition";

const limits = { highMs: HIGH_ACCURACY_MS, lowMs: LOW_ACCURACY_MS };
const openWatches = () => (globalThis as unknown as { __geoLog: GeoLog }).__geoLog.openWatches;

async function start(scenario: GeoScenario, withDialog = false) {
  installGeoScenario(scenario);
  const ends: SearchEnd[] = [];
  const decided = withDialog
    ? permissionDecided(await navigator.permissions.query({ name: "geolocation" }), DECISION_MS)
    : undefined;
  const cancel = searchPosition(navigator.geolocation, { ...limits, decided }, (end) => ends.push(end));
  return { ends, cancel };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  removeGeoScenario();
});

describe("how long it takes", () => {
  it("total silence ends after both attempts, at 18 s, and nothing is left listening", async () => {
    const { ends } = await start(GEO_SCENARIOS.silence);
    await vi.advanceTimersByTimeAsync(17_999);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ends).toEqual([{ kind: "noResponse", detail: null }]);
    expect(openWatches()).toBe(0);
  });

  it("the time the browser's dialog is open does not count", async () => {
    const { ends } = await start(GEO_SCENARIOS.slowDialog, true);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(500 + HIGH_ACCURACY_MS + 1);
    expect(ends).toHaveLength(1);
    expect(ends[0].kind).toBe("found");
  });

  it("a dialog nobody ever answers still ends", async () => {
    const { ends } = await start({ ...GEO_SCENARIOS.silence, permission: "prompt", dialogMs: 10 * 60_000 }, true);
    await vi.advanceTimersByTimeAsync(DECISION_MS + HIGH_ACCURACY_MS + LOW_ACCURACY_MS - 1);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ends).toEqual([{ kind: "noResponse", detail: null }]);
  });

  it("cancelling stops everything and reports nothing", async () => {
    const { ends, cancel } = await start(GEO_SCENARIOS.after3s);
    await vi.advanceTimersByTimeAsync(100);
    expect(openWatches()).toBe(1);
    cancel();
    expect(openWatches()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ends).toEqual([]);
  });
});

describe("what it keeps", () => {
  it("a reading from the first attempt is never thrown away for a later failure", async () => {
    const { ends } = await start({
      permission: "granted",
      high: [
        { atMs: 100, fix: { lat: 41.65, lon: -0.88, accuracy: 700 } },
        { atMs: 200, error: { code: 2, message: "lost it" } },
      ],
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(ends).toEqual([{ kind: "found", reading: { lat: 41.65, lon: -0.88, meters: 700 } }]);
  });

  it("a refusal ends it at once: no second attempt", async () => {
    const { ends } = await start({ permission: "granted", high: [{ atMs: 100, error: { code: 1, message: "no" } }] });
    await vi.advanceTimersByTimeAsync(200);
    expect(ends).toEqual([{ kind: "denied", detail: { code: 1, message: "no" } }]);
    expect((globalThis as unknown as { __geoLog: GeoLog }).__geoLog.calls).toHaveLength(1);
  });

  it("the second attempt does not ask for high accuracy, and takes its first reading", async () => {
    const { ends } = await start(GEO_SCENARIOS.highFails);
    await vi.advanceTimersByTimeAsync(1000);
    expect((globalThis as unknown as { __geoLog: GeoLog }).__geoLog.calls.map((call) => call.highAccuracy)).toEqual([true, false]);
    expect(ends[0]).toMatchObject({ kind: "found", reading: { meters: 900 } });
  });
});
