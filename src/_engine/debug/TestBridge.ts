import { IS_DEBUG_ENV, IS_PROD_TEST_MODE } from '../core/Config';
import { loadDebugModuleAsync, useDebug } from '../utils/helpers';
import type { PhysicsProbeReport } from '../core/Debug/_dbg__PhysicsDeterminism';

/** The URL param that installs the test bridge: `?aekTest=true`, next to `?isDebug=true` or `?isProdTest=true` */
export const TEST_BRIDGE_QUERY_PARAM = 'aekTest';

/** The bridge's protocol version: bump it when a method's arguments or results change */
export const TEST_BRIDGE_VERSION = 1;

export type TestBridgeSceneReady =
  /** `backend`: what the renderer runs on (WebGPU falls back to WebGL2 without `navigator.gpu`) */
  | { status: 'READY'; sceneId: string; backend: 'WEBGPU' | 'WEBGL' }
  | { status: 'TIMEOUT'; sceneId: string | null };

export type TestBridgeProbeResult =
  | ({ status: 'DONE' } & PhysicsProbeReport)
  /** The probe isn't armed (no `?physicsProbe=N`, or prod test mode, where it doesn't load) */
  | { status: 'NOT_ARMED' }
  /** No report for the current scene in time (eg. a scene whose physics doesn't step) */
  | { status: 'TIMEOUT'; sceneId: string | null };

export type TestBridgeSnapshot = {
  width: number;
  height: number;
  /** A PNG of the snapshot's RGBA8 pixels, byte exact, base64 encoded */
  pngBase64: string;
  /** Whether it went through the scene's PostFX pipeline */
  postFx: boolean;
};

/**
 * `window.__AEK_TEST__`: what the scene runner (`devTools/verify/scenes.ts`, p601) drives a page
 * through. Every method is safe to call more than once.
 */
export type AekTestBridge = {
  version: number;
  mode: 'DEBUG' | 'PROD_TEST';
  /** Resolves once the first scene has loaded: its load finished and the physics hold released,
   * plus two rendered frames */
  whenSceneReady: (opts?: { timeoutMs?: number }) => Promise<TestBridgeSceneReady>;
  /** Resolves with the determinism probe's report for the current scene, once the probe has
   * frozen physics at its step. Freeze only after it: a paused app loop never reaches the step. */
  whenProbeDone: (opts?: { timeoutMs?: number }) => Promise<TestBridgeProbeResult>;
  /** Pauses the app and master loops and the day-night cycle, so a snapshot doesn't depend on
   * timing. TSL's `time` node keeps running (three updates it per render). */
  freeze: () => void;
  /** `takeSnapshotAsync` of what the canvas shows (debug helpers hidden, PostFX included) */
  snapshot: (opts: { width: number; height: number }) => Promise<TestBridgeSnapshot>;
};

declare global {
  interface Window {
    __AEK_TEST__?: AekTestBridge;
  }
}

/**
 * Installs `window.__AEK_TEST__` ({@link AekTestBridge}) when the page has `?aekTest=true`, in the
 * debug env and prod test mode only (never in a production build). Before the first scene load.
 */
export const registerTestBridge = async () => {
  if (!IS_DEBUG_ENV && !IS_PROD_TEST_MODE) return;
  if (new URLSearchParams(window.location.search).get(TEST_BRIDGE_QUERY_PARAM) !== 'true') return;
  const bridge = await loadDebugModuleAsync(
    () => import('../core/Debug/_dbg__TestBridge'),
    true,
    'TestBridge'
  );
  useDebug(bridge, true)?._installTestBridge();
};
