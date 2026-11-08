// One recording (screen 03): the player, what you can hear, how it was made.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Icon } from "../../components/Icon";
import { Badge, Field, Skeleton, useToast } from "../../components/ui";
import { useAuth } from "../auth/AuthContext";
import { useI18n } from "../../i18n/i18n";
import { ApiError, getRecording, isAbort, originalUrl, removeRecording, reportRecording, updateRecording, type License, type Recording } from "../../lib/api";
import { useRouter } from "../../lib/router";
import { initialValues, PublishFields, toLocalInput, type PublishValues } from "../record/publish";
import { PlayIcon, usePeaks, Waveform } from "./components";
import { formatBytes, formatDuration, formatLufs, formatTech } from "./format";
import { usePlayer } from "./PlayerContext";

import "./player.css";

type Load = { kind: "loading" } | { kind: "gone" } | { kind: "missing" } | { kind: "error" } | { kind: "ready"; recording: Recording };

function CaptureFacts({ recording }: { recording: Recording }) {
  const { t, formatNumber } = useI18n();
  const settings = recording.capture_settings ?? {};
  const applied = ["echoCancellation", "noiseSuppression", "autoGainControl"].filter((key) => settings[key] === true);
  return (
    <section className="card" aria-labelledby="how-heading">
      <h2 id="how-heading" className="card__heading">
        {t("recording.how")}
      </h2>
      <dl className="sa-kv">
        <dt>{t("recording.fact.device")}</dt>
        <dd>{recording.device_note ?? t("recording.fact.notDeclared")}</dd>
        <dt>{t("recording.fact.method")}</dt>
        <dd>{t(`recording.method.${recording.capture_method}`)}</dd>
        {recording.capture_method === "browser" && (
          <>
            <dt>{t("recording.fact.browserProcessing")}</dt>
            <dd data-testid="browser-processing">
              {applied.length === 0 ? t("recording.fact.noProcessing") : applied.map((key) => t(`record.applied.${key}`)).join(", ")}
            </dd>
          </>
        )}
        <dt>{t("recording.fact.format")}</dt>
        <dd>{[recording.codec, formatTech(recording, t)].filter(Boolean).join(" · ")}</dd>
        <dt>{t("recording.fact.loudness")}</dt>
        <dd data-testid="loudness">{formatLufs(recording.loudness_lufs)}</dd>
        {recording.true_peak_dbfs !== null && (
          <>
            <dt>{t("recording.fact.peak")}</dt>
            <dd>{`${formatNumber(recording.true_peak_dbfs, { maximumFractionDigits: 1 }).replace("-", "−")} dBTP`}</dd>
          </>
        )}
        <dt>{t("recording.fact.original")}</dt>
        <dd>
          {recording.size_bytes ? formatBytes(recording.size_bytes) : "–"}
          {recording.sha256 && (
            <>
              {" · SHA-256 "}
              <span title={recording.sha256} data-testid="sha256">
                {recording.sha256}
              </span>
            </>
          )}
        </dd>
        <dt>{t("recording.fact.license")}</dt>
        <dd>{t(`license.${recording.license}`)}</dd>
        <dt>{t("recording.fact.accuracy")}</dt>
        <dd>
          {recording.location_accuracy_m !== null
            ? t("recording.fact.accuracyValue", { meters: recording.location_accuracy_m })
            : t("recording.fact.accuracyUnknown")}
        </dd>
      </dl>
    </section>
  );
}

function ReportBox({ recordingId, onClose }: { recordingId: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError(t("report.tooShort"));
      return;
    }
    setBusy(true);
    try {
      await reportRecording(recordingId, reason.trim());
      toast(t("report.sent"));
      onClose();
    } catch {
      setError(t("report.failed"));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <h2 className="card__heading">{t("report.title")}</h2>
      <p className="caption">{t("report.body")}</p>
      <Field label={t("report.reason")} error={error}>
        {(props) => <textarea {...props} className="textarea" maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <div className="actions">
        <button type="submit" className="sa-btn sa-btn--primary" disabled={busy}>
          {t("report.send")}
        </button>
        <button type="button" className="sa-btn sa-btn--quiet" onClick={onClose}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

function OwnerTools({ recording, onChange }: { recording: Recording; onChange: (recording: Recording) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { navigate } = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [values, setValues] = useState<PublishValues>(() => ({
    ...initialValues(new Date(recording.recorded_at)),
    title: recording.title,
    heard: recording.heard ?? "",
    showAuthor: recording.show_author,
    visibility: recording.visibility,
    license: recording.license as License,
    deviceNote: recording.device_note ?? "",
    recordedAt: toLocalInput(new Date(recording.recorded_at)),
  }));

  async function save(event: FormEvent) {
    event.preventDefault();
    const updated = await updateRecording(recording.id, {
      title: values.title.trim(),
      heard: values.heard.trim() || null,
      visibility: values.visibility,
      show_author: values.showAuthor,
      license: values.license,
      device_note: values.deviceNote.trim() || null,
      recorded_at: new Date(values.recordedAt).toISOString(),
    });
    onChange(updated);
    setEditing(false);
    toast(t("recording.saved"));
  }

  async function remove() {
    await removeRecording(recording.id);
    toast(t("recording.removedToast"));
    navigate(`/?place=${recording.place_id}`);
  }

  if (editing) {
    return (
      <form className="card" onSubmit={save} noValidate>
        <h2 className="card__heading">{t("recording.edit")}</h2>
        <PublishFields values={values} onChange={setValues} />
        <div className="actions">
          <button type="submit" className="sa-btn sa-btn--primary" disabled={!values.title.trim()}>
            {t("recording.save")}
          </button>
          <button type="button" className="sa-btn sa-btn--quiet" onClick={() => setEditing(false)}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="actions">
      <button type="button" className="sa-btn" onClick={() => setEditing(true)}>
        {t("recording.edit")}
      </button>
      {confirming ? (
        <>
          <button type="button" className="sa-btn sa-btn--danger" onClick={remove}>
            <Icon name="trash" size={20} />
            {t("recording.removeConfirm")}
          </button>
          <button type="button" className="sa-btn sa-btn--quiet" onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </button>
        </>
      ) : (
        <button type="button" className="sa-btn sa-btn--danger" onClick={() => setConfirming(true)}>
          <Icon name="trash" size={20} />
          {t("recording.remove")}
        </button>
      )}
    </div>
  );
}

export function RecordingPage({ recordingId }: { recordingId: string }) {
  const { t, formatDateTime } = useI18n();
  const { navigate } = useRouter();
  const { user } = useAuth();
  const player = usePlayer();
  const [result, setResult] = useState<{ id: string; load: Load } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [reporting, setReporting] = useState(false);
  const positionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const key = `${recordingId}:${attempt}`;
  const load: Load = result?.id === key ? result.load : { kind: "loading" };

  useEffect(() => {
    const controller = new AbortController();
    getRecording(recordingId, controller.signal)
      .then((recording) => setResult({ id: key, load: { kind: "ready", recording } }))
      .catch((error) => {
        if (isAbort(error)) return;
        const status = error instanceof ApiError ? error.status : 0;
        setResult({ id: key, load: { kind: status === 410 ? "gone" : status === 404 ? "missing" : "error" } });
      });
    return () => controller.abort();
  }, [recordingId, key]);

  const ready = load.kind === "ready" ? load.recording : null;
  const peaks = usePeaks(ready && ready.status === "ready" ? ready.id : null);

  useEffect(() => {
    if (ready) headingRef.current?.focus();
  }, [ready?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = (
    <button type="button" className="sa-btn sa-btn--quiet" onClick={() => (ready ? navigate(`/?place=${ready.place_id}`) : navigate("/"))}>
      <span className="icon-back">
        <Icon name="chevron" size={20} />
      </span>
      {t("common.back")}
    </button>
  );

  if (load.kind !== "ready" || !ready) {
    return (
      <div className="page">
        <div className="page__inner">
          <div className="page__bar">{back}</div>
          <h1 className="visually-hidden">{t("recording.pageTitle")}</h1>
          {load.kind === "loading" && <Skeleton label={t("recording.loading")} />}
          {load.kind === "gone" && (
            <div className="card">
              <div>
                <Badge tone="danger" icon="alert">
                  {t("recording.goneBadge")}
                </Badge>
              </div>
              <p>{t("recording.gone")}</p>
            </div>
          )}
          {load.kind === "missing" && <p className="notice">{t("recording.missing")}</p>}
          {load.kind === "error" && (
            <div className="notice notice--error">
              <p>{t("recording.error")}</p>
              <button type="button" className="sa-btn" onClick={() => setAttempt((n) => n + 1)}>
                {t("common.retry")}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const isCurrent = player.current?.id === ready.id;
  const playing = isCurrent && player.playing;
  const duration = (isCurrent && player.duration) || ready.duration_seconds || 0;
  const time = isCurrent ? player.time : 0;
  const canPlay = ready.status === "ready";

  return (
    <div className="page">
      <div className="page__inner">
        <div className="page__bar">
          {back}
          {!ready.is_owner && (
            <button type="button" className="sa-btn sa-btn--quiet sa-btn--icon" aria-label={t("report.title")} onClick={() => setReporting(true)}>
              <Icon name="flag" />
            </button>
          )}
        </div>

        {reporting && <ReportBox recordingId={ready.id} onClose={() => setReporting(false)} />}

        <header className="recording-head">
          {ready.place_name && <p className="page__eyebrow">{ready.place_name}</p>}
          <h1 ref={headingRef} tabIndex={-1} className="page__title">
            {ready.title}
          </h1>
          <p className="caption">
            {formatDateTime(ready.recorded_at)} · {ready.author_name ?? t("recording.anonymous")}
          </p>
          <div className="sa-badges">
            <Badge icon={ready.visibility === "public" ? "globe" : "lock"}>{t(`publish.${ready.visibility}`)}</Badge>
            {ready.status === "processing" && (
              <Badge tone="warning" icon="timer">
                {t("recording.status.processing")}
              </Badge>
            )}
            {ready.status === "failed" && (
              <Badge tone="danger" icon="alert">
                {t("recording.status.failed")}
              </Badge>
            )}
            {ready.status === "removed" && (
              <Badge tone="danger" icon="alert">
                {t("recording.status.removed")}
              </Badge>
            )}
          </div>
        </header>

        {ready.status === "failed" && (
          <p className="notice notice--error" role="alert">
            {t(`publish.failure.${ready.failure_code ?? "processing_error"}`)}
          </p>
        )}

        {canPlay && (
          <section className="card" aria-label={t("recording.player")}>
            <div className="player-top">
              <button
                type="button"
                className="sa-play sa-play--large"
                aria-label={t(playing ? "player.pauseNamed" : "player.playNamed", { title: ready.title })}
                onClick={() => (isCurrent ? player.toggle() : player.play(ready))}
              >
                <PlayIcon playing={playing} />
              </button>
              <p className="timecode" data-testid="timecode">
                {formatDuration(time)} / {formatDuration(duration)}
              </p>
            </div>
            <Waveform peaks={peaks} progress={duration ? time / duration : 0} />
            <div className="field">
              <label htmlFor={positionId} className="caption">
                {t("player.position")}
              </label>
              <input
                id={positionId}
                className="sa-range"
                type="range"
                min={0}
                max={duration || 1}
                step={0.5}
                value={Math.min(time, duration || 1)}
                aria-valuetext={`${formatDuration(time)} / ${formatDuration(duration)}`}
                disabled={!isCurrent}
                onChange={(event) => player.seek(Number(event.target.value))}
              />
            </div>
            {player.error && isCurrent && (
              <p className="notice notice--error" role="alert">
                {t("player.error")}
              </p>
            )}
          </section>
        )}

        <section aria-labelledby="heard-heading">
          <h2 id="heard-heading" className="card__heading">
            {t("publish.heard")}
          </h2>
          <p className="recording-heard">{ready.heard ?? t("recording.noHeard")}</p>
        </section>

        <CaptureFacts recording={ready} />

        {canPlay && (
          <div className="actions">
            <button type="button" className="sa-btn sa-btn--primary" onClick={() => navigate(`/recordings/${ready.id}/ambient`)}>
              <Icon name="loop" size={20} />
              {t("recording.ambient")}
            </button>
            <a className="sa-btn" href={originalUrl(ready.id)}>
              <Icon name="download" size={20} />
              {t("recording.download")}
            </a>
          </div>
        )}

        {(ready.is_owner || user?.role === "admin") && ready.status !== "removed" && (
          <OwnerTools recording={ready} onChange={(recording) => setResult({ id: key, load: { kind: "ready", recording } })} />
        )}
      </div>
    </div>
  );
}
