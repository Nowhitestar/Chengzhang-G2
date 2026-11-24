/**
 * Recording. The glasses hand over raw microphone audio (16 kHz, 16-bit, mono)
 * in small frames. This file:
 *
 *  - measures how loud each frame is, for the ink marks on screen;
 *  - cuts the stream into slices of about 15 seconds, at a pause when there is
 *    one, and uploads each slice as soon as it is cut, so most of the talking
 *    is already transcribed when the author taps "done";
 *  - retries uploads, and keeps every slice in memory until it is safely sent.
 */
const BYTES_PER_MS = 32; // 16 000 samples a second, two bytes each
const SLICE_MIN_MS = 15_000;
const SLICE_MAX_MS = 25_000;
/** A pause this long (while past the minimum) is a good place to cut. */
const PAUSE_MS = 300;
/** Above this level a frame counts as speech rather than room noise (about -43 dB). */
export const VOICE_LEVEL = 0.3;

/** Loudness of a frame on a 0..1 scale that follows how loud it sounds (decibels), not raw amplitude. */
export function frameLevel(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length - (pcm.length % 2));
  const n = view.byteLength / 2;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < view.byteLength; i += 2) {
    const s = view.getInt16(i, true) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  if (rms <= 0) return 0;
  // -55 dB (a quiet room) → 0, -15 dB (loud speech) → 1
  return Math.min(1, Math.max(0, (20 * Math.log10(rms) + 55) / 40));
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface RecorderHooks {
  /** Send one slice. Must reject when it could not be sent. */
  upload: (idx: number, pcm: Uint8Array) => Promise<void>;
}

export class Recorder {
  private frames: Uint8Array[] = [];
  private frameBytes = 0;
  private totalBytes = 0;
  private quietMs = 0;
  private slices = 0;
  /** Slices that have not arrived yet. They stay here until the backend has them. */
  private unsent = new Map<number, Uint8Array>();
  private uploads = new Set<Promise<void>>();
  private stopped = false;
  /** Levels of the frames since the last call to takeLevel(). */
  private levelSum = 0;
  private levelCount = 0;
  /** True once anything louder than room noise was heard. */
  heard = false;

  constructor(private readonly hooks: RecorderHooks) {}

  /** Feed one microphone frame. */
  push(pcm: Uint8Array): void {
    if (this.stopped || !pcm.length) return;
    // Copy: the SDK may reuse the buffer behind the frame.
    const frame = pcm.slice();
    this.frames.push(frame);
    this.frameBytes += frame.length;
    this.totalBytes += frame.length;
    const level = frameLevel(frame);
    this.levelSum += level;
    this.levelCount++;
    if (level >= VOICE_LEVEL) {
      this.heard = true;
      this.quietMs = 0;
    } else {
      this.quietMs += frame.length / BYTES_PER_MS;
    }
    const sliceMs = this.frameBytes / BYTES_PER_MS;
    if (sliceMs >= SLICE_MAX_MS || (sliceMs >= SLICE_MIN_MS && this.quietMs >= PAUSE_MS)) this.cut();
  }

  private cut(): void {
    if (!this.frameBytes) return;
    const idx = this.slices++;
    this.unsent.set(idx, concat(this.frames, this.frameBytes));
    this.frames = [];
    this.frameBytes = 0;
    this.track(idx);
  }

  private track(idx: number): void {
    const job = this.send(idx).finally(() => this.uploads.delete(job));
    this.uploads.add(job);
  }

  private async send(idx: number): Promise<void> {
    const pcm = this.unsent.get(idx);
    if (!pcm) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.hooks.upload(idx, pcm);
        this.unsent.delete(idx);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }

  /** Average level since the last call, 0..1. Used to draw the ink marks. */
  takeLevel(): number {
    const level = this.levelCount ? this.levelSum / this.levelCount : 0;
    this.levelSum = 0;
    this.levelCount = 0;
    return level;
  }

  /** How much audio has arrived so far. */
  get elapsedMs(): number {
    return this.totalBytes / BYTES_PER_MS;
  }

  /**
   * Stop, send what is left, and wait for every slice to arrive. Rejects when
   * some could not be sent; calling it again tries those slices once more.
   */
  async finish(): Promise<{ slices: number; durationMs: number }> {
    this.cut();
    this.stopped = true;
    await Promise.all(this.uploads);
    if (this.unsent.size) {
      for (const idx of this.unsent.keys()) this.track(idx);
      await Promise.all(this.uploads);
    }
    if (this.unsent.size) throw new Error("upload failed");
    return { slices: this.slices, durationMs: Math.round(this.elapsedMs) };
  }

  /** Stop and forget everything. */
  cancel(): void {
    this.stopped = true;
    this.frames = [];
    this.frameBytes = 0;
    this.unsent.clear();
  }
}

/**
 * A pretend microphone, switched on with ?mic=demo in the address. It makes
 * speech-shaped noise (bursts of sound with pauses) so the app can be shown,
 * and tested end to end, on a machine with no microphone. Used together with
 * the backend's demo mode, where the words come from a canned script anyway.
 */
export class DemoMic {
  private timer: number | null = null;

  start(onFrame: (pcm: Uint8Array) => void): void {
    let n = 0;
    this.timer = window.setInterval(() => {
      // 100 ms frames. A "sentence" of about 2.5 s, then a short breath; syllables rise and fall inside it.
      const t = n++ / 10;
      const speaking = t % 3.2 < 2.5;
      const syllable = 0.35 + 0.65 * Math.abs(Math.sin(t * 5.1)) * (0.6 + 0.4 * Math.sin(t * 1.3) ** 2);
      const amplitude = speaking ? 5200 * syllable : 12;
      const frame = new Uint8Array(3200);
      const view = new DataView(frame.buffer);
      for (let i = 0; i < 1600; i++) view.setInt16(i * 2, Math.round((Math.random() * 2 - 1) * amplitude), true);
      onFrame(frame);
    }, 100);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}
