import { describe, expect, it } from "vitest";

import { formatBytes, formatDuration, formatLufs, formatTech } from "../player/format";
import { resamplePeaks } from "../player/components";
import { bestMimeType, interleave24, processingStillOn, wavHeader } from "./capture";
import { backoffMs } from "../../lib/upload";

describe("wavHeader", () => {
  it("describes the audio correctly", () => {
    const view = new DataView(wavHeader(48000, 2, 24, 6000));
    const text = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(36 + 6000);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(48000 * 6);
    expect(view.getUint16(32, true)).toBe(6);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(6000);
  });
});

describe("interleave24", () => {
  it("writes little-endian samples, channel after channel", () => {
    const target = new Uint8Array(12);
    const end = interleave24([new Float32Array([1, -1]), new Float32Array([0, 0.5])], target, 0);
    expect(end).toBe(12);
    expect([...target.slice(0, 3)]).toEqual([0xff, 0xff, 0x7f]); // full scale
    expect([...target.slice(3, 6)]).toEqual([0, 0, 0]);
    expect([...target.slice(6, 9)]).toEqual([0x00, 0x00, 0x80]); // minus full scale
  });

  it("clips what is out of range instead of wrapping around", () => {
    const target = new Uint8Array(3);
    interleave24([new Float32Array([2])], target, 0);
    expect([...target]).toEqual([0xff, 0xff, 0x7f]);
  });
});

describe("bestMimeType", () => {
  it("prefers Opus", () => {
    expect(bestMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });
  it("takes what the browser has", () => {
    expect(bestMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });
  it("says so when there is nothing", () => {
    expect(bestMimeType(() => false)).toBeNull();
  });
});

describe("processingStillOn", () => {
  it("lists only what the browser reports as active", () => {
    expect(processingStillOn({ echoCancellation: false, noiseSuppression: true, autoGainControl: null })).toEqual(["noiseSuppression"]);
  });
});

describe("formatters", () => {
  it("formats durations", () => {
    expect(formatDuration(161)).toBe("2:41");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(null)).toBe("–:––");
  });
  it("uses a real minus sign in loudness", () => {
    expect(formatLufs(-23)).toBe("−23.0 LUFS");
    expect(formatLufs(null)).toBe("–");
  });
  it("formats sizes", () => {
    expect(formatBytes(412 * 1024 * 1024)).toBe("412 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.00 GB");
  });
  it("describes the format", () => {
    const t = (key: string) => key;
    expect(formatTech({ sample_rate: 48000, bit_depth: 24, channels: 2 }, t)).toBe("48 kHz · 24 bit · tech.stereo");
    expect(formatTech({ sample_rate: 48000, bit_depth: null, channels: 1 }, t)).toBe("48 kHz · tech.mono");
  });
});

describe("resamplePeaks", () => {
  it("keeps the highest value of each slice", () => {
    expect(resamplePeaks([0.1, 0.9, 0.2, 0.3], 2)).toEqual([0.9, 0.3]);
  });
  it("handles having no data", () => {
    expect(resamplePeaks([], 3)).toEqual([0, 0, 0]);
  });
  it("stretches when there are fewer peaks than bars", () => {
    expect(resamplePeaks([0.5], 2)).toHaveLength(2);
  });
});

describe("upload backoff", () => {
  it("doubles and has a ceiling", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(20)).toBe(30000);
  });
});
