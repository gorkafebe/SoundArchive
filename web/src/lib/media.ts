import { useEffect, useState } from "react";

/** True while a CSS media query matches; updates when it changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function mediaMatches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
// Same breakpoint as the CSS (48rem = 768 px): side panel instead of a sheet.
export const WIDE_SCREEN = "(min-width: 48rem)";

/** Map camera animations: instant when the user prefers reduced motion. */
export function motionDuration(normalMs: number): number {
  return mediaMatches(REDUCED_MOTION) ? 0 : normalMs;
}
