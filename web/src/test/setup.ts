// Runs before every unit test file (vite.config.ts, test.setupFiles).
// Adds matchers such as expect(el).toBeInTheDocument().
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// jsdom has no matchMedia; the app asks it about reduced motion, dark mode
// and screen width. Tests can replace it to try other answers.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
