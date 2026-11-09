// "Where am I?", done carefully. A single getCurrentPosition often returns the
// first rough answer (Wi-Fi, cell towers). watchPosition keeps refining it, so
// it is left running for a few seconds and the most precise reading wins.
//
// Started only from a tap, never on load: the browser's permission dialog is
// not something to spring on someone.
import { useEffect, useRef, useState } from "react";

export interface Reading {
  lat: number;
  lon: number;
  meters: number;
}

export type Geo =
  | { kind: "idle" }
  | { kind: "locating"; best?: Reading }
  | { kind: "found"; reading: Reading }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "timeout" }
  | { kind: "unsupported" };

/** Precise enough: no point in making the person wait longer. */
const GOOD_ENOUGH_M = 10;

export function useBestLocation(onReading: (reading: Reading) => void, maxMs = 8000) {
  const [geo, setGeo] = useState<Geo>({ kind: "idle" });
  const stopRef = useRef<() => void>(() => {});
  const onReadingRef = useRef(onReading);
  useEffect(() => {
    onReadingRef.current = onReading;
  });
  // Leaving the screen stops the GPS.
  useEffect(() => () => stopRef.current(), []);

  async function locate() {
    if (!("geolocation" in navigator)) {
      setGeo({ kind: "unsupported" });
      return;
    }
    // If the browser already blocks it, say how to unblock it instead of
    // asking again (the browser would refuse silently).
    try {
      const status = await navigator.permissions?.query({ name: "geolocation" });
      if (status?.state === "denied") {
        setGeo({ kind: "denied" });
        return;
      }
    } catch {
      // The Permissions API is missing or does not know "geolocation": just ask.
    }

    stopRef.current();
    let best: Reading | null = null;
    let finished = false;
    const geolocation = navigator.geolocation;
    const handles: { watch?: number; timer?: number } = {};
    const release = () => {
      if (handles.watch !== undefined) geolocation.clearWatch(handles.watch);
      if (handles.timer !== undefined) window.clearTimeout(handles.timer);
    };
    const finish = (end: Geo) => {
      if (finished) return;
      finished = true;
      release();
      stopRef.current = () => {};
      setGeo(end);
    };

    setGeo({ kind: "locating" });
    handles.watch = geolocation.watchPosition(
      (position) => {
        if (finished) return;
        const reading = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          meters: Math.round(position.coords.accuracy),
        };
        if (!best || reading.meters < best.meters) {
          best = reading;
          onReadingRef.current(reading);
          setGeo({ kind: "locating", best: reading });
        }
        if (reading.meters <= GOOD_ENOUGH_M) finish({ kind: "found", reading: best });
      },
      (error) => {
        if (best) finish({ kind: "found", reading: best });
        else if (error.code === error.PERMISSION_DENIED) finish({ kind: "denied" });
        else if (error.code === error.TIMEOUT) finish({ kind: "timeout" });
        else finish({ kind: "unavailable" });
      },
      { enableHighAccuracy: true, timeout: maxMs, maximumAge: 0 },
    );
    // The success callback may already have run (a stored position, or a test).
    if (finished) {
      geolocation.clearWatch(handles.watch);
      return;
    }
    handles.timer = window.setTimeout(() => finish(best ? { kind: "found", reading: best } : { kind: "timeout" }), maxMs);
    stopRef.current = () => {
      finished = true;
      release();
      stopRef.current = () => {};
    };
  }

  /** The person chose another way: stop the GPS and forget the search. */
  function cancel() {
    stopRef.current();
    setGeo({ kind: "idle" });
  }

  return { geo, locate, cancel };
}
