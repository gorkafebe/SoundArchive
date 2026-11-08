// End-to-end tests: real browsers drive the real app over HTTPS, against a
// throwaway copy of the real configuration (`make e2e`).
import { defineConfig, devices } from "@playwright/test";

import { ADMIN_STATE, BASE_URL, MEDIA } from "./e2e/constants";

const GPU = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
// Chromium's fake microphone, "hearing" a known tone made with ffmpeg.
const FAKE_MIC = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-audio-capture=/app/${MEDIA}/capture.wav%noloop`,
];

export default defineConfig({
  testDir: "./e2e",
  // The real-basemap check talks to the tile provider on the internet, so it
  // only runs when asked for: make e2e-real-tiles (see that file).
  testIgnore: process.env.E2E_REAL_TILES ? [] : ["**/*.manual.spec.ts"],
  globalSetup: "./e2e/global-setup.ts",
  // One worker: the tests share a database, and the machine is a laptop.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  // Not test-results itself: Playwright empties this folder at the start, and
  // the certificate and test audio live next to it.
  outputDir: "test-results/output",
  use: {
    baseURL: BASE_URL,
    storageState: ADMIN_STATE,
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: ["**/denied.spec.ts", "**/firefox.spec.ts", "**/mobile.spec.ts"],
      use: { ...devices["Desktop Chrome"], launchOptions: { args: [...GPU, ...FAKE_MIC] } },
    },
    {
      // No fake microphone and no permission: getUserMedia is refused.
      name: "chromium-no-mic",
      testMatch: ["**/denied.spec.ts"],
      use: { ...devices["Desktop Chrome"], launchOptions: { args: GPU } },
    },
    {
      name: "firefox",
      testMatch: ["**/firefox.spec.ts"],
      use: { ...devices["Desktop Firefox"], ignoreHTTPSErrors: true },
    },
    {
      name: "mobile",
      testMatch: ["**/mobile.spec.ts"],
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        launchOptions: { args: [...GPU, ...FAKE_MIC] },
      },
    },
  ],
});
