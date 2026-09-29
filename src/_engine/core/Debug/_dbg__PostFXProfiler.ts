/**
 * PostFX per-pass performance measuring (docs/plans/_DONE_p070_post-fx-system.md, Design decision 8).
 * Debug-only, lazily loaded through debug/PostFXProfiler.ts, and switchable live (no reload).
 * While off nothing is installed: no inspector, no wrappers, no timing calls.
 *
 * - CPU: each PostFX pass's profileNodes' updateBefore() is wrapped with performance.now().
 * - GPU: through the shared GPU timer (_dbg__GPUTimer.ts). Every render context opened while a
 *   PostFX pass's updateBefore() is running is attributed to that PostFX pass (including nested
 *   ones, eg. the depth/normal pre-pass is attributed to the first PostFX pass that renders it).
 *   After the frame, the render timestamps are resolved and each context's GPU duration is read
 *   from the resolved batch.
 * - Render contexts opened outside any PostFX pass are the final composite quad (the first
 *   context of the pipeline render) and the scene pass. Pure in-chain PostFX passes are
 *   evaluated inside the composite, so they are reported as gpuAttribution 'shared'.
 */
import type { Node, NodeFrame, RenderPipeline } from 'three/webgpu';
import {
  _acquireGpuTimer,
  _onRenderContext,
  _onTimestampsResolved,
  _releaseGpuTimer,
  _requestTimestampResolve,
  _sumGpuMs,
} from './_dbg__GPUTimer';
import { addPostFxChainListener, getPostFxBuiltChain } from '../PostFX';
import type { PostFxPassStats, PostFxStats } from '../PostFX/PostFXTypes';
import { lwarn } from '../../utils/Logger';

/** Smoothing factor of the exponential moving averages (~30 frame window). */
const EMA_ALPHA = 2 / 31;
/** Frames a record waits for its GPU timestamps before it is dropped. */
const MAX_PENDING_FRAMES = 8;
/** Frames skipped after every chain (re)build: they carry the one-time shader compile. */
const SKIP_FRAMES_AFTER_BUILD = 2;

type FrameRecord = {
  age: number;
  /** Per PostFX pass (chain index): CPU ms and the render context uids it opened. */
  passCpuMs: number[];
  passUids: string[][];
  /** Render context uids opened outside any PostFX pass (first one = the composite quad). */
  otherUids: string[];
};

type Avg = { value: number; hasValue: boolean };
type PassAverages = { cpu: Avg; gpu: Avg; hasGpuWork: boolean };

let isMeasuring = false;
let gpuAvailable = false;
let removeChainListener: (() => void) | null = null;
let removeRenderContextListener: (() => void) | null = null;
let removeResolveListener: (() => void) | null = null;

// Current build's wrapping
let passIds: string[] = [];
let wrappedPipeline: RenderPipeline | null = null;
let wrappedNodes: { node: Node; orig: Node['updateBefore']; isOwn: boolean }[] = [];

// Per frame
let currentFrame: FrameRecord | null = null;
const activePassStack: number[] = [];
let pendingFrames: FrameRecord[] = [];
let framesToSkip = 0;

// Results
const passAverages = new Map<string, PassAverages>();
const sceneGpu: Avg = { value: 0, hasValue: false };
const compositeGpu: Avg = { value: 0, hasValue: false };
let cpuSamples = 0;
let gpuSamples = 0;

const addSample = (avg: Avg, value: number) => {
  avg.value = avg.hasValue ? avg.value + (value - avg.value) * EMA_ALPHA : value;
  avg.hasValue = true;
};

const getPassAverages = (id: string) => {
  let avgs = passAverages.get(id);
  if (!avgs) {
    avgs = {
      cpu: { value: 0, hasValue: false },
      gpu: { value: 0, hasValue: false },
      hasGpuWork: false,
    };
    passAverages.set(id, avgs);
  }
  return avgs;
};

/** Attributes a render context to the PostFX pass that is running, else to the frame's others. */
const onRenderContext = (uid: string) => {
  if (!currentFrame) return;
  if (activePassStack.length) {
    currentFrame.passUids[activePassStack[activePassStack.length - 1]].push(uid);
  } else {
    currentFrame.otherUids.push(uid);
  }
};

/** Reads the GPU durations of every pending frame whose timestamps the last resolve delivered. */
const collectGpuTimes = (timestamps: ReadonlyMap<string, number>) => {
  const stillPending: FrameRecord[] = [];
  for (let f = 0; f < pendingFrames.length; f++) {
    const record = pendingFrames[f];
    const passGpu: (number | null)[] = [];
    let isComplete = true;
    for (let i = 0; i < record.passUids.length && isComplete; i++) {
      const ms = _sumGpuMs(timestamps, record.passUids[i]);
      if (ms === null) isComplete = false;
      passGpu.push(record.passUids[i].length ? ms : null);
    }
    const compositeMs = record.otherUids.length ? _sumGpuMs(timestamps, [record.otherUids[0]]) : 0;
    const sceneMs = _sumGpuMs(timestamps, record.otherUids.slice(1));
    if (!isComplete || compositeMs === null || sceneMs === null) {
      if (++record.age < MAX_PENDING_FRAMES) stillPending.push(record);
      continue;
    }
    for (let i = 0; i < passGpu.length; i++) {
      const ms = passGpu[i];
      if (ms !== null) addSample(getPassAverages(passIds[i]).gpu, ms);
    }
    addSample(compositeGpu, compositeMs);
    addSample(sceneGpu, sceneMs);
    gpuSamples++;
  }
  pendingFrames = stillPending;
};

const beginFrame = () => {
  const count = passIds.length;
  currentFrame = { age: 0, passCpuMs: new Array(count).fill(0), passUids: [], otherUids: [] };
  for (let i = 0; i < count; i++) currentFrame.passUids.push([]);
  activePassStack.length = 0;
};

const endFrame = () => {
  const record = currentFrame;
  currentFrame = null;
  if (!record) return;
  if (framesToSkip > 0) {
    framesToSkip--;
    return;
  }
  for (let i = 0; i < record.passCpuMs.length; i++) {
    const avgs = getPassAverages(passIds[i]);
    addSample(avgs.cpu, record.passCpuMs[i]);
    // Known on the CPU side: did this PostFX pass issue render passes of its own
    avgs.hasGpuWork = record.passUids[i].length > 0;
  }
  cpuSamples++;
  if (!gpuAvailable) return;
  pendingFrames.push(record);
  // A batch another resolve consumed (eg. the stats-gl GPU panel's own) can be missed: that
  // frame then ages out of pendingFrames, it is never reported wrong
  _requestTimestampResolve();
};

const unwrapChain = () => {
  if (wrappedPipeline) {
    delete (wrappedPipeline as Partial<RenderPipeline>).render;
    wrappedPipeline = null;
  }
  for (let i = 0; i < wrappedNodes.length; i++) {
    const { node, orig, isOwn } = wrappedNodes[i];
    if (isOwn) {
      node.updateBefore = orig;
    } else {
      delete (node as Partial<Node>).updateBefore;
    }
  }
  wrappedNodes = [];
  passIds = [];
  currentFrame = null;
  pendingFrames = [];
};

const resetStats = () => {
  passAverages.clear();
  sceneGpu.hasValue = false;
  compositeGpu.hasValue = false;
  cpuSamples = 0;
  gpuSamples = 0;
};

/** (Re)wraps the currently built PostFX chain, called after every build and dispose. */
const wrapChain = () => {
  unwrapChain();
  // A new chain is a new measurement
  resetStats();
  framesToSkip = SKIP_FRAMES_AFTER_BUILD;
  const chain = getPostFxBuiltChain();
  if (!chain) return;

  passIds = chain.postFxPasses.map((p) => p.id);

  const pipeline = chain.pipeline;
  const origRender = pipeline.render;
  pipeline.render = () => {
    beginFrame();
    try {
      origRender.call(pipeline);
    } finally {
      endFrame();
    }
  };
  wrappedPipeline = pipeline;

  chain.postFxPasses.forEach(({ profileNodes }, passIndex) => {
    for (const node of profileNodes) {
      const orig = node.updateBefore;
      if (typeof orig !== 'function') continue;
      const isOwn = Object.prototype.hasOwnProperty.call(node, 'updateBefore');
      node.updateBefore = function (this: Node, frame: NodeFrame) {
        const start = performance.now();
        activePassStack.push(passIndex);
        try {
          return orig.call(this, frame);
        } finally {
          activePassStack.pop();
          if (currentFrame) currentFrame.passCpuMs[passIndex] += performance.now() - start;
        }
      };
      wrappedNodes.push({ node, orig, isOwn });
    }
  });
};

/**
 * Switches PostFX measuring on or off, live.
 * @param enabled (boolean)
 */
export const _setPostFxMeasureEnabled = (enabled: boolean) => {
  if (enabled === isMeasuring) return;

  if (enabled) {
    const timer = _acquireGpuTimer();
    if (!timer) {
      lwarn('[PostFX profiler] Could not start measuring, the renderer has not been created.');
      return;
    }
    gpuAvailable = timer.gpuAvailable;
    if (!gpuAvailable) {
      lwarn('[PostFX profiler] GPU timestamp queries are not supported, measuring CPU time only.');
    }
    removeRenderContextListener = _onRenderContext(onRenderContext);
    removeResolveListener = _onTimestampsResolved(collectGpuTimes);
    isMeasuring = true;
    removeChainListener = addPostFxChainListener(wrapChain);
    wrapChain();
    return;
  }

  isMeasuring = false;
  removeChainListener?.();
  removeChainListener = null;
  unwrapChain();
  removeRenderContextListener?.();
  removeRenderContextListener = null;
  removeResolveListener?.();
  removeResolveListener = null;
  _releaseGpuTimer();
};

/** Whether PostFX measuring is on. */
export const _isPostFxMeasureEnabled = () => isMeasuring;

/**
 * Returns the smoothed (~30 frame) PostFX measurements, or null when not measuring.
 * @returns ({@link PostFxStats} | null)
 */
export const _getPostFxPassStats = (): PostFxStats | null => {
  if (!isMeasuring) return null;
  const postFxPasses: PostFxPassStats[] = passIds.map((id) => {
    const avgs = getPassAverages(id);
    return {
      id,
      cpuMs: avgs.cpu.value,
      gpuMs: avgs.hasGpuWork && avgs.gpu.hasValue ? avgs.gpu.value : null,
      gpuAttribution: avgs.hasGpuWork ? 'exact' : 'shared',
    };
  });
  return {
    gpuAvailable,
    cpuSamples,
    gpuSamples,
    sceneGpuMs: sceneGpu.hasValue ? sceneGpu.value : null,
    compositeGpuMs: compositeGpu.hasValue ? compositeGpu.value : null,
    postFxPasses,
  };
};
