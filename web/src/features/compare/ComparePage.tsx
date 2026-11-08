// Comparing one place across time (screen 09). Two audio elements, kept level
// with each other: pressing "Switch" silences one and continues in the other
// at the same point, so you hear the difference and not the gap.
//
// The volume of each stays as it was recorded; the difference is written down.
import { useEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { Field, Skeleton } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { audioUrl, getPlace, isAbort, listRecordings, type Place, type Recording } from "../../lib/api";
import { useRouter } from "../../lib/router";
import { usePeaks, Waveform } from "../player/components";
import { formatDuration, formatLufs } from "../player/format";
import { usePlayer } from "../player/PlayerContext";

import "./compare.css";

type Slot = "A" | "B";

function Track({
  slot,
  recording,
  active,
  progress,
}: {
  slot: Slot;
  recording: Recording | null;
  active: boolean;
  progress: number;
}) {
  const { formatDateShort } = useI18n();
  const peaks = usePeaks(recording?.id ?? null);
  return (
    <div className={`card compare-track${active ? " compare-track--active" : ""}`} data-testid={`track-${slot}`} data-active={active}>
      <div className="compare-track__top">
        <span className="sa-badge">
          {active && <Icon name="play" size={16} />}
          {slot}
        </span>
        {recording && (
          <span className="meta">
            {formatDateShort(recording.recorded_at)} · {formatLufs(recording.loudness_lufs)}
          </span>
        )}
      </div>
      <Waveform peaks={peaks} progress={active ? progress : 0} />
    </div>
  );
}

export function ComparePage({ placeId }: { placeId: string }) {
  const { t, formatDateShort } = useI18n();
  const { navigate } = useRouter();
  const player = usePlayer();
  const [place, setPlace] = useState<Place | null>(null);
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");
  const [active, setActive] = useState<Slot>("A");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const refs = useRef<Record<Slot, HTMLAudioElement | null>>({ A: null, B: null });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getPlace(placeId, controller.signal), listRecordings(placeId, controller.signal)])
      .then(([placeData, list]) => {
        setPlace(placeData);
        const ready = list.items.filter((r) => r.status === "ready").reverse();
        setRecordings(ready);
        if (ready.length >= 2) {
          setAId(ready[ready.length - 2].id);
          setBId(ready[ready.length - 1].id);
        }
      })
      .catch((error) => {
        if (!isAbort(error)) setFailed(true);
      });
    return () => controller.abort();
  }, [placeId]);

  // One sound at a time, in the whole app.
  const { pause: pauseGlobal } = player;
  useEffect(() => pauseGlobal(), [pauseGlobal]);

  const a = recordings?.find((r) => r.id === aId) ?? null;
  const b = recordings?.find((r) => r.id === bId) ?? null;
  const duration = active === "A" ? (a?.duration_seconds ?? 0) : (b?.duration_seconds ?? 0);
  const other = (slot: Slot): Slot => (slot === "A" ? "B" : "A");

  function togglePlay() {
    const audio = refs.current[active];
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  /** Continue in the other recording, at the same point, with a clean cut. */
  function switchTrack() {
    const from = refs.current[active];
    const next = other(active);
    const to = refs.current[next];
    if (!from || !to) return;
    const wasPlaying = !from.paused;
    const position = from.currentTime;
    from.pause();
    to.currentTime = Math.min(position, Number.isFinite(to.duration) ? to.duration : position);
    setActive(next);
    setTime(to.currentTime);
    if (wasPlaying) void to.play();
  }

  /** Put the inactive one at the same point without changing what you hear. */
  function sync() {
    const from = refs.current[active];
    const to = refs.current[other(active)];
    if (from && to) to.currentTime = from.currentTime;
  }

  function choose(slot: Slot, id: string) {
    refs.current[slot]?.pause();
    if (slot === "A") setAId(id);
    else setBId(id);
    setTime(0);
  }

  const back = (
    <button type="button" className="sa-btn sa-btn--quiet" onClick={() => navigate(`/?place=${placeId}`)}>
      <span className="icon-back">
        <Icon name="chevron" size={20} />
      </span>
      {t("common.back")}
    </button>
  );

  if (failed || recordings === null) {
    return (
      <div className="page">
        <div className="page__inner">
          <div className="page__bar">{back}</div>
          <h1 className="visually-hidden">{t("compare.pageTitle")}</h1>
          {failed ? <p className="notice notice--error">{t("recording.error")}</p> : <Skeleton label={t("recording.loading")} />}
        </div>
      </div>
    );
  }

  const title = t("compare.title", { place: place?.name ?? "" });

  if (recordings.length < 2) {
    return (
      <div className="page">
        <div className="page__inner">
          <div className="page__bar">{back}</div>
          <h1 className="page__title">{title}</h1>
          <p className="notice">{t("compare.needTwo")}</p>
        </div>
      </div>
    );
  }

  const options = recordings.map((r) => ({ id: r.id, label: `${formatDateShort(r.recorded_at)} · ${r.title}` }));
  const year = (r: Recording) => new Date(r.recorded_at).getFullYear();

  return (
    <div className="page">
      <div className="page__inner">
        <div className="page__bar">{back}</div>
        <h1 className="page__title">{title}</h1>

        <div className="card">
          {/* The timeline. Each point chooses for the track in use; the two
              lists below do the same in a form that does not need a pointer. */}
          <ol className="compare-line" aria-label={t("compare.timeline")}>
            {recordings.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`compare-point${r.id === aId || r.id === bId ? " compare-point--on" : ""}`}
                  aria-pressed={r.id === (active === "A" ? aId : bId)}
                  aria-label={t("compare.pick", { slot: active, label: `${formatDateShort(r.recorded_at)} · ${r.title}` })}
                  onClick={() => choose(active, r.id)}
                >
                  <i />
                  <span className="meta">{year(r)}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="compare-selects">
            {(["A", "B"] as const).map((slot) => (
              <Field key={slot} label={t("compare.choose", { slot })}>
                {(props) => (
                  <select {...props} className="select publish-fields__select" value={slot === "A" ? aId : bId} onChange={(e) => choose(slot, e.target.value)}>
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ))}
          </div>
        </div>

        <Track slot="A" recording={a} active={active === "A"} progress={duration ? time / duration : 0} />
        <Track slot="B" recording={b} active={active === "B"} progress={duration ? time / duration : 0} />

        {(["A", "B"] as const).map((slot) => {
          const recording = slot === "A" ? a : b;
          return (
            recording && (
              <audio
                key={slot}
                ref={(element) => {
                  refs.current[slot] = element;
                }}
                preload="metadata"
                src={audioUrl(recording.id)}
                data-testid={`audio-${slot}`}
                onPlay={() => slot === active && setPlaying(true)}
                onPause={() => slot === active && setPlaying(false)}
                onEnded={() => slot === active && setPlaying(false)}
                onTimeUpdate={(event) => slot === active && setTime(event.currentTarget.currentTime)}
              />
            )
          );
        })}

        <p className="timecode" data-testid="compare-time">
          {formatDuration(time)} / {formatDuration(duration)}
        </p>

        <div className="actions">
          <button type="button" className="sa-btn sa-btn--primary" onClick={togglePlay}>
            <Icon name={playing ? "pause" : "play"} size={20} />
            {t(playing ? "compare.pause" : "compare.play")}
          </button>
          <button type="button" className="sa-btn sa-btn--primary" onClick={switchTrack}>
            <Icon name="compare" size={20} />
            {t("compare.switch")}
          </button>
          <button type="button" className="sa-btn" onClick={sync}>
            {t("compare.sync")}
          </button>
        </div>

        <p className="caption">{t("compare.note")}</p>
      </div>
    </div>
  );
}
