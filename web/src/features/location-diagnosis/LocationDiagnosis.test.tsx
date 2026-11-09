// The diagnosis, against the same simulated browsers as the location button.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../i18n/i18n";
import { CHROMIUM_NO_PROVIDER, GEO_LAT, GEO_LON, GEO_SCENARIOS, installGeoScenario, removeGeoScenario, type GeoLog, type GeoScenarioName } from "../../test/geoScenarios";
import { LocationDiagnosis } from "./LocationDiagnosis";
import { buildName, describeHost } from "./probes";

const openWatches = () => (globalThis as unknown as { __geoLog: GeoLog }).__geoLog.openWatches;

async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

async function open(name: GeoScenarioName) {
  installGeoScenario(GEO_SCENARIOS[name]);
  const view = render(
    <I18nProvider>
      <LocationDiagnosis />
    </I18nProvider>,
  );
  await advance(0);
  return view;
}

/** Press "test now" and wait out all three attempts. */
async function runAll() {
  fireEvent.click(screen.getByRole("button", { name: "Probar ahora" }));
  await advance(36_000);
}

const report = () => (screen.getByRole("textbox") as HTMLTextAreaElement).value;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem("sa.language", "es");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  removeGeoScenario();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("what each browser behaviour produces in the report", () => {
  it("total silence: 'no response', with the limit of each attempt", async () => {
    await open("silence");
    await runAll();
    expect(report()).toContain("T1, precisión alta, 10 s: sin respuesta en 10 s");
    expect(report()).toContain("T2, sin precisión alta, 10 s: sin respuesta en 10 s");
    expect(report()).toContain("T3, seguimiento durante 15 s: sin respuesta en 15 s");
    expect(openWatches()).toBe(0);
  });

  it("no location provider: the code and the browser's own words", async () => {
    await open("unavailable2");
    await runAll();
    expect(report()).toContain(`T1, precisión alta, 10 s: error, código 2: ${CHROMIUM_NO_PROVIDER}`);
    expect(report()).toContain(`T2, sin precisión alta, 10 s: error, código 2: ${CHROMIUM_NO_PROVIDER}`);
  });

  it("the browser's own timeout is told apart from silence", async () => {
    await open("timeout3");
    await runAll();
    expect(report()).toContain("error, código 3: Timeout expired");
    expect(report()).not.toContain("sin respuesta");
  });

  it("refused: code 1", async () => {
    await open("denied1");
    await runAll();
    expect(report()).toContain("error, código 1: User denied Geolocation");
  });

  it("high accuracy silent, low accuracy fine: T1 and T2 differ, which is the whole point", async () => {
    await open("highSilent");
    await runAll();
    expect(report()).toContain("T1, precisión alta, 10 s: sin respuesta en 10 s");
    expect(report()).toMatch(/T2, sin precisión alta, 10 s: correcto: primera lectura en \d+ ms, ±900 m, 1 lecturas/);
  });

  it("tracking: counts every reading and keeps the best accuracy", async () => {
    await open("improving");
    await runAll();
    expect(report()).toMatch(/T3, seguimiento durante 15 s: correcto: primera lectura en \d+ ms, ±\d+ m, \d+ lecturas/);
  });

  it("a terrible accuracy is reported as it is", async () => {
    await open("byIp");
    await runAll();
    expect(report()).toContain("±50.000 m");
  });

  it("the permission reading: granted, or not available at all", async () => {
    const first = await open("immediate");
    expect(report()).toContain("Permiso de ubicación: concedido");
    first.unmount();
    removeGeoScenario();
    await open("noPermissionsApi");
    expect(report()).toContain("Permiso de ubicación: no disponible");
  });

  it("without geolocation at all it says so, and nothing runs", async () => {
    render(
      <I18nProvider>
        <LocationDiagnosis />
      </I18nProvider>,
    );
    await advance(0);
    expect(report()).toContain("Tiene geolocalización: no");
    fireEvent.click(screen.getByRole("button", { name: "Probar ahora" }));
    await advance(100);
    expect(report()).toContain("Pruebas: sin ejecutar.");
  });
});

describe("privacy", () => {
  it("no coordinates in the report unless the box is ticked, and then two decimals", async () => {
    await open("immediate");
    await runAll();
    expect(report()).not.toContain(String(GEO_LAT));
    expect(report()).not.toContain(String(GEO_LON));

    const box = screen.getByRole("checkbox");
    expect(box).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar mi posición aquí" }));
    await advance(100);
    expect(screen.getByText("Posición aproximada: 41.65, -0.88")).toBeInTheDocument();
    expect(report()).not.toContain("41.65");

    fireEvent.click(box);
    expect(report()).toContain("Posición aproximada: 41.65, -0.88");
  });

  it("stores nothing and asks the network for nothing", async () => {
    const store = vi.spyOn(Storage.prototype, "setItem");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await open("improving");
    await runAll();
    expect(store).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaving the page stops the tests", async () => {
    const view = await open("silence");
    fireEvent.click(screen.getByRole("button", { name: "Probar ahora" }));
    await advance(21_000); // T3, the one with a watch, is running
    expect(openWatches()).toBe(1);
    view.unmount();
    expect(openWatches()).toBe(0);
  });
});

describe("copying", () => {
  it("copies the report", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await open("immediate");
    fireEvent.click(screen.getByRole("button", { name: "Copiar informe" }));
    await advance(0);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Diagnóstico de ubicación de Sound Archive"));
    expect(screen.getByText("Informe copiado.")).toBeInTheDocument();
    delete (navigator as unknown as Record<string, unknown>).clipboard;
  });

  it("without a clipboard it leaves the text ready to copy by hand", async () => {
    await open("immediate");
    fireEvent.click(screen.getByRole("button", { name: "Copiar informe" }));
    await advance(0);
    expect(screen.getByText(/copiarlo a mano/)).toBeInTheDocument();
  });
});

describe("nothing in the address gives the network away", () => {
  it.each([
    ["localhost", "9443", "localhost:9443"],
    ["soundarchive", "8443", "soundarchive:8443"],
    ["machine.tail1234.ts.net", "8443", "tailnet-name:8443"],
    ["192.0.2.10", "8443", "ip-address:8443"],
    ["[2001:db8::1]", "", "ip-address"],
    ["example.org", "", "other-name"],
  ])("%s", (host, port, expected) => {
    expect(describeHost(host, port)).toBe(expected);
  });

  it("the build is the name of the compiled file, without the address", () => {
    expect(buildName("https://soundarchive:8443/assets/index-B9sBnvdx.js")).toBe("index-B9sBnvdx.js");
  });
});
