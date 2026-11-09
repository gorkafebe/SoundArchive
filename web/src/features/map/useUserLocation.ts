// "Where am I?" on the main map: the states of the button, and nothing else.
//
//   off -> (explanation, the first time) -> searching -> on -> off
//                                               \-> an error, then off again
//
// Searching is useBestLocation, the same code the add-place flow uses: up to
// 8 s of watchPosition, keeping the most precise reading. While on, a lighter
// watch keeps the marker up to date, at most once a second.
//
// The position stays in this component's memory. It is not sent anywhere and
// not stored, and "on" is not remembered: every visit starts off, so showing
// your location is always something you just decided to do.
import { useEffect, useRef, useState } from "react";

import { useBestLocation, type Reading } from "../add-place/useBestLocation";

export type LocateStatus = "off" | "prompt" | "searching" | "on";
export type LocateError = "denied" | "unavailable" | "timeout" | "unsupported";

/** Fastest the marker may be updated. Also spares the battery a little. */
export const MIN_UPDATE_MS = 1000;

const ignore = () => {};

async function permissionState(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions?.query({ name: "geolocation" }))?.state ?? null;
  } catch {
    return null; // Not available (Safari, for instance): treat as unknown.
  }
}

export function useUserLocation({ active, locateMs }: { active: boolean; locateMs?: number }) {
  const { geo, locate, cancel } = useBestLocation(ignore, locateMs);
  const [phase, setPhase] = useState<"off" | "prompt" | "running">("off");
  const [tracked, setTracked] = useState<Reading | null>(null);
  const [trackError, setTrackError] = useState<LocateError | null>(null);
  const [visible, setVisible] = useState(() => !document.hidden);
  // Already said yes during this visit: where the Permissions API is missing
  // there is no other way to know, and asking twice would be tiresome.
  const accepted = useRef(false);

  const failed =
    geo.kind === "denied" || geo.kind === "unavailable" || geo.kind === "timeout" || geo.kind === "unsupported";
  let status: LocateStatus = "off";
  if (phase === "prompt") status = "prompt";
  else if (phase === "running" && !failed) status = geo.kind === "found" ? "on" : "searching";

  const error: LocateError | null = phase === "running" && failed ? geo.kind : trackError;
  const reading = status === "on" && geo.kind === "found" ? (tracked ?? geo.reading) : null;

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
    const state = await permissionState();
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

  return { status, error, reading, activate, accept, dismiss, stop, clearError };
}
