/** Average and worst value of one channel over the summarized window. */
export type WindowStat = { avg: number; max: number };

/**
 * Timed samples of up to four channels in a preallocated ring (no allocation per sample),
 * summarized over the last `windowMs` at the profiler's update rate. Samples must be pushed in
 * time order.
 */
export class SampleWindow {
  private readonly channels: number;
  private readonly capacity: number;
  private readonly times: Float64Array;
  private readonly values: Float64Array;
  private head = 0;
  private count = 0;
  /** Samples in the window at the last summarize. */
  samples = 0;
  readonly stats: WindowStat[];

  /**
   * @param channels (number) values per sample, 1-4
   * @param capacity (number) samples kept (about 4 s of frames at 240 Hz by default)
   */
  constructor(channels: number, capacity = 1024) {
    this.channels = channels;
    this.capacity = capacity;
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity * channels);
    this.stats = Array.from({ length: channels }, () => ({ avg: 0, max: 0 }));
  }

  push(time: number, v0: number, v1 = 0, v2 = 0, v3 = 0) {
    const base = this.head * this.channels;
    this.times[this.head] = time;
    this.values[base] = v0;
    if (this.channels > 1) this.values[base + 1] = v1;
    if (this.channels > 2) this.values[base + 2] = v2;
    if (this.channels > 3) this.values[base + 3] = v3;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  reset() {
    this.head = 0;
    this.count = 0;
    this.samples = 0;
    for (let c = 0; c < this.channels; c++) {
      this.stats[c].avg = 0;
      this.stats[c].max = 0;
    }
  }

  /**
   * Summarizes the samples of the last `windowMs` into {@link samples} and {@link stats}.
   * @returns the sample count in the window
   */
  summarize(windowMs: number, now = performance.now()) {
    const { channels, stats } = this;
    for (let c = 0; c < channels; c++) {
      stats[c].avg = 0;
      stats[c].max = 0;
    }
    let samples = 0;
    for (let i = 0; i < this.count; i++) {
      const index = (this.head - 1 - i + this.capacity) % this.capacity;
      if (now - this.times[index] > windowMs) break;
      samples++;
      const base = index * channels;
      for (let c = 0; c < channels; c++) {
        const value = this.values[base + c];
        stats[c].avg += value;
        if (value > stats[c].max) stats[c].max = value;
      }
    }
    if (samples) {
      for (let c = 0; c < channels; c++) stats[c].avg /= samples;
    }
    this.samples = samples;
    return samples;
  }
}
