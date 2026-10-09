// The scene runner's test bridge (p601), `window.__AEK_TEST__`: public entry and types in
// `debug/TestBridge.ts`. Loads in the debug env and prod test mode, only with `?aekTest=true`.
// Console and page errors aren't collected here: the logger is the console, and the runner's
// browser listeners see everything from the first script on, before this can install.

import { IS_DEBUG_ENV } from '../Config';
import { toggleAppPlay, toggleMainPlay } from '../MainLoop';
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

/** The latest probe report per scene id (a page load probes one scene, a revisit replaces it) */
const probeReports = new Map<string, PhysicsProbeReport>();

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
  const report = await pollFrames(() => {
    const sceneId = getCurrentSceneId();
    return (sceneId && probeReports.get(sceneId)) || null;
  }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!report) {
    return { status: 'TIMEOUT', sceneId: getCurrentSceneId() ?? null };
  }
  return { status: 'DONE', ...report };
};

const freeze = () => {
  toggleAppPlay(false);
  pauseDayNight();
  toggleMainPlay(false);
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
  onPhysicsProbeReport((report) => probeReports.set(report.sceneId, report));
  window.__AEK_TEST__ = {
    version: TEST_BRIDGE_VERSION,
    mode: IS_DEBUG_ENV ? 'DEBUG' : 'PROD_TEST',
    whenSceneReady,
    whenProbeDone,
    freeze,
    snapshot,
  };
};
