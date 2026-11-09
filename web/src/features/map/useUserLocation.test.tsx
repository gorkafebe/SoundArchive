import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MIN_UPDATE_MS, useUserLocation } from "./useUserLocation";

type Ok = PositionCallback;
type Fail = PositionErrorCallback;

const position = (latitude: number, accuracy: number) =>
  ({ coords: { latitude, longitude: -3, accuracy } }) as GeolocationPosition;
const failure = (code: number) =>
  ({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) as GeolocationPositionError;

/** A geolocation whose watches the test drives by hand. */
function stubGeolocation(state: PermissionState | null = "granted") {
  let next = 1;
  const watches = new Map<number, { ok: Ok; fail: Fail }>();
  const watchPosition = vi.fn((ok: Ok, fail: Fail) => {
    const id = next++;
    watches.set(id, { ok, fail });
    return id;
  });
  const clearWatch = vi.fn((id: number) => void watches.delete(id));
  vi.stubGlobal("navigator", {
    ...navigator,
    geolocation: { watchPosition, clearWatch },
    permissions: state ? { query: vi.fn(async () => ({ state })) } : undefined,
  });
  return {
    watchPosition,
    clearWatch,
    watches,
    /** Send a reading to the newest watch. */
    send(latitude: number, accuracy: number) {
      act(() => [...watches.values()].at(-1)!.ok(position(latitude, accuracy)));
    },
    fail(code: number) {
      act(() => [...watches.values()].at(-1)!.fail(failure(code)));
    },
  };
}

function setup(active = true) {
  return renderHook(({ on }) => useUserLocation({ active: on, locateMs: 400 }), { initialProps: { on: active } });
}

async function turnOn(result: ReturnType<typeof setup>["result"], geo: ReturnType<typeof stubGeolocation>) {
  await act(() => result.current.activate());
  // <= 10 m ends the search at once.
  geo.send(40, 8);
  await waitFor(() => expect(result.current.status).toBe("on"));
}

function setHidden(hidden: boolean) {
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.spyOn(performance, "now").mockReturnValue(100_000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("turning on", () => {
  it("starts off and asks for nothing by itself", () => {
    const geo = stubGeolocation();
    const { result } = setup();
    expect(result.current.status).toBe("off");
    expect(result.current.reading).toBeNull();
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });

  it("explains first when permission has not been given, and only then asks", async () => {
    const geo = stubGeolocation("prompt");
    const { result } = setup();
    await act(() => result.current.activate());
    expect(result.current.status).toBe("prompt");
    expect(geo.watchPosition).not.toHaveBeenCalled();
    act(() => result.current.accept());
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());
    expect(result.current.status).toBe("searching");
  });

  it("'not now' goes back to off without asking", async () => {
    const geo = stubGeolocation("prompt");
    const { result } = setup();
    await act(() => result.current.activate());
    act(() => result.current.dismiss());
    expect(result.current.status).toBe("off");
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });

  it("does not explain again when permission is already granted", async () => {
    const geo = stubGeolocation("granted");
    const { result } = setup();
    await act(() => result.current.activate());
    expect(result.current.status).toBe("searching");
    expect(geo.watchPosition).toHaveBeenCalled();
  });

  it("without the Permissions API it explains once per visit", async () => {
    const geo = stubGeolocation(null);
    const { result } = setup();
    await act(() => result.current.activate());
    expect(result.current.status).toBe("prompt");
    act(() => result.current.accept());
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());
    geo.send(40, 8);
    await waitFor(() => expect(result.current.status).toBe("on"));
    act(() => result.current.stop());
    await act(() => result.current.activate());
    expect(result.current.status).toBe("searching");
  });

  it("keeps the most precise reading of the window", async () => {
    const geo = stubGeolocation();
    const { result } = setup();
    await act(() => result.current.activate());
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());
    geo.send(1, 90);
    geo.send(2, 30);
    geo.send(3, 60);
    await waitFor(() => expect(result.current.status).toBe("on"));
    expect(result.current.reading).toMatchObject({ lat: 2, meters: 30 });
  });
});

describe("errors, and never stuck searching", () => {
  it("denied in advance: says so, without asking again or explaining", async () => {
    const geo = stubGeolocation("denied");
    const { result } = setup();
    await act(() => result.current.activate());
    await waitFor(() => expect(result.current.error).toBe("denied"));
    expect(result.current.status).toBe("off");
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });

  it.each([
    [1, "denied"],
    [2, "unavailable"],
    [3, "timeout"],
  ])("watch error %i is %s", async (code, expected) => {
    const geo = stubGeolocation("granted");
    const { result } = setup();
    await act(() => result.current.activate());
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());
    geo.fail(code);
    await waitFor(() => expect(result.current.error).toBe(expected));
    expect(result.current.status).toBe("off");
  });

  it("no answer at all ends in 'no response', after trying without high accuracy", async () => {
    const geo = stubGeolocation("granted");
    const { result } = setup();
    await act(() => result.current.activate());
    await waitFor(() => expect(result.current.error).toBe("noResponse"));
    expect(result.current.status).toBe("off");
    expect(geo.watchPosition.mock.calls.map((call) => (call as unknown[])[2])).toMatchObject([{ enableHighAccuracy: true }, { enableHighAccuracy: false }]);
    expect(geo.watches.size).toBe(0);
  });

  it("keeps the browser's own words about what failed", async () => {
    const geo = stubGeolocation("granted");
    const { result } = setup();
    await act(() => result.current.activate());
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());
    act(() => [...geo.watches.values()].at(-1)!.fail({ ...failure(2), message: "provider said no" }));
    await waitFor(() => expect(result.current.error).toBe("unavailable"));
    expect(result.current.detail).toEqual({ code: 2, message: "provider said no" });
  });

  it("a device without geolocation", async () => {
    const { geolocation: _dropped, ...rest } = navigator as Navigator & { geolocation?: unknown };
    void _dropped;
    vi.stubGlobal("navigator", Object.fromEntries(Object.entries(rest)));
    const { result } = setup();
    await act(() => result.current.activate());
    await waitFor(() => expect(result.current.error).toBe("unsupported"));
  });

  it("can try again after an error, and the error can be closed", async () => {
    const geo = stubGeolocation("granted");
    const { result } = setup();
    await act(() => result.current.activate());
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());
    geo.fail(2);
    await waitFor(() => expect(result.current.error).toBe("unavailable"));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    await act(() => result.current.activate());
    expect(result.current.status).toBe("searching");
  });
});

describe("while on", () => {
  it("follows the position, at most once a second", async () => {
    const geo = stubGeolocation();
    const { result } = setup();
    await turnOn(result, geo);
    await waitFor(() => expect(geo.watches.size).toBe(1));
    const clock = vi.mocked(performance.now);

    geo.send(41, 20);
    expect(result.current.reading).toMatchObject({ lat: 41 });
    clock.mockReturnValue(100_000 + MIN_UPDATE_MS - 1);
    geo.send(42, 20);
    expect(result.current.reading).toMatchObject({ lat: 41 });
    clock.mockReturnValue(100_000 + MIN_UPDATE_MS);
    geo.send(43, 20);
    expect(result.current.reading).toMatchObject({ lat: 43 });
  });

  it("a lost signal keeps the last position", async () => {
    const geo = stubGeolocation();
    const { result } = setup();
    await turnOn(result, geo);
    await waitFor(() => expect(geo.watches.size).toBe(1));
    geo.fail(2);
    expect(result.current.status).toBe("on");
    expect(result.current.error).toBeNull();
  });

  it("a withdrawn permission turns it off and says so", async () => {
    const geo = stubGeolocation();
    const { result } = setup();
    await turnOn(result, geo);
    await waitFor(() => expect(geo.watches.size).toBe(1));
    geo.fail(1);
    expect(result.current.status).toBe("off");
    expect(result.current.error).toBe("denied");
    expect(geo.watches.size).toBe(0);
  });

  it("stops when the tab is hidden and comes back when visible", async () => {
    const geo = stubGeolocation();
    const { result } = setup();
    await turnOn(result, geo);
    await waitFor(() => expect(geo.watches.size).toBe(1));

    setHidden(true);
    expect(geo.watches.size).toBe(0);
    expect(result.current.status).toBe("on");

    setHidden(false);
    expect(geo.watches.size).toBe(1);
    expect(result.current.status).toBe("on");
  });

  it("stops on pagehide and resumes on pageshow", async () => {
    const geo = stubGeolocation();
    const { result } = setup();
    await turnOn(result, geo);
    await waitFor(() => expect(geo.watches.size).toBe(1));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(geo.watches.size).toBe(0);
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(geo.watches.size).toBe(1);
  });

  it("a search under way is abandoned when the tab is hidden", async () => {
    const geo = stubGeolocation();
    const { result } = setup();
    await act(() => result.current.activate());
    await waitFor(() => expect(geo.watches.size).toBe(1));
    setHidden(true);
    expect(result.current.status).toBe("off");
    expect(geo.watches.size).toBe(0);
  });

  it("turning off stops the tracking and forgets the position", async () => {
    const geo = stubGeolocation();
    const { result } = setup();
    await turnOn(result, geo);
    await waitFor(() => expect(geo.watches.size).toBe(1));
    act(() => result.current.stop());
    expect(result.current.status).toBe("off");
    expect(result.current.reading).toBeNull();
    expect(geo.watches.size).toBe(0);
  });

  it("leaving the map view turns it off", async () => {
    const geo = stubGeolocation();
    const { result, rerender } = setup();
    await turnOn(result, geo);
    await waitFor(() => expect(geo.watches.size).toBe(1));
    rerender({ on: false });
    expect(result.current.status).toBe("off");
    expect(geo.watches.size).toBe(0);
  });

  it("unmounting cleans everything", async () => {
    const geo = stubGeolocation();
    const { result, unmount } = setup();
    await turnOn(result, geo);
    await waitFor(() => expect(geo.watches.size).toBe(1));
    unmount();
    expect(geo.watches.size).toBe(0);
  });
});

describe("privacy", () => {
  it("stores nothing and makes no request", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const geo = stubGeolocation("prompt");
    const { result } = setup();
    await act(() => result.current.activate());
    act(() => result.current.accept());
    await waitFor(() => expect(geo.watches.size).toBe(1));
    geo.send(40, 8);
    await waitFor(() => expect(result.current.status).toBe("on"));
    await waitFor(() => expect(geo.watches.size).toBe(1));
    geo.send(41, 8);
    act(() => result.current.stop());
    expect(setItem).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("every new mount starts off", async () => {
    const geo = stubGeolocation();
    const first = setup();
    await turnOn(first.result, geo);
    first.unmount();
    expect(setup().result.current.status).toBe("off");
  });
});
