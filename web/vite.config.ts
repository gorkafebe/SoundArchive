// Vite builds the app (npm run build -> dist/) and serves it in development
// (npm run dev). Vitest, the unit test runner, reads the "test" section.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev server only (make web-dev): forward API calls to the dev stack's
    // Caddy, so the app and the API share one address, as in production.
    host: "0.0.0.0",
    port: 5173,
    proxy: { "/api": process.env.VITE_API_PROXY ?? "http://caddy:80" },
  },
  build: {
    // MapLibre alone is about 1 MB; don't warn about it.
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
