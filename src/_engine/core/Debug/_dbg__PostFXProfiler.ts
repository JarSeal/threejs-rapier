/**
 * PostFX per-pass performance measuring (docs/plans/_DONE_p070_post-fx-system.md, Design decision 8).
 * Debug-only, lazily loaded through debug/PostFXProfiler.ts, and switchable live (no reload).
 * While off nothing is installed: no inspector, no wrappers, no timing calls.
 *
 * - CPU: each PostFX pass's profileNodes' updateBefore() is wrapped with performance.now().
 * - GPU: an InspectorBase subclass is installed as renderer.inspector. Every render context
 *   opened (beginRender) while a PostFX pass's updateBefore() is running is attributed to that
 *   PostFX pass (including nested ones, eg. the depth/normal pre-pass is attributed to the first
 *   PostFX pass that renders it). After the frame, the render timestamps are resolved and each
 *   context's GPU duration is read from the backend's timestamp pool.
 * - Render contexts opened outside any PostFX pass are the final composite quad (the first
 *   context of the pipeline render) and the scene pass. Pure in-chain PostFX passes are
 *   evaluated inside the composite, so they are reported as gpuAttribution 'shared'.
 */
import {
  InspectorBase,
  TimestampQuery,
  type Camera,
  type ComputeNode,
  type Node,
  type NodeFrame,
  type RenderPipeline,
  type RenderTarget,
  type Renderer,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { getRenderer } from '../Renderer';
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

type TimestampPool = { timestamps: Map<string, number> };
type ProfiledBackend = {
  trackTimestamp: boolean;
  isWebGPUBackend?: boolean;
  hasTimestamp: boolean;
  timestampQueryPool: Record<string, TimestampPool | null | undefined>;
};

let isMeasuring = false;
let renderer: WebGPURenderer | null = null;
let backend: ProfiledBackend | null = null;
let gpuAvailable = false;
let prevTrackTimestamp = false;
let prevInspector: InspectorBase | null = null;
let removeChainListener: (() => void) | null = null;

// Current build's wrapping
let passIds: string[] = [];
let wrappedPipeline: RenderPipeline | null = null;
let wrappedNodes: { node: Node; orig: Node['updateBefore']; isOwn: boolean }[] = [];

// Per frame
let currentFrame: FrameRecord | null = null;
const activePassStack: number[] = [];
let pendingFrames: FrameRecord[] = [];
let isResolving = false;
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

/** Forwards everything to the previously installed inspector, so it keeps working. */
class PostFxProfilerInspector extends InspectorBase {
  private readonly prev: InspectorBase;

  constructor(prev: InspectorBase) {
    super();
    this.prev = prev;
  }

  setRenderer(r: Renderer) {
    super.setRenderer(r);
    this.prev.setRenderer(r);
    return this;
  }

  begin() {
    super.begin();
    this.prev.begin();
  }

  finish() {
    super.finish();
    this.prev.finish();
  }

  inspect(node: Node) {
    this.prev.inspect(node);
  }

  computeAsync(computeNode: ComputeNode, dispatchSizeOrCount: number | number[]) {
    this.prev.computeAsync(computeNode, dispatchSizeOrCount);
  }

  beginCompute(uid: string, computeNode: ComputeNode) {
    this.prev.beginCompute(uid, computeNode);
  }

  finishCompute(uid: string) {
    this.prev.finishCompute(uid);
  }

  beginRender(uid: string, scene: Scene, camera: Camera, renderTarget: RenderTarget) {
    if (currentFrame) {
      if (activePassStack.length) {
        currentFrame.passUids[activePassStack[activePassStack.length - 1]].push(uid);
      } else {
        currentFrame.otherUids.push(uid);
      }
    }
    this.prev.beginRender(uid, scene, camera, renderTarget);
  }

  finishRender(uid: string) {
    this.prev.finishRender(uid);
  }

  copyTextureToTexture(srcTexture: Texture, dstTexture: Texture) {
    this.prev.copyTextureToTexture(srcTexture, dstTexture);
  }

  copyFramebufferToTexture(framebufferTexture: Texture) {
    this.prev.copyFramebufferToTexture(framebufferTexture);
  }
}

const getGpuMs = (pool: TimestampPool, uids: string[]) => {
  let total = 0;
  for (let i = 0; i < uids.length; i++) {
    const ms = pool.timestamps.get(uids[i]);
    if (ms === undefined) return null;
    total += ms;
  }
  return total;
};

/** Reads the GPU durations of every pending frame whose timestamps the last resolve delivered. */
const collectGpuTimes = () => {
  const pool = backend?.timestampQueryPool[TimestampQuery.RENDER];
  const stillPending: FrameRecord[] = [];
  for (let f = 0; f < pendingFrames.length; f++) {
    const record = pendingFrames[f];
    const passGpu: (number | null)[] = [];
    let isComplete = Boolean(pool);
    for (let i = 0; pool && i < record.passUids.length && isComplete; i++) {
      const ms = getGpuMs(pool, record.passUids[i]);
      if (ms === null) isComplete = false;
      passGpu.push(record.passUids[i].length ? ms : null);
    }
    const compositeMs = pool && record.otherUids.length ? getGpuMs(pool, [record.otherUids[0]]) : 0;
    const sceneMs = pool ? getGpuMs(pool, record.otherUids.slice(1)) : null;
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
  if (!gpuAvailable || !renderer) return;
  pendingFrames.push(record);
  // Shared with the stats-gl GPU panel's own per-frame resolve. WebGPU: concurrent resolves
  // share one promise, and the pool keeps the last resolved batch until the next one. WebGL: a
  // concurrent resolve returns at once, so a batch another resolve consumed can be missed (that
  // frame then ages out of pendingFrames, it is never reported wrong).
  if (isResolving) return;
  isResolving = true;
  renderer
    .resolveTimestampsAsync(TimestampQuery.RENDER)
    .then(collectGpuTimes)
    .finally(() => {
      isResolving = false;
    });
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
    renderer = getRenderer() || null;
    if (!renderer) {
      lwarn('[PostFX profiler] Could not start measuring, the renderer has not been created.');
      return;
    }
    backend = renderer.backend as unknown as ProfiledBackend;
    // WebGPUBackend.hasTimestamp is always true, the device feature is what decides
    gpuAvailable = backend.isWebGPUBackend
      ? renderer.hasFeature('timestamp-query')
      : backend.hasTimestamp;
    if (!gpuAvailable) {
      lwarn('[PostFX profiler] GPU timestamp queries are not supported, measuring CPU time only.');
    }
    prevTrackTimestamp = backend.trackTimestamp;
    // The timestamp query pool is created lazily on first use, so this works after init
    if (gpuAvailable) backend.trackTimestamp = true;
    prevInspector = renderer.inspector;
    // Note: on the WebGL backend three warns once that ".toInspector()" needs WebGPU whenever a
    // custom inspector is installed, harmless (it only concerns three's own inspector addon)
    renderer.inspector = new PostFxProfilerInspector(prevInspector);
    isMeasuring = true;
    removeChainListener = addPostFxChainListener(wrapChain);
    wrapChain();
    return;
  }

  isMeasuring = false;
  removeChainListener?.();
  removeChainListener = null;
  unwrapChain();
  if (renderer && prevInspector) renderer.inspector = prevInspector;
  // Keep timestamps on if something else (eg. the stats-gl GPU panel) switched them on meanwhile
  if (backend && !prevTrackTimestamp) backend.trackTimestamp = false;
  prevInspector = null;
  renderer = null;
  backend = null;
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
