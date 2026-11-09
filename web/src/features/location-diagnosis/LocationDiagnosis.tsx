// A screen to find out why "where am I?" does not work on this device.
//
// Automatic tests simulate the position, so they cannot say what a real browser
// on a real computer does. This screen asks the real one, and writes down the
// answer in a form that can be pasted into a message.
//
// It sends nothing and stores nothing: everything lives in this component and
// ends when you leave the page. Coordinates stay out of the report unless the
// box is ticked, and then only to two decimals (about a kilometre).
import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n/i18n";
import {
  askPosition,
  buildName,
  describeHost,
  PROBES,
  readPermission,
  readPermissionsPolicy,
  roundedCoordinates,
  runProbes,
  type PermissionReading,
  type ProbeId,
  type ProbeResult,
} from "./probes";

import "./location-diagnosis.css";

type Translate = ReturnType<typeof useI18n>["t"];

export interface Environment {
  host: string;
  protocol: string;
  secure: boolean;
  geolocation: boolean;
  permission: PermissionReading;
  policy: ReturnType<typeof readPermissionsPolicy>;
  userAgent: string;
  language: string;
  online: boolean;
  build: string;
}

function yesNo(t: Translate, value: boolean) {
  return t(value ? "diagnosis.yes" : "diagnosis.no");
}

function resultLine(t: Translate, result: ProbeResult): string {
  const seconds = result.limitMs / 1000;
  if (result.outcome === "silent") return t("diagnosis.result.silent", { seconds });
  if (result.outcome === "error") return t("diagnosis.result.error", { code: result.code ?? "?", message: result.message ?? "" });
  return t("diagnosis.result.ok", { ms: result.firstMs ?? 0, meters: result.meters ?? 0, readings: result.readings });
}

function probeName(t: Translate, id: ProbeId) {
  return t(`diagnosis.probe.${id}`);
}

export function environmentLines(t: Translate, env: Environment): [string, string][] {
  return [
    [t("diagnosis.env.build"), env.build],
    [t("diagnosis.env.address"), `${env.protocol} ${env.host}`],
    [t("diagnosis.env.secure"), yesNo(t, env.secure)],
    [t("diagnosis.env.geolocation"), yesNo(t, env.geolocation)],
    [t("diagnosis.env.permission"), t(`diagnosis.permission.${env.permission}`)],
    [t("diagnosis.env.policy"), t(`diagnosis.policy.${env.policy}`)],
    [t("diagnosis.env.online"), yesNo(t, env.online)],
    [t("diagnosis.env.language"), env.language],
    [t("diagnosis.env.userAgent"), env.userAgent],
  ];
}

/** Plain text to paste into a message. No address, no position unless asked. */
export function buildReport(t: Translate, env: Environment, results: ProbeResult[], coordinates: string | null): string {
  const lines = [t("diagnosis.report.title"), ""];
  for (const [label, value] of environmentLines(t, env)) lines.push(`${label}: ${value}`);
  lines.push("");
  if (results.length === 0) lines.push(t("diagnosis.report.notRun"));
  for (const result of results) lines.push(`${probeName(t, result.id)}: ${resultLine(t, result)}`);
  if (coordinates) lines.push("", `${t("diagnosis.position.label")}: ${coordinates}`);
  return lines.join("\n");
}

function readEnvironment(permission: PermissionReading): Environment {
  return {
    host: describeHost(location.hostname, location.port),
    protocol: location.protocol.replace(":", ""),
    secure: window.isSecureContext,
    geolocation: "geolocation" in navigator,
    permission,
    policy: readPermissionsPolicy(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    online: navigator.onLine,
    build: buildName(import.meta.url),
  };
}

export function LocationDiagnosis() {
  const { t } = useI18n();
  const [permission, setPermission] = useState<PermissionReading>("not-available");
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [running, setRunning] = useState<ProbeId | null>(null);
  const [finished, setFinished] = useState(false);
  const [position, setPosition] = useState<string | null>(null);
  const [positionState, setPositionState] = useState<"idle" | "asking" | "failed">("idle");
  const [includePosition, setIncludePosition] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");
  const work = useRef<AbortController | null>(null);
  const reportRef = useRef<HTMLTextAreaElement>(null);

  const newWork = () => {
    work.current?.abort();
    work.current = new AbortController();
    return work.current.signal;
  };

  useEffect(() => {
    void readPermission().then(setPermission);
    // Leaving the screen stops everything.
    return () => work.current?.abort();
  }, []);

  const environment = useMemo(() => readEnvironment(permission), [permission]);
  const report = buildReport(t, environment, results, includePosition ? position : null);

  async function testNow() {
    if (!("geolocation" in navigator)) return;
    const signal = newWork();
    setResults([]);
    setFinished(false);
    setCopied("idle");
    await runProbes(navigator.geolocation, signal, (result) => setResults((all) => [...all, result]), setRunning);
    if (signal.aborted) return;
    setRunning(null);
    setFinished(true);
    setPermission(await readPermission());
  }

  async function showPosition() {
    if (!("geolocation" in navigator)) return;
    const signal = newWork();
    setRunning(null);
    setPositionState("asking");
    const found = await askPosition(navigator.geolocation, signal);
    if (signal.aborted) return;
    setPosition(found ? roundedCoordinates(found.lat, found.lon) : null);
    setPositionState(found ? "idle" : "failed");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      setCopied("done");
    } catch {
      // No clipboard outside a secure context, which is one of the things this
      // page may well be finding out. The text is there to select by hand.
      reportRef.current?.select();
      setCopied("manual");
    }
  }

  const status = running
    ? t("diagnosis.running", { name: probeName(t, running) })
    : finished
      ? t("diagnosis.finished")
      : "";

  return (
    <div className="page">
      <div className="page__inner diagnosis">
        <h1 className="page__title">{t("diagnosis.title")}</h1>
        <p>{t("diagnosis.intro")}</p>
        <p className="page__eyebrow">{t("diagnosis.privacy")}</p>

        <section aria-labelledby="diagnosis-env">
          <h2 id="diagnosis-env" className="diagnosis__heading">
            {t("diagnosis.env.title")}
          </h2>
          <dl className="diagnosis__list">
            {environmentLines(t, environment).map(([label, value]) => (
              <div key={label} className="diagnosis__row">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="diagnosis-probes" className="diagnosis__section">
          <h2 id="diagnosis-probes" className="diagnosis__heading">
            {t("diagnosis.probes.title")}
          </h2>
          <p>{t("diagnosis.probes.body")}</p>
          <button type="button" className="sa-btn sa-btn--primary diagnosis__action" onClick={() => void testNow()} disabled={running !== null}>
            {t(results.length > 0 || finished ? "diagnosis.again" : "diagnosis.test")}
          </button>
          <p role="status" aria-live="polite" className="diagnosis__status">
            {status}
          </p>
          <ul className="diagnosis__results">
            {PROBES.map(({ id }) => {
              const result = results.find((item) => item.id === id);
              return (
                <li key={id}>
                  <strong>{probeName(t, id)}</strong>
                  <span>{result ? resultLine(t, result) : running === id ? t("diagnosis.result.running") : t("diagnosis.result.waiting")}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="diagnosis-position" className="diagnosis__section">
          <h2 id="diagnosis-position" className="diagnosis__heading">
            {t("diagnosis.position.title")}
          </h2>
          <p>{t("diagnosis.position.body")}</p>
          <button type="button" className="sa-btn diagnosis__action" onClick={() => void showPosition()} disabled={positionState === "asking" || running !== null}>
            {t("diagnosis.position.show")}
          </button>
          <p role="status" aria-live="polite" className="diagnosis__status">
            {positionState === "asking" && t("diagnosis.position.asking")}
            {positionState === "failed" && t("diagnosis.position.failed")}
            {position && positionState === "idle" && `${t("diagnosis.position.label")}: ${position}`}
          </p>
          <label className="diagnosis__check">
            <input type="checkbox" checked={includePosition} disabled={!position} onChange={(event) => setIncludePosition(event.target.checked)} />
            <span>{t("diagnosis.position.include")}</span>
          </label>
        </section>

        <section aria-labelledby="diagnosis-report" className="diagnosis__section">
          <h2 id="diagnosis-report" className="diagnosis__heading">
            {t("diagnosis.report.heading")}
          </h2>
          <textarea
            ref={reportRef}
            className="diagnosis__report"
            aria-labelledby="diagnosis-report"
            readOnly
            rows={14}
            value={report}
          />
          <button type="button" className="sa-btn sa-btn--primary diagnosis__action" onClick={() => void copy()}>
            {t("diagnosis.report.copy")}
          </button>
          <p role="status" aria-live="polite" className="diagnosis__status">
            {copied === "done" && t("diagnosis.report.copied")}
            {copied === "manual" && t("diagnosis.report.manual")}
          </p>
        </section>
      </div>
    </div>
  );
}
