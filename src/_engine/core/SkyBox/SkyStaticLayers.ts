import * as THREE from 'three/webgpu';
import { positionLocal } from 'three/tsl';
import { getRenderer } from '../Renderer';
import type { SkyBoxNebulaSize } from './SkyBoxTypes';

/**
 * Static layers (p114): sky layers that only change when their params do (the nebulae), baked
 * into a HalfFloat cube once per change and sampled with one cube lookup per pixel
 * (SkyComposite.ts), in the view and in the env bake. They sit at infinity in their own frame, which turns with the
 * sky (the sidereal rotation) as a lookup rotation, so moving the sky never re-bakes them.
 *
 * Bakes run from skyBoxSystem, before the env bake of the same tick (which samples the cube),
 * never while a scene loads: a structural one on the next tick, a param change's throttled.
 */

export type StaticLayersResolution = SkyBoxNebulaSize;

/** What the cube holds. */
export type StaticLayersSource = {
  resolution: StaticLayersResolution;
  /** The layers in direction `dir` (the static layers' own frame): the colour (rgb) and the
   * star boost mask (a, see layers/stars.ts). */
  build: (dir: THREE.Node<'vec3'>) => THREE.Node<'vec4'>;
};

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
  /** Private: holds only `mesh`. */
  scene: THREE.Scene;
  /** A back-side unit sphere around the camera that draws the source. Not the scene's
   * backgroundNode: the background material is opaque, and three writes alpha 1 for opaque
   * materials, which would drop the star boost mask. */
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.NodeMaterial>;
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

/**
 * The mesh that draws `source`. Its fragments' interpolated local positions, normalized, are
 * exactly each pixel's direction from the centre (the cube camera sits there). No blending, so
 * the source's alpha is written as is.
 */
const createSourceMesh = (source: StaticLayersSource) => {
  const material = new THREE.NodeMaterial();
  material.name = 'SkyBox.staticLayersMaterial';
  material.side = THREE.BackSide;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  material.fog = false;
  material.lights = false;
  material.colorNode = source.build(positionLocal.normalize());
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
  mesh.frustumCulled = false;
  mesh.name = 'SkyBox.staticLayersMesh';
  return mesh;
};

const disposeMesh = (mesh: THREE.Mesh<THREE.SphereGeometry, THREE.NodeMaterial>) => {
  mesh.removeFromParent();
  mesh.geometry.dispose();
  mesh.material.dispose();
};

/**
 * The static-layer bake of `source`, with a bake requested for the next tick. Keeps the
 * current target and camera when the resolution is the same (only the source mesh is
 * replaced); a new resolution replaces both (the composite that samples the old target is
 * rebuilt by the caller).
 */
export const setStaticLayers = (source: StaticLayersSource): StaticLayersBake => {
  if (bake && bake.resolution !== source.resolution) disposeStaticLayers();
  const mesh = createSourceMesh(source);
  if (!bake) {
    const renderer = getRenderer();
    const target = createTarget(source.resolution);
    if (renderer) initTarget(renderer as THREE.Renderer, target);
    const scene = new THREE.Scene();
    scene.name = 'SkyBox.staticLayersScene';
    bake = {
      resolution: source.resolution,
      target,
      camera: new THREE.CubeCamera(0.1, 100, target),
      scene,
      mesh,
    };
  } else {
    disposeMesh(bake.mesh);
    bake.mesh = mesh;
  }
  bake.scene.add(mesh);
  request = 'NOW';
  return bake;
};

/** Disposes the static-layer target and source mesh. */
export const disposeStaticLayers = () => {
  request = null;
  if (!bake) return;
  disposeMesh(bake.mesh);
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
