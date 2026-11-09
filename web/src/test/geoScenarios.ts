// Stand-ins for the browser's geolocation that behave like real browsers do:
// slow, silent, wrong or precise, on their own clock. A test that only ever
// answers "here you are, at once" proves very little.
//
// One script for both kinds of test: Playwright passes installGeoScenario to
// page.addInitScript, Vitest calls it. So it must stay self-contained: no
// reference to anything outside the function, and data-only scenarios.
//
// The position is generic and deliberately asymmetric (latitude 41.65,
// longitude -0.88): swapping the two lands somewhere else entirely.

export const GEO_LAT = 41.65;
export const GEO_LON = -0.88;

export interface GeoStep {
  /** When it happens, counted from the first request once permission is settled. */
  atMs: number;
  fix?: { lat: number; lon: number; accuracy: number };
  error?: { code: 1 | 2 | 3; message: string };
}

export interface GeoScenario {
  /** What the provider does for enableHighAccuracy: true. */
  high: GeoStep[];
  /** ... and for false. The same as high when left out. */
  low?: GeoStep[];
  permission: "absent" | "prompt" | "granted" | "denied";
  /** How long the browser's permission dialog stays open before "allow". */
  dialogMs?: number;
  /** False: the browser ignores the timeout option too and never calls back at all. */
  honoursTimeout?: boolean;
}

export interface GeoLog {
  calls: { method: "watchPosition" | "getCurrentPosition"; highAccuracy: boolean; timeout?: number }[];
  openWatches: number;
}

const fix = (accuracy: number, atMs = 0): GeoStep => ({ atMs, fix: { lat: GEO_LAT, lon: GEO_LON, accuracy } });

export const CHROMIUM_NO_PROVIDER = "Network location provider at 'https://www.googleapis.com/' : Returned error code 403.";

export const GEO_SCENARIOS = {
  immediate: { permission: "granted", high: [fix(8)] },
  after3s: { permission: "granted", high: [fix(30, 3000)] },
  after9s: { permission: "granted", high: [fix(30, 9000)] },
  after15s: { permission: "granted", high: [fix(30, 15_000)] },
  denied1: { permission: "prompt", high: [{ atMs: 0, error: { code: 1, message: "User denied Geolocation" } }] },
  unavailable2: { permission: "granted", high: [{ atMs: 200, error: { code: 2, message: CHROMIUM_NO_PROVIDER } }] },
  timeout3: { permission: "granted", high: [{ atMs: 200, error: { code: 3, message: "Timeout expired" } }] },
  silence: { permission: "granted", high: [], honoursTimeout: false },
  single: { permission: "granted", high: [fix(300, 1000)] },
  improving: { permission: "granted", high: [fix(5000, 500), fix(200, 1500), fix(20, 3000)] },
  byIp: { permission: "granted", high: [fix(50_000, 500)] },
  highFails: {
    permission: "granted",
    high: [{ atMs: 200, error: { code: 2, message: CHROMIUM_NO_PROVIDER } }],
    low: [fix(900, 500)],
  },
  highSilent: { permission: "granted", high: [], low: [fix(900, 500)], honoursTimeout: false },
  noPermissionsApi: { permission: "absent", high: [fix(8, 200)] },
  promptState: { permission: "prompt", high: [fix(8, 200)] },
  deniedState: { permission: "denied", high: [fix(8, 200)] },
  slowDialog: { permission: "prompt", dialogMs: 12_000, high: [fix(30, 500)] },
} satisfies Record<string, GeoScenario>;

export type GeoScenarioName = keyof typeof GEO_SCENARIOS;

export function installGeoScenario(scenario: GeoScenario): void {
  const CODES = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
  const log: GeoLog = { calls: [], openWatches: 0 };
  let state: "prompt" | "granted" | "denied" = scenario.permission === "absent" ? "prompt" : scenario.permission;
  let providerStart: number | null = null;
  let nextId = 1;
  const running = new Map<number, { timers: number[]; repeat: boolean }>();
  const statuses = new Set<EventTarget>();

  const failure = (code: number, message: string) => ({ code, message, ...CODES });

  function settle(next: "granted" | "denied") {
    if (state === next) return;
    state = next;
    statuses.forEach((status) => status.dispatchEvent(new Event("change")));
  }

  function end(id: number) {
    const run = running.get(id);
    if (!run) return;
    run.timers.forEach((timer) => clearTimeout(timer));
    running.delete(id);
    if (run.repeat) log.openWatches--;
  }

  function start(ok: PositionCallback, fail: PositionErrorCallback | null | undefined, options: PositionOptions | undefined, repeat: boolean) {
    const id = nextId++;
    const timers: number[] = [];
    running.set(id, { timers, repeat });
    if (repeat) log.openWatches++;
    log.calls.push({
      method: repeat ? "watchPosition" : "getCurrentPosition",
      highAccuracy: Boolean(options?.enableHighAccuracy),
      timeout: options?.timeout,
    });
    const later = (ms: number, run: () => void) => timers.push(setTimeout(run, ms) as unknown as number);
    let delivered = false;

    const acquire = () => {
      if (state === "denied") {
        fail?.(failure(1, "User denied Geolocation") as GeolocationPositionError);
        end(id);
        return;
      }
      if (providerStart === null) providerStart = Date.now();
      const elapsed = Date.now() - providerStart;
      const steps = (options?.enableHighAccuracy ? scenario.high : (scenario.low ?? scenario.high)) as GeoStep[];
      // What already happened: only the newest is still on offer.
      const past = steps.filter((step) => step.atMs <= elapsed).slice(-1);
      const future = steps.filter((step) => step.atMs > elapsed);
      for (const step of [...past, ...future]) {
        later(Math.max(step.atMs - elapsed, 0), () => {
          if (step.fix) {
            delivered = true;
            const { lat, lon, accuracy } = step.fix;
            ok({
              coords: { latitude: lat, longitude: lon, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
              timestamp: Date.now(),
            } as GeolocationPosition);
          } else if (step.error) {
            if (step.error.code === 1) settle("denied");
            fail?.(failure(step.error.code, step.error.message) as GeolocationPositionError);
          }
          if (!repeat) end(id);
        });
      }
      if (scenario.honoursTimeout !== false && options?.timeout !== undefined && Number.isFinite(options.timeout)) {
        later(options.timeout, () => {
          if (delivered) return;
          fail?.(failure(3, "Timeout expired") as GeolocationPositionError);
          if (!repeat) end(id);
        });
      }
    };

    if (state === "prompt") {
      // The browser's own dialog. Its answer takes as long as the person does.
      later(scenario.dialogMs ?? 0, () => {
        const refuses = (scenario.high[0] as GeoStep | undefined)?.error?.code === 1;
        if (!refuses) settle("granted");
        acquire();
      });
    } else {
      later(0, acquire);
    }
    return id;
  }

  const geolocation = {
    getCurrentPosition: (ok: PositionCallback, fail?: PositionErrorCallback | null, options?: PositionOptions) => {
      start(ok, fail, options, false);
    },
    watchPosition: (ok: PositionCallback, fail?: PositionErrorCallback | null, options?: PositionOptions) => start(ok, fail, options, true),
    clearWatch: (id: number) => end(id),
  };

  Object.defineProperty(navigator, "geolocation", { configurable: true, value: geolocation });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value:
      scenario.permission === "absent"
        ? undefined
        : {
            query: async ({ name }: PermissionDescriptor) => {
              if (name !== "geolocation") return { state: "prompt" };
              const status = new EventTarget();
              Object.defineProperty(status, "state", { get: () => state });
              statuses.add(status);
              return status;
            },
          },
  });
  (globalThis as unknown as { __geoLog: GeoLog }).__geoLog = log;
}

/** For Vitest: put the test environment back as it was. */
export function removeGeoScenario(): void {
  delete (navigator as unknown as Record<string, unknown>).geolocation;
  delete (navigator as unknown as Record<string, unknown>).permissions;
}
