// "Where am I?" on the main map: the states of the button, and nothing else.
//
//   off -> (explanation, the first time) -> searching -> on -> off
//                                               \-> an error, then off again
//
// Searching is searchPosition: high accuracy first, then without it. While on,
// a lighter watch keeps the marker up to date, at most once a second.
//
// The position stays in this component's memory. It is not sent anywhere and
// not stored, and "on" is not remembered: every visit starts off, so showing
// your location is always something you just decided to do.
import { useEffect, useRef, useState } from "react";

import type { Reading } from "../add-place/useBestLocation";
import { DECISION_MS, HIGH_ACCURACY_MS, LOW_ACCURACY_MS, permissionDecided, searchPosition, type BrowserFailure, type SearchEnd } from "./searchPosition";

export type LocateStatus = "off" | "prompt" | "searching" | "on";
export type LocateError = "denied" | "unavailable" | "timeout" | "noResponse" | "unsupported";

/** Fastest the marker may be updated. Also spares the battery a little. */
export const MIN_UPDATE_MS = 1000;

async function permissionStatus(): Promise<PermissionStatus | null> {
  try {
    return (await navigator.permissions?.query({ name: "geolocation" })) ?? null;
  } catch {
    return null; // Not available (Safari, for instance): treat as unknown.
  }
}

type Geo = { kind: "idle" } | { kind: "locating" } | { kind: "unsupported" } | { kind: "blocked" } | SearchEnd;

export function useUserLocation({ active, locateMs }: { active: boolean; locateMs?: number }) {
  const [geo, setGeo] = useState<Geo>({ kind: "idle" });
  const cancelSearch = useRef<() => void>(() => {});
  const [phase, setPhase] = useState<"off" | "prompt" | "running">("off");
  const [tracked, setTracked] = useState<Reading | null>(null);
  const [trackError, setTrackError] = useState<LocateError | null>(null);
  const [visible, setVisible] = useState(() => !document.hidden);
  // Already said yes during this visit: where the Permissions API is missing
  // there is no other way to know, and asking twice would be tiresome.
  const accepted = useRef(false);

  const failed =
    geo.kind === "denied" ||
    geo.kind === "blocked" ||
    geo.kind === "unavailable" ||
    geo.kind === "timeout" ||
    geo.kind === "noResponse" ||
    geo.kind === "unsupported";
  let status: LocateStatus = "off";
  if (phase === "prompt") status = "prompt";
  else if (phase === "running" && !failed) status = geo.kind === "found" ? "on" : "searching";

  const error: LocateError | null = phase === "running" && failed ? (geo.kind === "blocked" ? "denied" : geo.kind) : trackError;
  const detail: BrowserFailure | null = phase === "running" && "detail" in geo ? geo.detail : null;
  const reading = status === "on" && geo.kind === "found" ? (tracked ?? geo.reading) : null;

  function cancel() {
    cancelSearch.current();
    cancelSearch.current = () => {};
    setGeo({ kind: "idle" });
  }

  async function locate() {
    if (!("geolocation" in navigator)) {
      setGeo({ kind: "unsupported" });
      return;
    }
    // Already blocked: say how to unblock it (the browser would refuse silently).
    const permission = await permissionStatus();
    if (permission?.state === "denied") {
      setGeo({ kind: "blocked" });
      return;
    }
    cancelSearch.current();
    setGeo({ kind: "locating" });
    cancelSearch.current = searchPosition(
      navigator.geolocation,
      {
        highMs: locateMs ?? HIGH_ACCURACY_MS,
        lowMs: locateMs ?? LOW_ACCURACY_MS,
        decided: permission?.state === "prompt" ? permissionDecided(permission, locateMs ?? DECISION_MS) : undefined,
      },
      setGeo,
    );
  }

  function stop() {
    cancel();
    setPhase("off");
    setTracked(null);
    setTrackError(null);
  }

  function begin() {
    setTrackError(null);
    setTracked(null);
    setPhase("running");
    void locate();
  }

  /** The button, when off. Explains first unless permission is already settled. */
  async function activate() {
    setTrackError(null);
    const state = (await permissionStatus())?.state;
    // "denied" goes straight on: locate() reports it, with how to fix it.
    if (state === "granted" || state === "denied" || accepted.current || !("geolocation" in navigator)) begin();
    else setPhase("prompt");
  }

  function accept() {
    accepted.current = true;
    begin();
  }

  function dismiss() {
    setPhase("off");
  }

  function clearError() {
    if (failed) cancel();
    setTrackError(null);
  }

  const latest = useRef({ stop, status });
  useEffect(() => {
    latest.current = { stop, status };
  });

  // Leaving the screen stops the search.
  useEffect(() => () => cancelSearch.current(), []);

  // --- Light tracking while on ---------------------------------------------
  const tracking = status === "on" && visible && active;
  useEffect(() => {
    if (!tracking) return;
    const geolocation = navigator.geolocation;
    let last = -Infinity;
    const id = geolocation.watchPosition(
      (position) => {
        const now = performance.now();
        if (now - last < MIN_UPDATE_MS) return;
        last = now;
        setTracked({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          meters: Math.round(position.coords.accuracy),
        });
      },
      (failure) => {
        // A lost signal keeps the last position; a withdrawn permission ends it.
        if (failure.code === failure.PERMISSION_DENIED) {
          latest.current.stop();
          setTrackError("denied");
        }
      },
      { enableHighAccuracy: true, maximumAge: MIN_UPDATE_MS },
    );
    return () => geolocation.clearWatch(id);
  }, [tracking]);

  // --- Not looking: no GPS ---------------------------------------------------
  useEffect(() => {
    const leave = () => {
      setVisible(false);
      if (latest.current.status === "searching") latest.current.stop();
    };
    const back = () => setVisible(true);
    const onVisibility = () => (document.hidden ? leave() : back());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
    };
  }, []);

  // The map stays mounted, hidden, under the list and the add-place flow.
  useEffect(() => {
    if (!active) latest.current.stop();
  }, [active]);

  return { status, error, detail, reading, activate, accept, dismiss, stop, clearError };
}
