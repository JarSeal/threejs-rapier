import { ECSSystemStage } from '../../ECS/SystemStages';
import { IS_DEBUG_ENV } from '../../Config';
import { getECSWorld } from '../../ECS';
import {
  getLastPhysicsStepDuration,
  getLastPhysicsStepMessagingLatency,
  getPhysicsObjectCounts,
  getPhysicsRayStats,
  getPhysicsState,
  getPhysicsSubStepTotal,
  getResolvedTransportMode,
  isPhysicsRayStatsEnabled,
  isPhysicsStepStatsEnabled,
  isPhysicsWorldEnabled,
  setPhysicsRayStatsEnabled,
  setPhysicsStepStatsEnabled,
} from '../../PhysicsAPI';
import { getActivePostFxPipeline } from '../../PostFX';
import { getRayCastStats, isRayCastStatsEnabled, setRayCastStatsEnabled } from '../../Raycast';
import { getRenderer } from '../../Renderer';
import { getCurrentSceneId } from '../../Scene';
import { getNextSceneId, isCurrentlyLoading } from '../../SceneLoader';
import { addViewFrameListener } from '../../ViewManager';
import { registerStatsSource, type ProfilerSettings } from '../../../debug/Profiler';
import {
  getPostFxPassStats,
  isPostFxMeasureEnabled,
  setPostFxMeasureEnabled,
} from '../../../debug/PostFXProfiler';
import type { IntervalCounterSnapshot } from '../../../utils/stats/IntervalCounterStats';
import {
  _acquireGpuTimer,
  _getGpuTimerSupport,
  _onRenderContext,
  _onTimestampsResolved,
  _releaseGpuTimer,
  _requestTimestampResolve,
  _sumGpuMs,
} from '../_dbg__GPUTimer';
import { getCensusAvailability, runSceneCensus, type SceneCensus } from './_dbg__Census';
import { SampleWindow, type WindowStat } from './_dbg__SampleWindow';

/** The built-in stats sources (§2.5). Each one measures only while it is acquired. */

export const PROFILER_SOURCE = {
  GPU_FRAME: 'gpu.frame',
  DRAW: 'render.draw',
  PHYSICS_STEP: 'physics.step',
  PHYSICS_SUB_STEPS: 'physics.subSteps',
  PHYSICS_OBJECTS: 'physics.objects',
  MEMORY_JS: 'memory.js',
  MEMORY_GPU: 'memory.gpu',
  RAYS: 'rays',
  POSTFX: 'postFx',
  LONG_TASKS: 'longTasks',
  SCENE: 'scene',
  CENSUS: 'scene.census',
} as const;

/** The per-frame sources summarize the frames of the last second (like the frame probe). */
const WINDOW_MS = 1000;

const NO_RENDERER = 'no renderer yet';
const PHYSICS_OFF = 'physics off';

// --- FRAME SAMPLER ---
// One LATE_MAIN system on the default world (right after the frame's renderScene(), the p345
// reason: three resets `info.render` at the start of its own animation frame), added while a
// per-frame source is acquired and removed with the last one. In an editor view (ViewManager.ts)
// the scene's stages don't run, so an 'AFTER_RENDER' view frame listener samples there.

const SAMPLER_SYSTEM_ID = 'aekProfilerFrameSampler';
/** After every other LATE_MAIN system, so a late render pass still counts for the frame. */
const SAMPLER_ORDER = -10000;

const sampled = { draw: false, subSteps: false, gpu: false };
let isSamplerAdded = false;
let removeViewSampler: (() => void) | null = null;

const frameSamplerSystem = () => {
  const now = performance.now();
  if (sampled.draw) sampleDraw(now);
  if (sampled.subSteps) sampleSubSteps(now);
  if (sampled.gpu) endGpuFrame();
};

/** Adds or removes the sampler system to match what is sampled. */
const updateSampler = () => {
  const isNeeded = sampled.draw || sampled.subSteps || sampled.gpu;
  if (isNeeded === isSamplerAdded) return;
  isSamplerAdded = isNeeded;
  const world = getECSWorld();
  if (isNeeded) {
    world.addSystem(ECSSystemStage.LATE_MAIN, SAMPLER_SYSTEM_ID, frameSamplerSystem, SAMPLER_ORDER);
    removeViewSampler = addViewFrameListener(frameSamplerSystem, 'AFTER_RENDER');
  } else {
    world.removeSystem(SAMPLER_SYSTEM_ID);
    removeViewSampler?.();
    removeViewSampler = null;
  }
};

/** Whether the profiler's LATE_MAIN sampler system is added (nothing per-frame is acquired). */
export const _isFrameSamplerAdded = () => isSamplerAdded;

// --- DRAW COUNTERS ---

export type DrawStats = {
  /** Rendered frames in the window. */
  frames: number;
  /** Per frame, over every pass of the frame (shadows, PostFX, viewports). */
  drawCalls: WindowStat;
  triangles: WindowStat;
  points: WindowStat;
  lines: WindowStat;
};

const drawWindow = new SampleWindow(4);
const drawStats: DrawStats = {
  frames: 0,
  drawCalls: drawWindow.stats[0],
  triangles: drawWindow.stats[1],
  points: drawWindow.stats[2],
  lines: drawWindow.stats[3],
};

const sampleDraw = (now: number) => {
  const render = getRenderer()?.info.render;
  if (!render) return;
  drawWindow.push(now, render.drawCalls, render.triangles, render.points, render.lines);
};

// --- PHYSICS SUB-STEPS ---

export type PhysicsSubStepStats = {
  frames: number;
  /** Fixed sub-steps per rendered frame. */
  subSteps: WindowStat;
  /** The stepper's ceiling (0 = none): a frame at it dropped simulated time. */
  maxSubSteps: number;
};

const subStepWindow = new SampleWindow(1);
const subStepStats: PhysicsSubStepStats = {
  frames: 0,
  subSteps: subStepWindow.stats[0],
  maxSubSteps: 0,
};
let lastSubStepTotal = 0;

const sampleSubSteps = (now: number) => {
  const total = getPhysicsSubStepTotal();
  subStepWindow.push(now, total - lastSubStepTotal);
  lastSubStepTotal = total;
};

// --- GPU FRAME TIME ---
// Every render context opened between two sampler runs belongs to that frame (MAIN-stage bakes
// included). The sampler closes the frame's record and requests a resolve, and a record is
// summed once a resolved batch has all of its contexts. Results arrive a few frames late.

export type GpuFrameStats = {
  /** Frames with resolved timestamps in the window. */
  frames: number;
  /** GPU ms per frame, every render pass summed. */
  ms: WindowStat;
};

type GpuFrameRecord = { uids: string[]; age: number };

/** Frames a record waits for its timestamps before it is dropped. */
const GPU_MAX_PENDING_FRAMES = 8;
const GPU_RECORD_POOL_SIZE = GPU_MAX_PENDING_FRAMES + 2;

const gpuWindow = new SampleWindow(1);
const gpuStats: GpuFrameStats = { frames: 0, ms: gpuWindow.stats[0] };
const freeGpuRecords: GpuFrameRecord[] = Array.from({ length: GPU_RECORD_POOL_SIZE }, () => ({
  uids: [],
  age: 0,
}));
const pendingGpuRecords: GpuFrameRecord[] = [];
let currentGpuRecord: GpuFrameRecord | null = null;
let removeRenderContextListener: (() => void) | null = null;
let removeResolveListener: (() => void) | null = null;

const recycleGpuRecord = (record: GpuFrameRecord) => {
  record.uids.length = 0;
  record.age = 0;
  freeGpuRecords.push(record);
};

const takeGpuRecord = () => {
  // Out of records: drop the oldest pending frame
  if (!freeGpuRecords.length) {
    const oldest = pendingGpuRecords.shift();
    if (oldest) recycleGpuRecord(oldest);
  }
  return freeGpuRecords.pop() || null;
};

const endGpuFrame = () => {
  const record = currentGpuRecord;
  if (!record || !record.uids.length) return;
  pendingGpuRecords.push(record);
  currentGpuRecord = takeGpuRecord();
  _requestTimestampResolve();
};

const collectGpuTimes = (timestamps: ReadonlyMap<string, number>) => {
  const now = performance.now();
  let kept = 0;
  for (let i = 0; i < pendingGpuRecords.length; i++) {
    const record = pendingGpuRecords[i];
    const ms = _sumGpuMs(timestamps, record.uids);
    if (ms !== null) {
      gpuWindow.push(now, ms);
      recycleGpuRecord(record);
    } else if (++record.age >= GPU_MAX_PENDING_FRAMES) {
      // Its batch went to another resolver (eg. the stats-gl GPU panel's): never reported wrong
      recycleGpuRecord(record);
    } else {
      pendingGpuRecords[kept++] = record;
    }
  }
  pendingGpuRecords.length = kept;
};

const acquireGpuFrames = () => {
  const timer = _acquireGpuTimer();
  if (!timer) return;
  if (!timer.gpuAvailable) {
    // Held but without timestamps (availability rules this out): give the hold back
    _releaseGpuTimer();
    return;
  }
  gpuWindow.reset();
  currentGpuRecord = takeGpuRecord();
  removeRenderContextListener = _onRenderContext((uid) => currentGpuRecord?.uids.push(uid));
  removeResolveListener = _onTimestampsResolved(collectGpuTimes);
  sampled.gpu = true;
  updateSampler();
};

const releaseGpuFrames = () => {
  if (!sampled.gpu) return;
  sampled.gpu = false;
  updateSampler();
  removeRenderContextListener?.();
  removeResolveListener?.();
  removeRenderContextListener = null;
  removeResolveListener = null;
  if (currentGpuRecord) recycleGpuRecord(currentGpuRecord);
  currentGpuRecord = null;
  while (pendingGpuRecords.length) recycleGpuRecord(pendingGpuRecords.pop() as GpuFrameRecord);
  _releaseGpuTimer();
};

// --- OTHER SOURCE VALUES ---

export type PhysicsStepStats = {
  /** Engine step time of the last stepped frame (all its sub-steps), never messaging. */
  stepMs: number;
  /** WORKER_THREAD only: main → worker STEP message transit. */
  dispatchMs: number | null;
  /** WORKER_THREAD only: transit of the write-back on MESSAGE_BATCH, read latency on
   * SHARED_MEMORY. Never summed with the step. */
  writeBackMs: number | null;
  transport: 'MAIN_THREAD' | 'SHARED_MEMORY' | 'MESSAGE_BATCH';
};

export type PhysicsObjectStats = ReturnType<typeof getPhysicsObjectCounts>;

export type JsMemoryStats = { usedBytes: number; totalBytes: number; limitBytes: number };

/** three's own estimate of what it allocated (`renderer.info.memory.total`). */
export type GpuMemoryStats = { bytes: number };

export type RayStats = {
  /** Three.js ray casts: last frame, and the per-frame average over 3 s. */
  three: { lastFrame: number; avg: number };
  /** Physics queries (rays and shape casts), null without physics. */
  physics: { lastFrame: number; avg: number; pending: number } | null;
};

export type PostFxGpuStats = {
  /** The PostFX passes' own render passes plus the final composite, null without timestamps. */
  gpuMs: number | null;
  cpuMs: number;
  passes: number;
};

export type LongTaskStats = { count: number; longestMs: number };

export type SceneStats = { currentId: string | null; isLoading: boolean; nextId: string | null };

type ChromiumMemory = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
const getChromiumMemory = () =>
  (performance as Performance & { memory?: ChromiumMemory }).memory || null;

/** The 3 s per-frame average window of the ray stats (RAY_STATS_WINDOWS). */
const RAY_AVG_WINDOW_ID = 'average3s';
const getAverage = (snapshot: Readonly<IntervalCounterSnapshot>) =>
  snapshot.windows.find((w) => w.id === RAY_AVG_WINDOW_ID)?.average ?? 0;

/** A plain-boolean switch shared with its own tab: turned on only if off, and on release turned
 * off only if this source turned it on (and nobody turned it off meanwhile). */
const createSharedSwitch = (isOn: () => boolean, setOn: (on: boolean) => unknown) => {
  let isOwn = false;
  return {
    acquire: () => {
      isOwn = !isOn();
      if (isOwn) setOn(true);
    },
    release: () => {
      if (isOwn && isOn()) setOn(false);
      isOwn = false;
    },
  };
};

const threeRaySwitch = createSharedSwitch(isRayCastStatsEnabled, setRayCastStatsEnabled);
const physicsRaySwitch = createSharedSwitch(isPhysicsRayStatsEnabled, setPhysicsRayStatsEnabled);
const physicsStepSwitch = createSharedSwitch(isPhysicsStepStatsEnabled, setPhysicsStepStatsEnabled);

// PostFX measuring is switched by an async call (it loads its module first): a release that
// lands before the switch-on finished turns it off once it has.
let isPostFxOwn = false;
const acquirePostFx = () => {
  isPostFxOwn = !isPostFxMeasureEnabled();
  if (!isPostFxOwn) return;
  void setPostFxMeasureEnabled(true).then(() => {
    if (!isPostFxOwn) void setPostFxMeasureEnabled(false);
  });
};
const releasePostFx = () => {
  if (isPostFxOwn && isPostFxMeasureEnabled()) void setPostFxMeasureEnabled(false);
  isPostFxOwn = false;
};

const longTaskWindow = new SampleWindow(1, 256);
let longTaskObserver: PerformanceObserver | null = null;

export type { SceneCensus } from './_dbg__Census';

/** The census walks the scene at most once per half update interval, so views that read it in
 * the same refresh (or two refreshes close together) share one walk. */
const readCensus = (settings: Readonly<ProfilerSettings>) => {
  let last: Readonly<SceneCensus> | null = null;
  return () => {
    const minAgeMs = 500 / settings.updateRateHz;
    if (
      last &&
      last.excludesDebugHelpers === settings.excludeDebugHelpers &&
      performance.now() - last.sampledAt < minAgeMs
    ) {
      return last;
    }
    last = runSceneCensus(settings.excludeDebugHelpers);
    return last;
  };
};

// --- REGISTRATION ---

/**
 * Registers the built-in stats sources. Called once by the profiler module.
 * @param settings (object) the live profiler settings (`measureGpu`)
 */
export const registerBuiltInStatsSources = (settings: Readonly<ProfilerSettings>) => {
  registerStatsSource<GpuFrameStats>({
    id: PROFILER_SOURCE.GPU_FRAME,
    label: 'GPU frame time',
    availability: () => {
      if (!settings.measureGpu) return 'off in Settings';
      if (!getRenderer()) return NO_RENDERER;
      return _getGpuTimerSupport() === 'WEBGPU' ? true : 'WebGPU with timestamp queries only';
    },
    acquire: acquireGpuFrames,
    release: releaseGpuFrames,
    read: () => {
      gpuStats.frames = gpuWindow.summarize(WINDOW_MS);
      return gpuStats.frames ? gpuStats : null;
    },
  });

  registerStatsSource<DrawStats>({
    id: PROFILER_SOURCE.DRAW,
    label: 'Draw counters',
    availability: () => (getRenderer() ? true : NO_RENDERER),
    acquire: () => {
      drawWindow.reset();
      sampled.draw = true;
      updateSampler();
    },
    release: () => {
      sampled.draw = false;
      updateSampler();
    },
    read: () => {
      drawStats.frames = drawWindow.summarize(WINDOW_MS);
      return drawStats.frames ? drawStats : null;
    },
  });

  registerStatsSource<PhysicsStepStats>({
    id: PROFILER_SOURCE.PHYSICS_STEP,
    label: 'Physics step',
    availability: () => (getPhysicsState().enabled ? true : PHYSICS_OFF),
    // On at boot (AppConfig.physics.stepStatsEnabled), they stay on after the release
    acquire: physicsStepSwitch.acquire,
    release: physicsStepSwitch.release,
    read: () => {
      const stepMs = getLastPhysicsStepDuration();
      if (stepMs === undefined) return null;
      const latency = getLastPhysicsStepMessagingLatency();
      const isMain = getPhysicsState().workerTarget === 'MAIN_THREAD';
      return {
        stepMs,
        dispatchMs: latency?.dispatchMs ?? null,
        writeBackMs: latency?.writeBackMs ?? null,
        transport: isMain ? 'MAIN_THREAD' : getResolvedTransportMode() || 'MESSAGE_BATCH',
      };
    },
  });

  registerStatsSource<PhysicsSubStepStats>({
    id: PROFILER_SOURCE.PHYSICS_SUB_STEPS,
    label: 'Physics sub-steps',
    availability: () => (getPhysicsState().enabled ? true : PHYSICS_OFF),
    acquire: () => {
      subStepWindow.reset();
      lastSubStepTotal = getPhysicsSubStepTotal();
      sampled.subSteps = true;
      updateSampler();
    },
    release: () => {
      sampled.subSteps = false;
      updateSampler();
    },
    read: () => {
      subStepStats.frames = subStepWindow.summarize(WINDOW_MS);
      subStepStats.maxSubSteps = getPhysicsState().maxSubSteps;
      return subStepStats.frames ? subStepStats : null;
    },
  });

  registerStatsSource<PhysicsObjectStats>({
    id: PROFILER_SOURCE.PHYSICS_OBJECTS,
    label: 'Physics objects',
    availability: () => (isPhysicsWorldEnabled() ? true : 'no physics world'),
    read: getPhysicsObjectCounts,
  });

  registerStatsSource<JsMemoryStats>({
    id: PROFILER_SOURCE.MEMORY_JS,
    label: 'JS heap',
    availability: () => (getChromiumMemory() ? true : 'Chromium only'),
    read: () => {
      const memory = getChromiumMemory();
      if (!memory) return null;
      return {
        usedBytes: memory.usedJSHeapSize,
        totalBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      };
    },
  });

  registerStatsSource<GpuMemoryStats>({
    id: PROFILER_SOURCE.MEMORY_GPU,
    label: 'GPU memory (est.)',
    availability: () => (getRenderer() ? true : NO_RENDERER),
    read: () => {
      const renderer = getRenderer();
      return renderer ? { bytes: renderer.info.memory.total } : null;
    },
  });

  registerStatsSource<RayStats>({
    id: PROFILER_SOURCE.RAYS,
    label: 'Ray casts',
    acquire: () => {
      threeRaySwitch.acquire();
      physicsRaySwitch.acquire();
    },
    release: () => {
      threeRaySwitch.release();
      physicsRaySwitch.release();
    },
    read: () => {
      const three = getRayCastStats();
      let physics: RayStats['physics'] = null;
      if (getPhysicsState().enabled) {
        const { rays, shapeCasts, pendingQueries } = getPhysicsRayStats();
        physics = {
          lastFrame: rays.lastFrame + shapeCasts.lastFrame,
          avg: getAverage(rays) + getAverage(shapeCasts),
          pending: pendingQueries,
        };
      }
      return { three: { lastFrame: three.lastFrame, avg: getAverage(three) }, physics };
    },
  });

  registerStatsSource<PostFxGpuStats>({
    id: PROFILER_SOURCE.POSTFX,
    label: 'PostFX',
    availability: () => {
      if (!IS_DEBUG_ENV) return 'debug env only';
      if (!getRenderer()) return NO_RENDERER;
      return getActivePostFxPipeline() ? true : 'PostFX off';
    },
    acquire: acquirePostFx,
    release: releasePostFx,
    read: () => {
      const stats = getPostFxPassStats();
      if (!stats || !stats.cpuSamples) return null;
      let cpuMs = 0;
      let passGpuMs = 0;
      for (let i = 0; i < stats.postFxPasses.length; i++) {
        const pass = stats.postFxPasses[i];
        cpuMs += pass.cpuMs;
        passGpuMs += pass.gpuMs ?? 0;
      }
      const hasGpu = stats.gpuAvailable && stats.compositeGpuMs !== null;
      return {
        gpuMs: hasGpu ? passGpuMs + (stats.compositeGpuMs as number) : null,
        cpuMs,
        passes: stats.postFxPasses.length,
      };
    },
  });

  registerStatsSource<LongTaskStats>({
    id: PROFILER_SOURCE.LONG_TASKS,
    label: 'Long tasks',
    availability: () =>
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes?.includes('longtask')
        ? true
        : 'Chromium only',
    acquire: () => {
      longTaskWindow.reset();
      longTaskObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
          const { startTime, duration } = entries[i];
          longTaskWindow.push(startTime + duration, duration);
        }
      });
      longTaskObserver.observe({ type: 'longtask' });
    },
    release: () => {
      longTaskObserver?.disconnect();
      longTaskObserver = null;
    },
    read: () => {
      const count = longTaskWindow.summarize(WINDOW_MS);
      return { count, longestMs: longTaskWindow.stats[0].max };
    },
  });

  registerStatsSource<SceneStats>({
    id: PROFILER_SOURCE.SCENE,
    label: 'Scene',
    read: () => ({
      currentId: getCurrentSceneId(),
      isLoading: isCurrentlyLoading(),
      nextId: getNextSceneId() || null,
    }),
  });

  registerStatsSource<SceneCensus>({
    id: PROFILER_SOURCE.CENSUS,
    label: 'In-view census',
    availability: getCensusAvailability,
    read: readCensus(settings),
  });
};
