import { _setEnvBakeHooks } from '../../SkyBox/SkyEnvironment';
import {
  _acquireGpuTimer,
  _getGpuTimerSupport,
  _onRenderContext,
  _onTimestampsResolved,
  _releaseGpuTimer,
  _requestTimestampResolve,
  _sumGpuMs,
} from '../_dbg__GPUTimer';

/**
 * Env bake stats (debug only): a bake counter, and the CPU (performance.now) and GPU (the sum
 * of the bake's render pass timestamps) ms of each bake. The GPU timer is held only from a
 * bake's start until its timestamps are read (or a timeout), so nothing is tracked between
 * bakes. GPU times are WebGPU only: on WebGL the bake's nested passes never resolve (see
 * _getGpuTimerSupport).
 */

/** Smoothing factor of the exponential moving averages (~30 bake window). */
const EMA_ALPHA = 2 / 31;
/** Resolves a bake waits for its GPU timestamps before it is dropped. */
const MAX_PENDING_RESOLVES = 8;
/** A bake whose timestamps haven't come back by then is dropped, and the timer released. */
const PENDING_TIMEOUT_MS = 2000;

type Avg = { last: number; avg: number; hasValue: boolean };

const cpu: Avg = { last: 0, avg: 0, hasValue: false };
const gpu: Avg = { last: 0, avg: 0, hasValue: false };
let bakeCount = 0;
/** Null until the first bake has checked for it. */
let gpuAvailable: boolean | null = null;
let isHoldingTimer = false;
let captureUids: string[] | null = null;
let pending: { uids: string[]; age: number }[] = [];
let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
let removeListeners: (() => void) | null = null;

/** The window bakes per second are averaged over. */
const RATE_WINDOW_MS = 10000;
/** When each bake in the window ran (performance.now). */
let bakeTimes: number[] = [];

const getBakesPerSec = () => {
  const since = performance.now() - RATE_WINDOW_MS;
  bakeTimes = bakeTimes.filter((time) => time >= since);
  return (bakeTimes.length / (RATE_WINDOW_MS / 1000)).toFixed(2);
};

/** What the Environment folder's read-only bindings poll. */
export const envBakeStatsView = {
  bakes: 0,
  cpuMs: '-',
  gpuMs: '-',
  /** Over the last 10 s (read on every poll, so it falls back to 0 once bakes stop). */
  get bakesPerSec() {
    return getBakesPerSec();
  },
};

const addSample = (avg: Avg, value: number) => {
  avg.last = value;
  avg.avg = avg.hasValue ? avg.avg + (value - avg.avg) * EMA_ALPHA : value;
  avg.hasValue = true;
};

const formatAvg = (avg: Avg) =>
  avg.hasValue ? `${avg.last.toFixed(3)} (avg ${avg.avg.toFixed(3)})` : '-';

const updateView = () => {
  envBakeStatsView.bakes = bakeCount;
  envBakeStatsView.cpuMs = formatAvg(cpu);
  envBakeStatsView.gpuMs = gpuAvailable === false ? 'n/a (WebGPU only)' : formatAvg(gpu);
};

const holdTimer = () => {
  if (isHoldingTimer) return true;
  gpuAvailable = _getGpuTimerSupport() === 'WEBGPU';
  if (!gpuAvailable || !_acquireGpuTimer()) return false;
  isHoldingTimer = true;
  const removeRender = _onRenderContext((uid) => captureUids?.push(uid));
  const removeResolved = _onTimestampsResolved(onTimestampsResolved);
  removeListeners = () => {
    removeRender();
    removeResolved();
  };
  return true;
};

const releaseTimer = () => {
  if (pendingTimeout) clearTimeout(pendingTimeout);
  pendingTimeout = null;
  if (!isHoldingTimer) return;
  isHoldingTimer = false;
  removeListeners?.();
  removeListeners = null;
  _releaseGpuTimer();
};

const dropPending = () => {
  pending = [];
  releaseTimer();
};

function onTimestampsResolved(timestamps: ReadonlyMap<string, number>) {
  pending = pending.filter((record) => {
    const ms = _sumGpuMs(timestamps, record.uids);
    if (ms !== null) {
      addSample(gpu, ms);
      return false;
    }
    return ++record.age < MAX_PENDING_RESOLVES;
  });
  updateView();
  // Another resolve (eg. stats-gl's) can have taken the batch: try again until it ages out
  if (pending.length) _requestTimestampResolve();
  else if (!captureUids) releaseTimer();
}

_setEnvBakeHooks({
  onBakeStart: () => {
    if (gpuAvailable !== false && holdTimer()) captureUids = [];
  },
  onBakeEnd: (cpuMs) => {
    bakeCount++;
    bakeTimes.push(performance.now());
    addSample(cpu, cpuMs);
    if (captureUids) {
      if (captureUids.length) pending.push({ uids: captureUids, age: 0 });
      captureUids = null;
      if (pending.length) {
        _requestTimestampResolve();
        if (pendingTimeout) clearTimeout(pendingTimeout);
        pendingTimeout = setTimeout(dropPending, PENDING_TIMEOUT_MS);
      } else {
        releaseTimer();
      }
    }
    updateView();
  },
});
