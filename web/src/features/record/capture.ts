// Recording with the browser's microphone.
//
// Echo cancellation, noise suppression and automatic gain are turned OFF: they
// are made for phone calls and would change the sound of the place. A browser
// may ignore the request, so we read back what it really did (getSettings) and
// show that on the recording.
//
//   compressed  MediaRecorder with Opus (or the best the browser has).
//   lossless    AudioWorklet to 24-bit PCM WAV. Limited in time, because it
//               all stays on the device until it is sent.

export type Quality = "lossless" | "compressed";

export const LOSSLESS_MAX_SECONDS = 30 * 60;
const BLOCK_BYTES = 1024 * 1024;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
];

export function bestMimeType(isSupported: (type: string) => boolean = (t) => MediaRecorder.isTypeSupported(t)): string | null {
  return MIME_CANDIDATES.find(isSupported) ?? null;
}

export function microphoneAvailable(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === "function";
}

export function requestMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
    },
  });
}

export function appliedSettings(stream: MediaStream): Record<string, unknown> {
  const settings = stream.getAudioTracks()[0]?.getSettings() ?? {};
  return {
    echoCancellation: settings.echoCancellation ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
    autoGainControl: settings.autoGainControl ?? null,
    sampleRate: settings.sampleRate ?? null,
    channelCount: settings.channelCount ?? null,
  };
}

/** Any of the three processing options the browser could not turn off. */
export function processingStillOn(settings: Record<string, unknown>): string[] {
  return ["echoCancellation", "noiseSuppression", "autoGainControl"].filter((key) => settings[key] === true);
}

export function wavHeader(sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  const blockAlign = (channels * bitsPerSample) / 8;
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/** Interleaved 24-bit little-endian samples from 32-bit floats. */
export function interleave24(channels: Float32Array[], target: Uint8Array, offset: number): number {
  const frames = channels[0]?.length ?? 0;
  let position = offset;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const clamped = Math.max(-1, Math.min(1, channel[frame]));
      const value = Math.round(clamped < 0 ? clamped * 8388608 : clamped * 8388607);
      target[position++] = value & 0xff;
      target[position++] = (value >> 8) & 0xff;
      target[position++] = (value >> 16) & 0xff;
    }
  }
  return position;
}

export interface Captured {
  blob: Blob;
  filename: string;
  settings: Record<string, unknown>;
  seconds: number;
}

export class Recorder {
  private readonly stream: MediaStream;
  private readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly source: MediaStreamAudioSourceNode;
  private worklet: AudioWorkletNode | null = null;
  private recorder: MediaRecorder | null = null;
  private blobParts: BlobPart[] = [];
  private pending = new Uint8Array(BLOCK_BYTES);
  private pendingFill = 0;
  private dataBytes = 0;
  private channels = 1;
  private quality: Quality = "compressed";
  private startedAt = 0;
  private readonly samples: Float32Array<ArrayBuffer>;

  constructor(stream: MediaStream) {
    this.stream = stream;
    this.context = new AudioContext();
    this.source = this.context.createMediaStreamSource(stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
  }

  /** The peak level right now, from 0 to 1. Only for the meter on screen. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.samples);
    let peak = 0;
    for (const sample of this.samples) peak = Math.max(peak, Math.abs(sample));
    return peak;
  }

  async start(quality: Quality): Promise<void> {
    this.quality = quality;
    await this.context.resume();
    this.startedAt = performance.now();
    if (quality === "compressed") {
      const mimeType = bestMimeType();
      if (!mimeType) throw new Error("no-recorder-format");
      this.recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 256_000 });
      this.recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.blobParts.push(event.data);
      };
      this.recorder.start(1000);
      return;
    }
    await this.context.audioWorklet.addModule("/pcm-capture-worklet.js");
    this.channels = Math.max(1, Math.min(2, (this.stream.getAudioTracks()[0]?.getSettings().channelCount as number) || 1));
    this.worklet = new AudioWorkletNode(this.context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: this.channels,
      channelCountMode: "explicit",
    });
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array[]>) => this.addFrames(event.data);
    this.source.connect(this.worklet);
    // Silent, but a node with no route to the output is not run by browsers.
    const silence = this.context.createGain();
    silence.gain.value = 0;
    this.worklet.connect(silence).connect(this.context.destination);
  }

  private addFrames(channels: Float32Array[]): void {
    const frames = channels[0]?.length ?? 0;
    const needed = frames * this.channels * 3;
    if (this.pendingFill + needed > this.pending.length) this.flush();
    // A browser may hand us fewer channels than agreed: repeat the first.
    const filled = Array.from({ length: this.channels }, (_, index) => channels[index] ?? channels[0]);
    this.pendingFill = interleave24(filled, this.pending, this.pendingFill);
    this.dataBytes += needed;
  }

  private flush(): void {
    if (this.pendingFill === 0) return;
    // Handing each block to a Blob lets the browser keep it out of the page's memory.
    this.blobParts.push(new Blob([this.pending.slice(0, this.pendingFill)]));
    this.pendingFill = 0;
  }

  async stop(): Promise<Captured> {
    const seconds = (performance.now() - this.startedAt) / 1000;
    let blob: Blob;
    let filename: string;
    let format: string;
    if (this.recorder) {
      const recorder = this.recorder;
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        recorder.stop();
      });
      format = recorder.mimeType;
      blob = new Blob(this.blobParts, { type: recorder.mimeType });
      filename = recorder.mimeType.includes("ogg") ? "recording.ogg" : recorder.mimeType.includes("mp4") ? "recording.m4a" : "recording.webm";
    } else {
      this.worklet?.port.postMessage("stop");
      this.worklet?.disconnect();
      // Samples already in flight to the page.
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      this.flush();
      const header = wavHeader(this.context.sampleRate, this.channels, 24, this.dataBytes);
      format = "audio/wav";
      blob = new Blob([header, ...this.blobParts], { type: "audio/wav" });
      filename = "recording.wav";
    }
    const settings = { ...appliedSettings(this.stream), format, quality: this.quality };
    this.release();
    return { blob, filename, settings, seconds };
  }

  release(): void {
    this.stream.getTracks().forEach((track) => track.stop());
    void this.context.close();
  }
}
