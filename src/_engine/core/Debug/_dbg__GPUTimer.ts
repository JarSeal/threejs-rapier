/**
 * Shared GPU timestamp-query plumbing for debug measurements (the PostFX profiler, the sky box
 * env bake stats). Debug only.
 *
 * - While anyone holds the timer (_acquireGpuTimer), the backend tracks timestamps and one
 *   inspector reports every render context opened (_onRenderContext), so a measurement can
 *   collect the context uids of the work it wants timed.
 * - Every resolve replaces the timestamp pool's batch, so separate resolvers would consume each
 *   other's timestamps. _requestTimestampResolve runs one resolve at a time and hands each batch
 *   to every listener (_onTimestampsResolved). Something outside (eg. the stats-gl GPU panel)
 *   can still resolve on its own: listeners get a batch without their uids, and retry.
 */
import {
  InspectorBase,
  TimestampQuery,
  type Camera,
  type ComputeNode,
  type Node,
  type RenderTarget,
  type Renderer,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { getRenderer } from '../Renderer';

type TimestampPool = { timestamps: Map<string, number> };
type TimedBackend = {
  trackTimestamp: boolean;
  isWebGPUBackend?: boolean;
  hasTimestamp: boolean;
  timestampQueryPool: Record<string, TimestampPool | null | undefined>;
};

type RenderContextListener = (uid: string) => void;
type ResolveListener = (timestamps: ReadonlyMap<string, number>) => void;

let holders = 0;
let renderer: WebGPURenderer | null = null;
let backend: TimedBackend | null = null;
let gpuAvailable = false;
let prevTrackTimestamp = false;
let prevInspector: InspectorBase | null = null;
let tap: RenderContextTap | null = null;
let isResolving = false;
const renderContextListeners = new Set<RenderContextListener>();
const resolveListeners = new Set<ResolveListener>();
const NO_TIMESTAMPS: ReadonlyMap<string, number> = new Map();

/** Reports render contexts, and forwards everything to the previously installed inspector, so
 * it keeps working. */
class RenderContextTap extends InspectorBase {
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
    for (const listener of renderContextListeners) listener(uid);
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

/**
 * Which GPU timing the renderer has, without taking a hold. WEBGL: timer queries exist, but
 * three's WebGL pool times one render context at a time, and a context opened inside another
 * (eg. a PMREM bake's passes) never resolves.
 */
export const _getGpuTimerSupport = (): 'WEBGPU' | 'WEBGL' | 'NONE' => {
  const r = getRenderer();
  if (!r) return 'NONE';
  const b = r.backend as unknown as TimedBackend;
  if (b.isWebGPUBackend) return r.hasFeature('timestamp-query') ? 'WEBGPU' : 'NONE';
  return b.hasTimestamp ? 'WEBGL' : 'NONE';
};

/**
 * Takes a hold on the timer: the first hold switches timestamp tracking on and installs the
 * render context tap. Pair every successful call with _releaseGpuTimer.
 * @returns whether GPU times will be available (timestamp queries supported), or null when
 * the renderer doesn't exist yet (nothing was held)
 */
export const _acquireGpuTimer = (): { gpuAvailable: boolean } | null => {
  if (holders === 0) {
    renderer = getRenderer() || null;
    if (!renderer) return null;
    backend = renderer.backend as unknown as TimedBackend;
    // WebGPUBackend.hasTimestamp is always true, the device feature is what decides
    gpuAvailable = backend.isWebGPUBackend
      ? renderer.hasFeature('timestamp-query')
      : backend.hasTimestamp;
    prevTrackTimestamp = backend.trackTimestamp;
    // The timestamp query pool is created lazily on first use, so this works after init
    if (gpuAvailable) backend.trackTimestamp = true;
    prevInspector = renderer.inspector;
    // Note: on the WebGL backend three warns once that ".toInspector()" needs WebGPU whenever a
    // custom inspector is installed, harmless (it only concerns three's own inspector addon)
    tap = new RenderContextTap(prevInspector);
    renderer.inspector = tap;
  }
  holders++;
  return { gpuAvailable };
};

/** Releases a hold; the last one restores the inspector and the timestamp tracking. */
export const _releaseGpuTimer = () => {
  if (holders === 0) return;
  holders--;
  if (holders > 0) return;
  // Leave an inspector installed after ours alone (it forwards to ours, which keeps forwarding)
  if (renderer && prevInspector && renderer.inspector === tap) renderer.inspector = prevInspector;
  // Keep timestamps on if something else (eg. the stats-gl GPU panel) switched them on meanwhile
  if (backend && !prevTrackTimestamp) backend.trackTimestamp = false;
  prevInspector = null;
  tap = null;
  renderer = null;
  backend = null;
};

/** Calls `listener` with the uid of every render context opened while the timer is held.
 * @returns a function that removes the listener */
export const _onRenderContext = (listener: RenderContextListener) => {
  renderContextListeners.add(listener);
  return () => {
    renderContextListeners.delete(listener);
  };
};

/** Calls `listener` with every batch _requestTimestampResolve resolves (durations in ms by
 * render context uid; empty when there is no pool yet).
 * @returns a function that removes the listener */
export const _onTimestampsResolved = (listener: ResolveListener) => {
  resolveListeners.add(listener);
  return () => {
    resolveListeners.delete(listener);
  };
};

/** Resolves the render timestamps (unless a resolve is already running) and hands the batch
 * to every listener. WebGPU: concurrent resolves share one promise, and the pool keeps the last
 * resolved batch until the next one. WebGL: a concurrent resolve returns at once. */
export const _requestTimestampResolve = () => {
  if (isResolving || !renderer || !gpuAvailable) return;
  isResolving = true;
  const resolvingBackend = backend;
  renderer
    .resolveTimestampsAsync(TimestampQuery.RENDER)
    .then(() => {
      const timestamps =
        resolvingBackend?.timestampQueryPool[TimestampQuery.RENDER]?.timestamps ?? NO_TIMESTAMPS;
      for (const listener of resolveListeners) listener(timestamps);
    })
    .finally(() => {
      isResolving = false;
    });
};

/** The summed GPU ms of these render contexts, or null while any of them is missing. */
export const _sumGpuMs = (timestamps: ReadonlyMap<string, number>, uids: string[]) => {
  let total = 0;
  for (let i = 0; i < uids.length; i++) {
    const ms = timestamps.get(uids[i]);
    if (ms === undefined) return null;
    total += ms;
  }
  return total;
};
