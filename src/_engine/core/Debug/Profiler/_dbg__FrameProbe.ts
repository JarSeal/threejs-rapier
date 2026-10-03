import { setFrameProbe, type FrameProbe } from '../../MainLoop';

/** Rendered frames kept (about 4 s at 240 Hz), enough for one summary window at any rate. */
const CAPACITY = 1024;
/** The summary covers the frames that ended in the last WINDOW_MS. */
const WINDOW_MS = 1000;

const endTimes = new Float64Array(CAPACITY);
/** Time between this rendered frame's begin and the previous one's (NaN when unknown). */
const intervals = new Float64Array(CAPACITY);
/** Main loop CPU time of the rendered frame, plus the limiter-skipped frames before it. */
const cpuTimes = new Float64Array(CAPACITY);
let head = 0;
let count = 0;

let beginTime = 0;
let lastRenderedBegin = -1;
let pendingCpu = 0;

const reset = () => {
  head = 0;
  count = 0;
  lastRenderedBegin = -1;
  pendingCpu = 0;
};

const probe: FrameProbe = {
  begin: (now) => {
    beginTime = now;
  },
  end: (now, rendered) => {
    pendingCpu += now - beginTime;
    if (!rendered) return;
    // A gap longer than the window (a paused main loop, a hidden tab) is not a frame
    const interval = lastRenderedBegin < 0 ? NaN : beginTime - lastRenderedBegin;
    lastRenderedBegin = beginTime;
    endTimes[head] = now;
    intervals[head] = interval > WINDOW_MS ? NaN : interval;
    cpuTimes[head] = pendingCpu;
    pendingCpu = 0;
    head = (head + 1) % CAPACITY;
    if (count < CAPACITY) count++;
  },
};

export type FrameProbeSummary = {
  /** Rendered frames in the window (0 = no data, eg. a paused main loop). */
  frames: number;
  /** Rendered frames per second. */
  fps: number;
  frameTimeAvgMs: number;
  /** The worst frame in the window: hitches show up here, not in the average. */
  frameTimeMaxMs: number;
  /** Main loop CPU time per rendered frame (begin to end, the span TFPS uses). */
  cpuAvgMs: number;
  cpuMaxMs: number;
};

const summary: FrameProbeSummary = {
  frames: 0,
  fps: 0,
  frameTimeAvgMs: 0,
  frameTimeMaxMs: 0,
  cpuAvgMs: 0,
  cpuMaxMs: 0,
};

/**
 * Summarizes the rendered frames that ended in the last second. Called at the profiler's update
 * rate, never per frame.
 * @returns the same {@link FrameProbeSummary} object on every call (read it before the next call)
 */
export const _getFrameProbeSummary = (now = performance.now()) => {
  let frames = 0;
  let intervalCount = 0;
  let intervalSum = 0;
  let intervalMax = 0;
  let cpuSum = 0;
  let cpuMax = 0;
  for (let i = 0; i < count; i++) {
    const index = (head - 1 - i + CAPACITY) % CAPACITY;
    if (now - endTimes[index] > WINDOW_MS) break;
    frames++;
    const cpu = cpuTimes[index];
    cpuSum += cpu;
    if (cpu > cpuMax) cpuMax = cpu;
    const interval = intervals[index];
    if (Number.isNaN(interval)) continue;
    intervalCount++;
    intervalSum += interval;
    if (interval > intervalMax) intervalMax = interval;
  }
  summary.frames = frames;
  summary.fps = intervalSum > 0 ? (intervalCount * 1000) / intervalSum : 0;
  summary.frameTimeAvgMs = intervalCount ? intervalSum / intervalCount : 0;
  summary.frameTimeMaxMs = intervalMax;
  summary.cpuAvgMs = frames ? cpuSum / frames : 0;
  summary.cpuMaxMs = cpuMax;
  return summary;
};

let holders = 0;

/** Sets the frame probe on the main loop (the first holder starts from an empty history). */
export const _acquireFrameProbe = () => {
  holders++;
  if (holders > 1) return;
  reset();
  setFrameProbe(probe);
};

/** Clears the frame probe from the main loop when the last holder releases it. */
export const _releaseFrameProbe = () => {
  if (holders === 0) return;
  holders--;
  if (holders === 0) setFrameProbe(null);
};

export const _isFrameProbeSet = () => holders > 0;
