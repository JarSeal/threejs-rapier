// The scene runner's test bridge (p601), `window.__AEK_TEST__`: public entry and types in
// `debug/TestBridge.ts`. Loads in the debug env and prod test mode, only with `?aekTest=true`.
// Console and page errors aren't collected here: the logger is the console, and the runner's
// browser listeners see everything from the first script on, before this can install.

import { NodeFrame } from 'three/webgpu';
import { IS_DEBUG_ENV } from '../Config';
import { getECSWorld } from '../ECS';
import { setFixedFrameDelta, toggleAppPlay, toggleMainPlay } from '../MainLoop';
import { setPhysicsInterpolationPinnedToNewest } from '../PhysicsManager';
import { getRenderer } from '../Renderer';
import { getCurrentSceneId } from '../Scene';
import { hasFirstSceneBeenLoaded, isCurrentlyLoading } from '../SceneLoader';
import { pauseDayNight } from '../SkyBox/SkyBox';
import { takeSnapshotAsync } from '../Snapshot';
import {
  getPhysicsDeterminismProbeSteps,
  onPhysicsProbeReport,
  type PhysicsProbeReport,
} from './_dbg__PhysicsDeterminism';
import { encodeRGBA8PNG } from './_dbg__PNGEncoder';
import { TEST_BRIDGE_VERSION, type AekTestBridge } from '../../debug/TestBridge';

const DEFAULT_TIMEOUT_MS = 60_000;
/** Every frame of a test page advances by this (the physics timestep: one step a frame) */
const TEST_FRAME_DELTA = 1 / 60;
/** Set by freeze(): TSL `time` stops too (three's own animation loop keeps calling update) */
let isTestClockFrozen = false;

/** The latest probe report per scene id (a page load probes one scene, a revisit replaces it) */
const probeReports = new Map<string, PhysicsProbeReport>();
/** whenProbeDone({ freeze: true }) is waiting: freeze in the report's own listener call */
let freezeOnProbeReport = false;
let freezing: Promise<void> | null = null;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Resolves with `check()`'s first non-null value, checked every frame, or null at the timeout */
const pollFrames = async <T>(check: () => T | null, timeoutMs: number) => {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null) return value;
    if (performance.now() >= end) return null;
    await nextFrame();
  }
};

const whenSceneReady: AekTestBridge['whenSceneReady'] = async (opts) => {
  const sceneId = await pollFrames(
    () => (hasFirstSceneBeenLoaded() && !isCurrentlyLoading() ? getCurrentSceneId() ?? null : null),
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  if (sceneId === null) {
    return { status: 'TIMEOUT', sceneId: getCurrentSceneId() ?? null };
  }
  // The scene's first frames: anything sampled from a render target has rendered into it
  await nextFrame();
  await nextFrame();
  const backend = getRenderer()?.backend as { isWebGPUBackend?: boolean } | undefined;
  return { status: 'READY', sceneId, backend: backend?.isWebGPUBackend ? 'WEBGPU' : 'WEBGL' };
};

const whenProbeDone: AekTestBridge['whenProbeDone'] = async (opts) => {
  if (getPhysicsDeterminismProbeSteps() === null) return { status: 'NOT_ARMED' };
  if (opts?.freeze) {
    const sceneId = getCurrentSceneId();
    // Already reported (a late call): freeze now, frames have run since
    if (sceneId && probeReports.has(sceneId)) freezing ??= freeze();
    else freezeOnProbeReport = true;
  }
  const report = await pollFrames(() => {
    const sceneId = getCurrentSceneId();
    return (sceneId && probeReports.get(sceneId)) || null;
  }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  freezeOnProbeReport = false;
  if (!report) {
    return { status: 'TIMEOUT', sceneId: getCurrentSceneId() ?? null };
  }
  if (freezing) await freezing;
  return { status: 'DONE', ...report };
};

const freeze: AekTestBridge['freeze'] = async () => {
  // Interpolation draws a pose between the last two steps that depends on frame timing: two
  // frames at the newest snapshot (the step the probe hashed) before the loops stop
  setPhysicsInterpolationPinnedToNewest(getECSWorld(), true);
  await nextFrame();
  await nextFrame();
  toggleAppPlay(false);
  pauseDayNight();
  toggleMainPlay(false);
  isTestClockFrozen = true;
};

// The test clock: what a frame draws depends on how many frames ran, not on how long they took
// (SwiftShader frames take anything from 20 ms to seconds). The main loop and physics take the
// fixed delta; three's TSL `time` (clouds, star twinkle) advances in `NodeFrame.update()` from
// `performance.now()`, once per animation frame, so that method is replaced (three r186's fields,
// re-check on a three upgrade).
const useTestClock = () => {
  setFixedFrameDelta(TEST_FRAME_DELTA);
  NodeFrame.prototype.update = function (this: NodeFrame) {
    this.frameId++;
    this.deltaTime = isTestClockFrozen ? 0 : TEST_FRAME_DELTA;
    this.time += this.deltaTime;
  };
};

const toBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const snapshot: AekTestBridge['snapshot'] = async ({ width, height }) => {
  const shot = await takeSnapshotAsync({ width, height });
  const png = await encodeRGBA8PNG(shot.data, shot.width, shot.height);
  return {
    width: shot.width,
    height: shot.height,
    pngBase64: await toBase64(png),
    postFx: shot.postFx,
  };
};

export const _installTestBridge = () => {
  if (window.__AEK_TEST__) return;
  useTestClock();
  onPhysicsProbeReport((report) => {
    probeReports.set(report.sceneId, report);
    if (freezeOnProbeReport && report.sceneId === getCurrentSceneId()) {
      freezeOnProbeReport = false;
      freezing ??= freeze();
    }
  });
  window.__AEK_TEST__ = {
    version: TEST_BRIDGE_VERSION,
    mode: IS_DEBUG_ENV ? 'DEBUG' : 'PROD_TEST',
    whenSceneReady,
    whenProbeDone,
    freeze,
    snapshot,
  };
};
