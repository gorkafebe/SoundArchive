// The one audio element of the app, outside the screens: the sound keeps going
// while you move around the map and the list, and only one thing plays at a
// time, by construction.
//
// Nothing here starts on its own: play() is only called from a click.
//
// Looping uses the audio element's own `loop`. It is simple and streams from
// the server, but the browser may leave a small gap at the seam, and Opus
// itself adds a little padding; see docs/design/IMPLEMENTATION_NOTES.md.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useToast } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import { audioUrl, type Recording } from "../../lib/api";

export type SleepOption = 15 | 30 | 60 | null;

const FADE_MS = 3000;
const FADE_STEPS = 30;

interface PlayerValue {
  current: Recording | null;
  playing: boolean;
  time: number;
  duration: number;
  loop: boolean;
  volume: number;
  sleepMinutes: SleepOption;
  /** Milliseconds until the sound stops, or null when no timer is running. */
  sleepRemaining: number | null;
  error: boolean;
  play: (recording: Recording) => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  setLoop: (on: boolean) => void;
  setVolume: (value: number) => void;
  setSleep: (minutes: SleepOption) => void;
  close: () => void;
  pause: () => void;
}

const PlayerContext = createContext<PlayerValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const toast = useToast();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<Recording | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loop, setLoopState] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [sleepMinutes, setSleepMinutes] = useState<SleepOption>(null);
  const [sleepDeadline, setSleepDeadline] = useState<number | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const fading = useRef<number | undefined>(undefined);
  const userVolume = useRef(1);

  const stopFade = useCallback(() => {
    if (fading.current !== undefined) {
      window.clearInterval(fading.current);
      fading.current = undefined;
    }
    if (audioRef.current) audioRef.current.volume = userVolume.current;
  }, []);

  const play = useCallback(
    (recording: Recording) => {
      const audio = audioRef.current;
      if (!audio) return;
      stopFade();
      setError(false);
      if (current?.id !== recording.id) {
        audio.src = audioUrl(recording.id);
        audio.load();
        setCurrent(recording);
        setTime(0);
        setDuration(recording.duration_seconds ?? 0);
      }
      void audio.play().catch(() => setPlaying(false));
    },
    [current, stopFade],
  );

  const pause = useCallback(() => audioRef.current?.pause(), []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }, [current]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setTime(seconds);
  }, []);

  const setLoop = useCallback((on: boolean) => {
    setLoopState(on);
    if (audioRef.current) audioRef.current.loop = on;
  }, []);

  const setVolume = useCallback((value: number) => {
    userVolume.current = value;
    setVolumeState(value);
    if (audioRef.current) audioRef.current.volume = value;
  }, []);

  const setSleep = useCallback((minutes: SleepOption) => {
    setSleepMinutes(minutes);
    setSleepDeadline(minutes === null ? null : Date.now() + minutes * 60_000);
    setSleepRemaining(minutes === null ? null : minutes * 60_000);
  }, []);

  const close = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    stopFade();
    setCurrent(null);
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setSleepMinutes(null);
    setSleepDeadline(null);
    setSleepRemaining(null);
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) navigator.mediaSession.metadata = null;
  }, [stopFade]);

  // The sleep timer: a clock tick, then a short fade when it reaches zero.
  useEffect(() => {
    if (sleepDeadline === null) return;
    const tick = window.setInterval(() => {
      const left = sleepDeadline - Date.now();
      if (left > 0) {
        setSleepRemaining(left);
        return;
      }
      window.clearInterval(tick);
      setSleepDeadline(null);
      setSleepRemaining(null);
      setSleepMinutes(null);
      const audio = audioRef.current;
      if (!audio) return;
      const start = audio.volume;
      let step = 0;
      fading.current = window.setInterval(() => {
        step += 1;
        audio.volume = Math.max(0, start * (1 - step / FADE_STEPS));
        if (step >= FADE_STEPS) {
          window.clearInterval(fading.current);
          fading.current = undefined;
          audio.pause();
          audio.volume = userVolume.current;
          toast(t("player.sleepDone"));
        }
      }, FADE_MS / FADE_STEPS);
    }, 500);
    return () => window.clearInterval(tick);
  }, [sleepDeadline, t, toast]);

  // Media Session: the lock screen and the keyboard's media keys.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.place_name ?? "",
      album: t("app.title"),
    });
    navigator.mediaSession.setActionHandler("play", () => void audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("stop", close);
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime !== undefined && audioRef.current) audioRef.current.currentTime = details.seekTime;
    });
  }, [current, t, close]);

  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = current ? (playing ? "playing" : "paused") : "none";
  }, [playing, current]);

  const value = useMemo<PlayerValue>(
    () => ({
      current,
      playing,
      time,
      duration,
      loop,
      volume,
      sleepMinutes,
      sleepRemaining,
      error,
      play,
      toggle,
      seek,
      setLoop,
      setVolume,
      setSleep,
      close,
      pause,
    }),
    [current, playing, time, duration, loop, volume, sleepMinutes, sleepRemaining, error, play, toggle, seek, setLoop, setVolume, setSleep, close, pause],
  );

  return (
    <PlayerContext.Provider value={value}>
      {children}
      {/* preload none: nothing is fetched until someone presses play. */}
      <audio
        ref={audioRef}
        preload="none"
        data-testid="global-audio"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => {
          const d = event.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onError={() => {
          if (audioRef.current?.getAttribute("src")) setError(true);
        }}
      />
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return value;
}
