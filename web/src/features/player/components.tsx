// Waveform, the recording card and the mini-player.
import { useEffect, useMemo, useState } from "react";

import { Badge } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { getPeaks, isAbort, type Recording } from "../../lib/api";
import { useRouter } from "../../lib/router";
import { formatDuration, formatTech } from "./format";
import { usePlayer } from "./PlayerContext";

/** Reduce the peaks to `count` bars, keeping the highest value of each slice. */
export function resamplePeaks(peaks: number[], count: number): number[] {
  if (peaks.length === 0) return new Array(count).fill(0);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * peaks.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / count));
    let max = 0;
    for (let j = from; j < to && j < peaks.length; j++) max = Math.max(max, peaks[j]);
    out.push(max);
  }
  return out;
}

export function usePeaks(recordingId: string | null): number[] | null {
  const [state, setState] = useState<{ id: string; peaks: number[] } | null>(null);
  useEffect(() => {
    if (!recordingId) return;
    const controller = new AbortController();
    getPeaks(recordingId, controller.signal)
      .then((peaks) => setState({ id: recordingId, peaks }))
      .catch((error) => {
        if (!isAbort(error)) setState({ id: recordingId, peaks: [] });
      });
    return () => controller.abort();
  }, [recordingId]);
  return state && state.id === recordingId ? state.peaks : null;
}

/** The drawn sound. Decorative for screen readers: the position slider is the control. */
export function Waveform({
  peaks,
  progress = 0,
  tall = false,
  bars = 64,
}: {
  peaks: number[] | null;
  progress?: number;
  tall?: boolean;
  bars?: number;
}) {
  const shape = useMemo(() => {
    const values = resamplePeaks(peaks ?? [], bars);
    const max = Math.max(...values, 0.001);
    return values.map((value) => Math.max(0.06, value / max));
  }, [peaks, bars]);
  const on = Math.round(progress * bars);
  return (
    <div className={`sa-wave${tall ? " sa-wave--tall" : ""}`} aria-hidden="true" data-testid="waveform">
      {shape.map((height, index) => (
        <b key={index} className={index < on ? "on" : undefined} style={{ height: `${Math.round(height * 100)}%` }} />
      ))}
    </div>
  );
}

export function PlayIcon({ playing }: { playing: boolean }) {
  return <Icon name={playing ? "pause" : "play"} />;
}

function statusBadge(recording: Recording, t: (key: string) => string) {
  if (recording.status === "processing") return <Badge tone="warning" icon="timer">{t("recording.status.processing")}</Badge>;
  if (recording.status === "failed") return <Badge tone="danger" icon="alert">{t("recording.status.failed")}</Badge>;
  if (recording.status === "removed") return <Badge tone="danger" icon="alert">{t("recording.status.removed")}</Badge>;
  return null;
}

export function RecordingCard({ recording }: { recording: Recording }) {
  const { t, formatDateShort } = useI18n();
  const player = usePlayer();
  const { navigate } = useRouter();
  const isCurrent = player.current?.id === recording.id;
  const playing = isCurrent && player.playing;
  const ready = recording.status === "ready";
  const href = `/recordings/${recording.id}`;
  const author = recording.author_name ?? t("recording.anonymous");
  return (
    <article className={`sa-card${playing ? " sa-card--playing" : ""}`} data-testid="recording-card">
      {ready ? (
        <button
          type="button"
          className="sa-play"
          aria-label={t(playing ? "player.pauseNamed" : "player.playNamed", { title: recording.title })}
          onClick={() => (isCurrent ? player.toggle() : player.play(recording))}
        >
          <PlayIcon playing={playing} />
        </button>
      ) : (
        <span className="sa-play sa-play--idle" aria-hidden="true">
          <Icon name="timer" />
        </span>
      )}
      <div>
        <a
          className="sa-card__title"
          href={href}
          onClick={(event) => {
            event.preventDefault();
            navigate(href);
          }}
        >
          {recording.title}
        </a>
        <p className="sa-card__line">
          {formatDateShort(recording.recorded_at)} · {formatDuration(recording.duration_seconds)} · {author}
        </p>
        {ready && <p className="meta">{formatTech(recording, t)}</p>}
        {statusBadge(recording, t)}
      </div>
    </article>
  );
}

export function MiniPlayer() {
  const { t } = useI18n();
  const player = usePlayer();
  const { navigate } = useRouter();
  const { current } = player;
  if (!current) return null;
  const href = `/recordings/${current.id}`;
  let line = player.loop ? t("player.onLoop") : `${formatDuration(player.time)} / ${formatDuration(player.duration)}`;
  if (player.sleepRemaining !== null) {
    line += ` · ${t("player.stopsIn", { time: formatDuration(player.sleepRemaining / 1000) })}`;
  }
  return (
    <section className="sa-mini" aria-label={t("player.mini")} data-testid="mini-player">
      <button
        type="button"
        className="sa-play"
        aria-label={t(player.playing ? "player.pauseNamed" : "player.playNamed", { title: current.title })}
        onClick={player.toggle}
      >
        <PlayIcon playing={player.playing} />
      </button>
      <div className="sa-mini__text">
        <a
          className="sa-mini__title"
          href={href}
          onClick={(event) => {
            event.preventDefault();
            navigate(href);
          }}
        >
          {current.title}
        </a>
        <p className="meta">{line}</p>
      </div>
      <button type="button" className="sa-btn sa-btn--quiet sa-btn--icon" aria-label={t("player.close")} onClick={player.close}>
        <Icon name="close" />
      </button>
    </section>
  );
}
