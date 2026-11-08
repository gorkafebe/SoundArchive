// How technical facts read on screen.
import type { Recording } from "../../lib/api";

/** 161 -> "2:41"; 3725 -> "1:02:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "–:––";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The line under a recording's title: "48 kHz · 24 bit · estéreo". */
export function formatTech(
  recording: Pick<Recording, "sample_rate" | "bit_depth" | "channels">,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (recording.sample_rate) parts.push(`${(recording.sample_rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`);
  if (recording.bit_depth) parts.push(`${recording.bit_depth} bit`);
  if (recording.channels) parts.push(t(recording.channels === 1 ? "tech.mono" : recording.channels === 2 ? "tech.stereo" : "tech.multichannel", { count: recording.channels }));
  return parts.join(" · ");
}

export function formatLufs(lufs: number | null | undefined): string {
  return lufs === null || lufs === undefined ? "–" : `${lufs.toFixed(1).replace("-", "−")} LUFS`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
