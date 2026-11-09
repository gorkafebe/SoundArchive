// Finding the person's position for the map's "where am I?" button.
//
// Two attempts, because not every device can do what the first one asks:
//
//   1. High accuracy, up to 8 s, keeping the most precise reading.
//   2. If that produced nothing: no high accuracy, up to 10 s more, and the
//      first reading is good enough.
//
// Computers without GPS may fail or go quiet when asked for high accuracy and
// still answer the ordinary question (see docs/PHONE_SETUP.md). A cold GPS may
// also simply need more than 8 s. The timers are our own: a browser is allowed
// to never call back at all.
import type { Reading } from "../add-place/useBestLocation";

export const HIGH_ACCURACY_MS = 8000;
export const LOW_ACCURACY_MS = 10_000;
/** Precise enough: no point in making the person wait longer. */
const GOOD_ENOUGH_M = 10;
/** The second attempt accepts a position this old. */
const LOW_ACCURACY_MAX_AGE_MS = 60_000;

/** What the browser said, word for word. Never contains the position. */
export interface BrowserFailure {
  code: number;
  message: string;
}

export type SearchEnd =
  | { kind: "found"; reading: Reading }
  | { kind: "denied" | "unavailable" | "timeout"; detail: BrowserFailure }
  // The browser never said anything, not even an error.
  | { kind: "noResponse"; detail: null };

export interface SearchLimits {
  highMs: number;
  lowMs: number;
  /** While the browser's permission dialog is open the clock must not run. */
  decided?: Promise<void>;
}

/** How long to wait for an answer to the browser's dialog before counting anyway. */
export const DECISION_MS = 30_000;

/**
 * Settles when the person answers the browser's permission dialog, or after
 * waitMs. Some browsers leave the state in "prompt" after "allow this once",
 * so an answer is not guaranteed to be announced: hence the limit.
 */
export function permissionDecided(status: PermissionStatus, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      status.removeEventListener?.("change", done);
      resolve();
    };
    const timer = window.setTimeout(done, waitMs);
    status.addEventListener?.("change", done);
  });
}

/** Starts the search. The function returned cancels it. */
export function searchPosition(geolocation: Geolocation, limits: SearchLimits, onEnd: (end: SearchEnd) => void): () => void {
  let best: Reading | null = null;
  let finished = false;
  let lastFailure: BrowserFailure | null = null;
  let attempt = 0;
  let watch: number | undefined;
  let timer: number | undefined;

  const release = () => {
    if (watch !== undefined) geolocation.clearWatch(watch);
    if (timer !== undefined) window.clearTimeout(timer);
    watch = undefined;
    timer = undefined;
  };

  const finish = (end: SearchEnd) => {
    if (finished) return;
    finished = true;
    release();
    onEnd(end);
  };

  const finishWithBest = () => {
    if (best) finish({ kind: "found", reading: best });
  };

  const giveUp = () => {
    if (lastFailure) finish({ kind: lastFailure.code === 3 ? "timeout" : "unavailable", detail: lastFailure });
    else finish({ kind: "noResponse", detail: null });
  };

  function listen(high: boolean, limitMs: number, next: () => void, decided?: Promise<void>) {
    release();
    const mine = ++attempt;
    const arm = () => {
      if (finished || mine !== attempt || timer !== undefined) return;
      timer = window.setTimeout(() => {
        if (best) finishWithBest();
        else next();
      }, limitMs);
    };
    const id = geolocation.watchPosition(
      (position) => {
        if (finished || mine !== attempt) return;
        const reading = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          meters: Math.round(position.coords.accuracy),
        };
        if (!best || reading.meters < best.meters) best = reading;
        if (!high || reading.meters <= GOOD_ENOUGH_M) finishWithBest();
        else arm(); // a reading means the dialog, if there was one, is gone
      },
      (error) => {
        if (finished || mine !== attempt) return;
        if (best) finishWithBest();
        else if (error.code === error.PERMISSION_DENIED) finish({ kind: "denied", detail: { code: error.code, message: error.message } });
        else {
          lastFailure = { code: error.code, message: error.message };
          next();
        }
      },
      { enableHighAccuracy: high, timeout: limitMs, maximumAge: high ? 0 : LOW_ACCURACY_MAX_AGE_MS },
    );
    // Something already answered, inside the call itself.
    if (finished || mine !== attempt) {
      geolocation.clearWatch(id);
      return;
    }
    watch = id;
    if (decided) void decided.then(arm);
    else arm();
  }

  listen(true, limits.highMs, () => listen(false, limits.lowMs, giveUp), limits.decided);

  return () => {
    finished = true;
    release();
  };
}
