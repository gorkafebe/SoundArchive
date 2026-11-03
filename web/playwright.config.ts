// End-to-end tests: a real browser (Chromium, headless) drives the real app
// served by the dev stack's Caddy. Run them with `make e2e`, which starts
// the official Playwright image inside the stack's Docker network, so no
// browser is installed on the machine.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // One worker: the tests share the dev database, and the machine is a laptop.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    // Inside the Docker network, Caddy is reachable by its service name.
    baseURL: process.env.E2E_BASE_URL ?? "http://caddy",
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: {
      // MapLibre needs WebGL. A headless browser in a container has no GPU,
      // so use SwiftShader, Chromium's software renderer (CPU only). Recent
      // Chromium versions only allow it for WebGL when asked explicitly.
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
