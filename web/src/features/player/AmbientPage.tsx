// Ambient mode (screen 08): loop one sound, with a timer to stop it.
// Nothing here plays by itself; the person presses the big button.
import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { Segmented, Skeleton } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { getRecording, isAbort, type Recording } from "../../lib/api";
import { useRouter } from "../../lib/router";
import { PlayIcon, usePeaks, Waveform } from "./components";
import { usePlayer, type SleepOption } from "./PlayerContext";

import "./player.css";

export function AmbientPage({ recordingId }: { recordingId: string }) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const player = usePlayer();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [failed, setFailed] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const volumeId = useId();
  const wakeSupported = "wakeLock" in navigator;
  const peaks = usePeaks(recording?.id ?? null);

  useEffect(() => {
    const controller = new AbortController();
    getRecording(recordingId, controller.signal)
      .then(setRecording)
      .catch((error) => {
        if (!isAbort(error)) setFailed(true);
      });
    return () => controller.abort();
  }, [recordingId]);

  const { setLoop } = player;
  // Entering ambient mode turns the loop on, and leaving returns to normal.
  useEffect(() => {
    setLoop(true);
    return () => setLoop(false);
  }, [setLoop]);

  // Keep the screen on, only if the person asks for it, and let go at the end.
  useEffect(() => {
    if (!keepAwake || !wakeSupported) return;
    let cancelled = false;
    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) void sentinel.release();
        else wakeLock.current = sentinel;
      } catch {
        setKeepAwake(false);
      }
    };
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void wakeLock.current?.release();
      wakeLock.current = null;
    };
  }, [keepAwake, wakeSupported]);

  const isCurrent = recording !== null && player.current?.id === recording.id;
  const playing = isCurrent && player.playing;
  const duration = (isCurrent && player.duration) || recording?.duration_seconds || 0;
  const progress = isCurrent && duration ? player.time / duration : 0;

  const back = () => navigate(`/recordings/${recordingId}`);

  if (!recording) {
    return (
      <div className="page">
        <div className="page__inner">
          <h1 className="visually-hidden">{t("ambient.title")}</h1>
          {failed ? <p className="notice notice--error">{t("recording.error")}</p> : <Skeleton label={t("recording.loading")} />}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__inner ambient">
        <div className="page__bar">
          <button type="button" className="sa-btn sa-btn--quiet" onClick={back}>
            <span className="icon-back">
              <Icon name="chevron" size={20} />
            </span>
            {t("ambient.exit")}
          </button>
        </div>
        {recording.place_name && <p className="page__eyebrow">{recording.place_name}</p>}
        <h1 className="ambient__title">{recording.title}</h1>
        <Waveform peaks={peaks} progress={progress} tall bars={48} />

        <div className="ambient__controls">
          <button
            type="button"
            className="sa-btn sa-btn--icon ambient__side"
            aria-pressed={player.loop}
            aria-label={t("ambient.loop")}
            onClick={() => player.setLoop(!player.loop)}
          >
            <Icon name="loop" />
          </button>
          <button
            type="button"
            className="sa-play sa-play--large"
            aria-label={t(playing ? "player.pauseNamed" : "player.playNamed", { title: recording.title })}
            onClick={() => (isCurrent ? player.toggle() : player.play(recording))}
          >
            <PlayIcon playing={playing} />
          </button>
          <span className="ambient__side" aria-hidden="true">
            <Icon name="timer" />
          </span>
        </div>

        <Segmented
          label={t("ambient.stopIn")}
          value={String(player.sleepMinutes ?? "never")}
          options={[
            { value: "15", label: t("ambient.minutes", { n: 15 }) },
            { value: "30", label: t("ambient.minutes", { n: 30 }) },
            { value: "60", label: t("ambient.hour") },
            { value: "never", label: t("ambient.never") },
          ]}
          onChange={(value) => player.setSleep(value === "never" ? null : (Number(value) as SleepOption))}
        />

        <div className="field">
          <label htmlFor={volumeId} className="field__label">
            {t("ambient.volume")}
          </label>
          <input
            id={volumeId}
            className="sa-range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={player.volume}
            onChange={(event) => player.setVolume(Number(event.target.value))}
          />
          <p className="caption">{t("ambient.noNormalise")}</p>
        </div>

        {wakeSupported && (
          <label className="ambient__wake">
            <input type="checkbox" checked={keepAwake} onChange={(event) => setKeepAwake(event.target.checked)} />
            <span>{t("ambient.keepAwake")}</span>
          </label>
        )}
      </div>
    </div>
  );
}
