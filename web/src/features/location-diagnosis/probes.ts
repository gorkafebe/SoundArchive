// The three experiments of the location diagnosis, without React.
//
// Each has its own timer on purpose: the browser may never call back at all,
// and "no answer in 10 s" is exactly what this screen exists to find out. The
// browser is told a slightly shorter timeout, so that its own timeout (error
// code 3) can still be told apart from a browser that says nothing.

export type ProbeId = "T1" | "T2" | "T3";

export interface ProbeResult {
  id: ProbeId;
  highAccuracy: boolean;
  limitMs: number;
  outcome: "ok" | "error" | "silent";
  /** From the call to the first reading. */
  firstMs: number | null;
  meters: number | null;
  readings: number;
  /** When each reading came, from the call. Never where. */
  readingsAtMs: number[];
  code: number | null;
  message: string | null;
}

const BROWSER_MARGIN_MS = 500;

export const PROBES: { id: ProbeId; highAccuracy: boolean; limitMs: number; watch: boolean }[] = [
  { id: "T1", highAccuracy: true, limitMs: 10_000, watch: false },
  { id: "T2", highAccuracy: false, limitMs: 10_000, watch: false },
  { id: "T3", highAccuracy: true, limitMs: 15_000, watch: true },
];

type Probe = (typeof PROBES)[number];

/** Runs one experiment. Aborting stops it and resolves with null. */
function runProbe(geolocation: Geolocation, probe: Probe, signal: AbortSignal): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const result: ProbeResult = {
      id: probe.id,
      highAccuracy: probe.highAccuracy,
      limitMs: probe.limitMs,
      outcome: "silent",
      firstMs: null,
      meters: null,
      readings: 0,
      readingsAtMs: [],
      code: null,
      message: null,
    };
    let watch: number | undefined;
    let settled = false;

    const close = (value: ProbeResult | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (watch !== undefined) geolocation.clearWatch(watch);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => close(null);

    const onPosition = (position: GeolocationPosition) => {
      const meters = Math.round(position.coords.accuracy);
      result.outcome = "ok";
      result.readings += 1;
      result.readingsAtMs.push(elapsed());
      result.firstMs ??= elapsed();
      result.meters = result.meters === null ? meters : Math.min(result.meters, meters);
      if (!probe.watch) close(result);
    };
    const onError = (failure: GeolocationPositionError) => {
      // A watch that already has readings is still a success.
      if (result.readings === 0) {
        result.outcome = "error";
        result.code = failure.code;
        result.message = failure.message;
      }
      if (!probe.watch) close(result);
    };

    const timer = window.setTimeout(() => close(result), probe.limitMs);
    signal.addEventListener("abort", onAbort);
    const options = { enableHighAccuracy: probe.highAccuracy, timeout: probe.limitMs - BROWSER_MARGIN_MS, maximumAge: 0 };
    if (probe.watch) watch = geolocation.watchPosition(onPosition, onError, options);
    else geolocation.getCurrentPosition(onPosition, onError, options);
  });
}

/** T1, then T2, then T3, one at a time. Reports each result as soon as it is known. */
export async function runProbes(
  geolocation: Geolocation,
  signal: AbortSignal,
  onResult: (result: ProbeResult) => void,
  onStart: (id: ProbeId) => void = () => {},
): Promise<void> {
  for (const probe of PROBES) {
    if (signal.aborted) return;
    onStart(probe.id);
    const result = await runProbe(geolocation, probe, signal);
    if (!result) return;
    onResult(result);
  }
}

/** One position, for showing on this screen only. Null if none comes in 10 s. */
export function askPosition(geolocation: Geolocation, signal: AbortSignal): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    const finish = (value: { lat: number; lon: number } | null) => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const timer = window.setTimeout(() => finish(null), 10_000);
    signal.addEventListener("abort", onAbort);
    geolocation.getCurrentPosition(
      (position) => finish({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => finish(null),
      { enableHighAccuracy: false, timeout: 9_500, maximumAge: 0 },
    );
  });
}

/** Host name without anything that identifies the network. */
export function describeHost(hostname: string, port: string): string {
  let shown = "other-name";
  if (hostname === "localhost" || !hostname.includes(".")) shown = hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) shown = "ip-address";
  if (hostname.endsWith(".ts.net")) shown = "tailnet-name";
  return port ? `${shown}:${port}` : shown;
}

/** Which compiled file is running. Its name contains a hash of its contents. */
export function buildName(moduleUrl: string): string {
  return moduleUrl.split("/").pop()?.split("?")[0] ?? "";
}

export type PermissionReading = PermissionState | "not-available";

export async function readPermission(): Promise<PermissionReading> {
  try {
    return (await navigator.permissions?.query({ name: "geolocation" }))?.state ?? "not-available";
  } catch {
    return "not-available";
  }
}

export function readPermissionsPolicy(): "allowed" | "blocked" | "not-available" {
  type Policy = { allowsFeature?: (feature: string) => boolean };
  const source = document as unknown as { permissionsPolicy?: Policy; featurePolicy?: Policy };
  const policy = source.permissionsPolicy ?? source.featurePolicy;
  if (!policy?.allowsFeature) return "not-available";
  return policy.allowsFeature("geolocation") ? "allowed" : "blocked";
}

/** Two decimals: about a kilometre. Enough to see "my city, or 300 km away". */
export function roundedCoordinates(lat: number, lon: number): string {
  return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}
