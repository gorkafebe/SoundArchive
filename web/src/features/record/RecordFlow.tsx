// Recording in the browser (screens 04, 05, 06): explain, ask, record, listen
// back, publish. The microphone is only requested after pressing Continue.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { useAnnounce } from "../../components/Announcer";
import { Icon } from "../../components/Icon";
import { Badge, PrePrompt, Segmented, useToast } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { getPlace, type Place, type Recording } from "../../lib/api";
import { useRouter } from "../../lib/router";
import { formatBytes, formatDuration } from "../player/format";
import { usePlayer } from "../player/PlayerContext";
import {
  bestMimeType,
  LOSSLESS_MAX_SECONDS,
  microphoneAvailable,
  processingStillOn,
  Recorder,
  requestMicrophone,
  type Captured,
  type Quality,
} from "./capture";
import { initialValues, JobStatus, PublishFields, usePublishJob, type PublishValues } from "./publish";

import "./record.css";

type Step = "intro" | "blocked" | "unsupported" | "ready" | "recording" | "review";

const METER_BARS = 16;

function Meter({ recorder }: { recorder: Recorder | null }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!recorder) return;
    let frame = 0;
    const loop = () => {
      setLevel(recorder.level());
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [recorder]);
  // A dB scale: quiet places must still move the meter.
  const db = level > 0 ? 20 * Math.log10(level) : -90;
  const on = Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * METER_BARS);
  return (
    <div className="sa-meter" aria-hidden="true" data-testid="meter">
      {Array.from({ length: METER_BARS }, (_, i) => (
        <b key={i} className={i < on ? "on" : undefined} style={{ height: `${25 + (i / METER_BARS) * 75}%` }} />
      ))}
    </div>
  );
}

export function RecordFlow({ placeId }: { placeId: string }) {
  const { t, language } = useI18n();
  const announce = useAnnounce();
  const toast = useToast();
  const { navigate } = useRouter();
  const player = usePlayer();
  const [place, setPlace] = useState<Place | null>(null);
  const [step, setStep] = useState<Step>(microphoneAvailable() ? "intro" : "unsupported");
  const [quality, setQuality] = useState<Quality>("lossless");
  const [elapsed, setElapsed] = useState(0);
  const [limitHit, setLimitHit] = useState(false);
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [values, setValues] = useState<PublishValues>(() => initialValues(new Date()));
  const [titleError, setTitleError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    getPlace(placeId, controller.signal)
      .then(setPlace)
      .catch(() => {});
    return () => controller.abort();
  }, [placeId]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // Whatever happens, never leave the microphone open behind us.
  useEffect(() => () => recorderRef.current?.release(), []);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const onReady = useCallback(
    (recording: Recording) => {
      toast(t("publish.done"));
      navigate(`/recordings/${recording.id}`);
    },
    [navigate, t, toast],
  );
  const job = usePublishJob(onReady);

  const backHref = `/?place=${placeId}`;

  async function enable() {
    try {
      const stream = await requestMicrophone();
      const active = new Recorder(stream);
      recorderRef.current = active;
      setRecorder(active);
      setStep("ready");
    } catch {
      setStep("blocked");
    }
  }

  async function startRecording() {
    player.pause();
    await recorderRef.current?.start(quality);
    setElapsed(0);
    setValues(initialValues(new Date()));
    setStep("recording");
    announce(t("record.started"));
  }

  const stopRecording = useCallback(async () => {
    const active = recorderRef.current;
    if (!active) return;
    recorderRef.current = null;
    setRecorder(null);
    const result = await active.stop();
    setCaptured(result);
    setWarnings(processingStillOn(result.settings));
    setPreviewUrl(URL.createObjectURL(result.blob));
    setStep("review");
    announce(t("record.stopped"));
  }, [announce, t]);

  useEffect(() => {
    if (step !== "recording") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const seconds = (Date.now() - startedAt) / 1000;
      setElapsed(seconds);
      if (quality === "lossless" && seconds >= LOSSLESS_MAX_SECONDS) {
        setLimitHit(true);
        void stopRecording();
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [step, quality, stopRecording]);

  function publish(event: FormEvent) {
    event.preventDefault();
    if (!values.title.trim()) {
      setTitleError(t("publish.titleRequired"));
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    if (captured) {
      void job.start(placeId, values, captured.blob, captured.filename, { method: "browser", settings: captured.settings });
    }
  }

  const busy = job.state.kind === "uploading" || job.state.kind === "processing";

  const placeLine = place && (
    <>
      <p className="page__eyebrow">{t("record.place")}</p>
      <h2 className="page__title">{place.name}</h2>
    </>
  );

  return (
    <div className="page">
      <div className="page__inner record">
        <div className="page__bar">
          <button type="button" className="sa-btn sa-btn--quiet" onClick={() => navigate(backHref)} disabled={busy}>
            <Icon name="close" size={20} />
            {t("common.cancel")}
          </button>
          {step === "recording" && (
            <Badge tone="danger" icon="alert">
              {t("record.recording")}
            </Badge>
          )}
        </div>

        {step === "intro" && (
          <>
            <h1 ref={headingRef} tabIndex={-1} className="visually-hidden">
              {t("record.title")}
            </h1>
            {placeLine}
            <PrePrompt
              icon="mic"
              title={t("record.preTitle")}
              actions={
                <>
                  <button type="button" className="sa-btn sa-btn--primary" onClick={enable}>
                    {t("record.continue")}
                  </button>
                  <button type="button" className="sa-btn sa-btn--quiet" onClick={() => navigate(`/upload?place=${placeId}`)}>
                    <Icon name="upload" size={20} />
                    {t("record.uploadInstead")}
                  </button>
                </>
              }
            >
              {t("record.preBody")}
            </PrePrompt>
          </>
        )}

        {step === "blocked" && (
          <div className="card">
            <h1 ref={headingRef} tabIndex={-1} className="card__heading">
              {t("record.blockedTitle")}
            </h1>
            <div>
              <Badge tone="danger" icon="lock">
                {t("record.blockedBadge")}
              </Badge>
            </div>
            <p>{t("record.blockedBody")}</p>
            <div className="actions">
              <button type="button" className="sa-btn sa-btn--primary" onClick={enable}>
                {t("common.retry")}
              </button>
              <button type="button" className="sa-btn" onClick={() => navigate(`/upload?place=${placeId}`)}>
                <Icon name="upload" size={20} />
                {t("record.uploadInstead")}
              </button>
            </div>
          </div>
        )}

        {step === "unsupported" && (
          <div className="card">
            <h1 ref={headingRef} tabIndex={-1} className="card__heading">
              {t("record.unsupportedTitle")}
            </h1>
            <p>{t("record.unsupportedBody")}</p>
            <div className="actions">
              <button type="button" className="sa-btn" onClick={() => navigate(`/upload?place=${placeId}`)}>
                <Icon name="upload" size={20} />
                {t("record.uploadInstead")}
              </button>
            </div>
          </div>
        )}

        {(step === "ready" || step === "recording") && (
          <>
            <h1 ref={headingRef} tabIndex={-1} className="visually-hidden">
              {t(step === "ready" ? "record.readyTitle" : "record.recording")}
            </h1>
            {placeLine}
            <p className="record__clock timecode" role="timer" aria-label={t("record.elapsed")}>
              {formatDuration(elapsed)}
            </p>
            <Meter recorder={recorder} />
            {step === "ready" && (
              <Segmented
                label={t("record.quality")}
                value={quality}
                hint={t(quality === "lossless" ? "record.losslessHint" : "record.compressedHint", {
                  minutes: LOSSLESS_MAX_SECONDS / 60,
                  codec: bestMimeType()?.split(";")[0] ?? "",
                })}
                options={[
                  { value: "lossless", label: t("record.lossless") },
                  { value: "compressed", label: t("record.compressed") },
                ]}
                onChange={(value) => setQuality(value as Quality)}
              />
            )}
            <p className="caption">{t("record.processingNote")}</p>
            <div className="record__control">
              {step === "ready" ? (
                <button type="button" className="sa-recbtn" aria-label={t("record.start")} onClick={startRecording}>
                  <Icon name="record" size={36} />
                </button>
              ) : (
                <button type="button" className="sa-recbtn sa-recbtn--live" aria-label={t("record.stop")} onClick={stopRecording}>
                  <Icon name="stop" size={32} />
                </button>
              )}
            </div>
          </>
        )}

        {step === "review" && captured && (
          <form className="record__review" onSubmit={publish} noValidate>
            <h1 ref={headingRef} tabIndex={-1} className="page__title">
              {t("record.reviewTitle")}
            </h1>
            {limitHit && (
              <p className="notice" role="status">
                {t("record.limitReached", { minutes: LOSSLESS_MAX_SECONDS / 60 })}
              </p>
            )}
            {warnings.length > 0 && (
              <p className="notice" role="status" data-testid="processing-warning">
                {t("record.processingWarning", { list: warnings.map((key) => t(`record.applied.${key}`)).join(", ") })}
              </p>
            )}
            <div className="card">
              {previewUrl && <audio controls preload="metadata" src={previewUrl} aria-label={t("record.preview")} className="record__preview" data-testid="preview-audio" />}
              <p className="meta">
                {formatDuration(captured.seconds)} · {String(captured.settings.format)} · {formatBytes(captured.blob.size)}
              </p>
              <p className="caption">{t(quality === "lossless" ? "record.isLossless" : "record.isCompressed")}</p>
            </div>
            <PublishFields values={values} onChange={setValues} titleError={titleError} titleRef={titleRef} />
            <JobStatus state={job.state} formatBytes={formatBytes} />
            <div className="actions">
              <button type="submit" className="sa-btn sa-btn--primary" disabled={busy} lang={language}>
                <Icon name="check" size={20} />
                {t("publish.submit")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
