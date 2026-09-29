/** What an interval window publishes: the per-frame min and max, or the per-frame average. */
export type IntervalWindowKind = 'MIN_MAX' | 'AVERAGE';

/** One rolling interval of an {@link IntervalCounterStats}. */
export type IntervalWindowConfig = {
  id: string;
  intervalMs: number;
  kind: IntervalWindowKind;
};

/** The published values of one interval window. */
export type IntervalWindowSnapshot = {
  id: string;
  intervalMs: number;
  kind: IntervalWindowKind;
  /** Smallest per-frame count of the last finished interval (MIN_MAX windows, otherwise 0) */
  min: number;
  /** Largest per-frame count of the last finished interval (MIN_MAX windows, otherwise 0) */
  max: number;
  /** Average per-frame count of the last finished interval (AVERAGE windows, otherwise 0) */
  average: number;
  /** How far the current interval is, 0..1 */
  progress: number;
};

/** The published values of an {@link IntervalCounterStats}. */
export type IntervalCounterSnapshot = {
  /** Count accumulated so far in the current frame */
  current: number;
  /** Count of the last finished frame */
  lastFrame: number;
  /** Largest per-frame count since the last reset */
  maxEver: number;
  windows: readonly IntervalWindowSnapshot[];
};

type WindowAccumulator = {
  startMs: number;
  min: number;
  max: number;
  total: number;
  frames: number;
};

/**
 * A per-frame counter with rolling interval windows (per-frame min/max or average), eg. rays cast
 * per frame. `add` is one integer add, `endFrame` is O(windows), and nothing is allocated after
 * construction.
 *
 * A frame is whatever the owner calls `endFrame` for (usually once per rendered frame). Counts
 * added between two `endFrame` calls belong to one frame.
 */
export class IntervalCounterStats {
  private readonly snap: IntervalCounterSnapshot;
  private readonly windowSnaps: IntervalWindowSnapshot[];
  private readonly acc: WindowAccumulator[];

  constructor(windows: readonly IntervalWindowConfig[]) {
    this.windowSnaps = windows.map(({ id, intervalMs, kind }) => ({
      id,
      intervalMs,
      kind,
      min: 0,
      max: 0,
      average: 0,
      progress: 0,
    }));
    this.acc = windows.map(() => ({ startMs: 0, min: Infinity, max: 0, total: 0, frames: 0 }));
    this.snap = { current: 0, lastFrame: 0, maxEver: 0, windows: this.windowSnaps };
    this.reset(0);
  }

  /** Adds to the current frame's count. */
  add(n: number = 1) {
    this.snap.current += n;
  }

  /**
   * Finishes the current frame: records its count into every window and publishes the windows
   * whose interval has elapsed.
   * @param nowMs (number) the frame time, eg. `performance.now()`
   */
  endFrame(nowMs: number) {
    const snap = this.snap;
    const count = snap.current;
    snap.current = 0;
    snap.lastFrame = count;
    if (count > snap.maxEver) snap.maxEver = count;

    for (let i = 0; i < this.acc.length; i++) {
      const acc = this.acc[i];
      const win = this.windowSnaps[i];
      if (count < acc.min) acc.min = count;
      if (count > acc.max) acc.max = count;
      acc.total += count;
      acc.frames++;

      const elapsed = nowMs - acc.startMs;
      if (elapsed < win.intervalMs) {
        win.progress = elapsed > 0 ? elapsed / win.intervalMs : 0;
        continue;
      }
      if (win.kind === 'MIN_MAX') {
        win.min = acc.min;
        win.max = acc.max;
      } else {
        win.average = acc.total / acc.frames;
      }
      win.progress = 0;
      this.resetAccumulator(acc, nowMs);
    }
  }

  /**
   * Clears every count and published value, and restarts the intervals.
   * @param nowMs (number) optional start time of the new intervals, default `performance.now()`
   */
  reset(nowMs: number = performance.now()) {
    const snap = this.snap;
    snap.current = 0;
    snap.lastFrame = 0;
    snap.maxEver = 0;
    for (let i = 0; i < this.acc.length; i++) {
      const win = this.windowSnaps[i];
      win.min = 0;
      win.max = 0;
      win.average = 0;
      win.progress = 0;
      this.resetAccumulator(this.acc[i], nowMs);
    }
  }

  /**
   * The published values. It is the same object on every call (it is updated in place), so
   * polling it allocates nothing. Copy the values out to keep them.
   */
  snapshot(): Readonly<IntervalCounterSnapshot> {
    return this.snap;
  }

  private resetAccumulator(acc: WindowAccumulator, nowMs: number) {
    acc.startMs = nowMs;
    acc.min = Infinity;
    acc.max = 0;
    acc.total = 0;
    acc.frames = 0;
  }
}
