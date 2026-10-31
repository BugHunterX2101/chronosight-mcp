// Microphone samples to the wire format the relay expects (DESIGN §15.2): 24 kHz, signed 16-bit
// little-endian, mono, in 80 ms frames of 3,840 bytes. Pure, so it is unit-tested without a browser.

export const SAMPLE_RATE = 24_000;
export const FRAME_SAMPLES = 1920; // 80 ms at 24 kHz
export const FRAME_BYTES = FRAME_SAMPLES * 2;

/** Float samples in [-1, 1] to little-endian 16-bit PCM bytes; out-of-range samples clip. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(samples.length * 2);
  const view = new DataView(out);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}

/** Collects audio blocks of any size and yields complete 80 ms frames. */
export class FrameChunker {
  private pending = new Float32Array(0);

  push(block: Float32Array): ArrayBuffer[] {
    const joined = new Float32Array(this.pending.length + block.length);
    joined.set(this.pending);
    joined.set(block, this.pending.length);
    const frames: ArrayBuffer[] = [];
    let at = 0;
    while (joined.length - at >= FRAME_SAMPLES) {
      frames.push(floatToPcm16(joined.subarray(at, at + FRAME_SAMPLES)));
      at += FRAME_SAMPLES;
    }
    this.pending = joined.slice(at);
    return frames;
  }

  /** Samples held back waiting for the rest of a frame. */
  get buffered(): number {
    return this.pending.length;
  }
}

/** One 80 ms frame of digital silence, sent while the browser is speaking so the stream keeps its pace. */
export const silentFrame = (): ArrayBuffer => new ArrayBuffer(FRAME_BYTES);
