import * as THREE from 'three/webgpu';
import { getRenderer } from '../Renderer';

/**
 * Static layers (p114): sky layers that only change when their params do (nebulae), baked into
 * a HalfFloat cube once per change and sampled with one cube lookup per pixel (SkyComposite.ts),
 * in the view and in the env bake. They sit at infinity in their own frame, which turns with the
 * sky (the sidereal rotation) as a lookup rotation, so moving the sky never re-bakes them.
 *
 * Bakes run from skyBoxSystem, before the env bake of the same tick (which samples the cube),
 * never while a scene loads: a structural one on the next tick, a param change's throttled.
 */

export type StaticLayersResolution = 256 | 512 | 1024;

/** What the cube holds, and how the composite shows it. */
export type StaticLayersSource = {
  resolution: StaticLayersResolution;
  /** The layers' colour in direction `dir` (the static layers' own frame). */
  build: (dir: THREE.Node<'vec3'>) => THREE.Node<'vec3'>;
  /** Debug only (the p114 Phase 1 test harness): BAKED samples the cube (the real path), LIVE
   * evaluates `build` per pixel, DIFF shows |baked − live| × 10 in place of the sky behind. The
   * env bake always samples the cube. Default BAKED. */
  view?: 'BAKED' | 'LIVE' | 'DIFF';
};

export const STATIC_LAYERS_DEFAULT_RESOLUTION: StaticLayersResolution = 512;
/** A param change's bake: at most one per this many ms (the latest request always runs, so a
 * drag ends on its final value). */
export const STATIC_LAYERS_THROTTLE_MS = 150;
/** RGBA HalfFloat, no mipmaps. */
const BYTES_PER_TEXEL = 8;

/** The cube's GPU memory at a resolution (6 faces, no mipmaps). */
export const getStaticLayersMemoryBytes = (resolution: StaticLayersResolution) =>
  resolution * resolution * 6 * BYTES_PER_TEXEL;

/** The active composite sky box's static-layer bake. The target and camera live as long as the
 * resolution stays the same; the scene's background is replaced on every node rebuild. */
export type StaticLayersBake = {
  resolution: StaticLayersResolution;
  target: THREE.CubeRenderTarget;
  camera: THREE.CubeCamera;
  /** Private: holds only the layers' source as its backgroundNode. */
  scene: THREE.Scene;
};

let bake: StaticLayersBake | null = null;
/** NOW: on the next tick. THROTTLED: once STATIC_LAYERS_THROTTLE_MS has passed since the last
 * bake. */
let request: 'NOW' | 'THROTTLED' | null = null;
let lastBakeMs = -Infinity;

/** @internal Debug hooks around every bake (the static layers folder's stats). */
export type StaticLayersBakeHooks = { onBakeStart: () => void; onBakeEnd: (cpuMs: number) => void };
let bakeHooks: StaticLayersBakeHooks | null = null;
export const _setStaticLayersBakeHooks = (hooks: StaticLayersBakeHooks | null) => {
  bakeHooks = hooks;
};

// Source. Until nebulae exist (p114 Phase 2), the only source is the debug test layer.

let testSource: StaticLayersSource | null = null;

/** @internal The debug test layer (set by the static layers folder, session only). SkyBox.ts's
 * `_setStaticLayersTest` sets it and rebuilds the active sky box. */
export const _setStaticLayersTestSource = (source: StaticLayersSource | null) => {
  testSource = source;
};

/** A sky box's static layers, or null when it has none. */
export const getStaticLayersSource = (): StaticLayersSource | null => testSource;

// Target

const createTarget = (resolution: StaticLayersResolution) => {
  const target = new THREE.CubeRenderTarget(resolution, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    generateMipmaps: false,
    // The background mesh neither tests nor writes depth
    depthBuffer: false,
  });
  target.texture.name = 'SkyBox.staticLayers';
  return target;
};

/**
 * Sets up a new target's GPU texture now, by clearing every face (a clear runs three's render
 * target setup, as a render would). The cube is sampled for the whole scene load, and bakes wait
 * for the load to end: without this, the first bake destroys the placeholder GPU texture the
 * bind groups already sample (the env bake target has the same fix, see SkyEnvironment.ts).
 */
const initTarget = (renderer: THREE.Renderer, target: THREE.CubeRenderTarget) => {
  if (!renderer.hasInitialized()) return;
  const prevTarget = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace();
  const prevLevel = renderer.getActiveMipmapLevel();
  for (let face = 0; face < 6; face++) {
    renderer.setRenderTarget(target, face);
    renderer.clear();
  }
  renderer.setRenderTarget(prevTarget, prevFace, prevLevel);
};

const disposeBakeScene = (scene: THREE.Scene) => {
  // Background.js disposes the background mesh (material and geometry) with its node
  scene.backgroundNode?.dispose();
  scene.backgroundNode = null;
};

/**
 * The static-layer bake for `resolution`, with `source` (the layers' node, on
 * normalWorldGeometry) as what it bakes, and a bake requested for the next tick. Keeps the
 * current target and camera when the resolution is the same; a new resolution replaces both
 * (the composite that samples the old target is rebuilt by the caller).
 */
export const setStaticLayers = (
  resolution: StaticLayersResolution,
  source: THREE.Node
): StaticLayersBake => {
  if (bake && bake.resolution !== resolution) disposeStaticLayers();
  if (!bake) {
    const renderer = getRenderer();
    const target = createTarget(resolution);
    if (renderer) initTarget(renderer as THREE.Renderer, target);
    bake = {
      resolution,
      target,
      camera: new THREE.CubeCamera(0.1, 100, target),
      scene: new THREE.Scene(),
    };
  } else {
    disposeBakeScene(bake.scene);
    bake.scene = new THREE.Scene();
  }
  bake.scene.name = 'SkyBox.staticLayersScene';
  bake.scene.backgroundNode = source;
  request = 'NOW';
  return bake;
};

/** Disposes the static-layer target and bake scene. */
export const disposeStaticLayers = () => {
  request = null;
  if (!bake) return;
  disposeBakeScene(bake.scene);
  bake.target.dispose();
  bake = null;
};

/** The active static-layer bake, or null (no static layers, or no composite sky box). */
export const getStaticLayers = () => bake;

/**
 * Asks for a bake: on the next tick, or `throttled` (a param change) at most once per
 * STATIC_LAYERS_THROTTLE_MS. A pending unthrottled request stays unthrottled. A no-op without
 * static layers.
 */
export const requestStaticLayersBake = (throttled = false) => {
  if (!bake) return;
  if (request !== 'NOW') request = throttled ? 'THROTTLED' : 'NOW';
};

/** Bakes the static layers now, if a bake is requested and due (called by skyBoxSystem, before
 * the env bake).
 * @returns whether it baked */
export const runRequestedStaticLayersBake = () => {
  if (!request || !bake) return false;
  const now = performance.now();
  if (request === 'THROTTLED' && now - lastBakeMs < STATIC_LAYERS_THROTTLE_MS) return false;
  const renderer = getRenderer();
  if (!renderer?.hasInitialized()) return false;
  request = null;
  lastBakeMs = now;
  bakeHooks?.onBakeStart();
  bake.camera.update(renderer as THREE.Renderer, bake.scene);
  bakeHooks?.onBakeEnd(performance.now() - now);
  return true;
};
