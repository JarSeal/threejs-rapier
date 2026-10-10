import * as THREE from 'three/webgpu';
import { pmremTexture } from 'three/tsl';
import { getRenderer } from '../Renderer';
import type { SkyBoxEnvSize } from './SkyBoxTypes';

/** Baked PMREMs by source texture, disposed with the source texture. */
const pmrems = new WeakMap<THREE.Texture, { target: THREE.RenderTarget; version: number }>();

/** Same checks as PMREMNode's (isEquirectangularMapReady / isCubeMapReady). */
export const isPMREMSourceReady = (texture: THREE.Texture) => {
  const image = texture.image as { height?: number; [index: number]: unknown } | null | undefined;
  if (!image) return false;
  if ((texture as THREE.CubeTexture).isCubeTexture) {
    for (let i = 0; i < 6; i++) if (image[i] === undefined) return false;
    return true;
  }
  return (image.height || 0) > 0;
};

/**
 * The texture to give pmremTexture(): a PMREM baked here (once per source texture and PMREM
 * version), disposed when its source texture is disposed. A PMREMNode given the source texture
 * itself bakes it with a PMREMGenerator of its own, and nothing ever disposes either. A source
 * that isn't ready (eg. a failed load) is returned as is, for PMREMNode to bake once it is.
 */
export const getPMREMTexture = (texture: THREE.Texture) => {
  const renderer = getRenderer();
  if (!renderer || !isPMREMSourceReady(texture)) return texture;
  const cached = pmrems.get(texture);
  if (cached?.version === texture.pmremVersion) return cached.target.texture;

  // A generator per bake, disposed right after: its working set (a ping-pong target as large as
  // the PMREM, LOD planes, blur materials) would otherwise stay on the GPU. Before the renderer
  // has initialized, the generator bakes asynchronously, so it can't be disposed here.
  const generator = new THREE.PMREMGenerator(renderer);
  const target = (texture as THREE.CubeTexture).isCubeTexture
    ? generator.fromCubemap(texture, cached?.target)
    : generator.fromEquirectangular(texture, cached?.target);
  if (renderer.hasInitialized()) generator.dispose();
  if (!cached) {
    const onDispose = () => {
      texture.removeEventListener('dispose', onDispose);
      pmrems.get(texture)?.target.dispose();
      pmrems.delete(texture);
    };
    texture.addEventListener('dispose', onDispose);
  }
  pmrems.set(texture, { target, version: texture.pmremVersion });
  return target.texture;
};

// Env bake: a composite sky box's environment (fromScene into a fixed target, p112)

/**
 * The active composite sky box's bake resources. The target and generator live as long as the
 * activation (and its size); the scene is replaced on every node rebuild.
 */
export type EnvBake = {
  size: SkyBoxEnvSize;
  /** The PMREM (CubeUV) target every bake re-renders. */
  target: THREE.RenderTarget;
  /** `pmremTexture(target.texture)`: the root scene's environmentNode. Created with the target,
   * and never re-pointed (a `.value` swap to a new target left stale bindings on WebGL2). */
  environmentNode: THREE.Node;
  /** Long-lived: its working set (ping-pong target, LOD planes, GGX material) is reused while
   * the size stays the same. */
  generator: THREE.PMREMGenerator;
  /** Private: holds only the ENV_BAKE composite as its backgroundNode. */
  scene: THREE.Scene;
};

let envBake: EnvBake | null = null;
let isBakeRequested = false;

/**
 * Debug hooks around every bake (the Environment folder's stats).
 * @internal
 */
export type EnvBakeHooks = { onBakeStart: () => void; onBakeEnd: (cpuMs: number) => void };
let bakeHooks: EnvBakeHooks | null = null;
export const _setEnvBakeHooks = (hooks: EnvBakeHooks | null) => {
  bakeHooks = hooks;
};

/**
 * A CubeUV target like the one `PMREMGenerator.fromScene` allocates for `size` (`_allocateTarget`
 * and `_createRenderTarget` in PMREMGenerator.js, three r186). Allocated here, not by the first
 * bake, so the environment node exists from activation on: activation runs while the scene
 * loads, and bakes never do.
 */
const createEnvBakeTarget = (size: SkyBoxEnvSize) => {
  const cubeSize = 2 ** Math.floor(Math.log2(size));
  const target = new THREE.RenderTarget(3 * Math.max(cubeSize, 16 * 7), 4 * cubeSize, {
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    generateMipmaps: false,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true,
  });
  target.texture.mapping = THREE.CubeUVReflectionMapping;
  target.texture.name = 'SkyBox.envBake';
  // What makes pmremTexture() sample it as is (the types don't declare the flag)
  (target.texture as THREE.Texture & { isPMREMTexture: boolean }).isPMREMTexture = true;
  target.scissorTest = true;
  return target;
};

/**
 * Sets up a new target's GPU texture now, by clearing it (a clear runs three's render target
 * setup, as a render would). Without it, the target is first sampled (by every lit material,
 * for the whole scene load: bakes wait for it to end) before anything renders into it, so three
 * gives it a placeholder GPU texture, and the first bake's render target setup destroys that
 * one in place (Textures.updateTexture, three r186) without invalidating the bind groups that
 * sample it: a "Destroyed texture used in a submit" on every frame after that (WebGPU).
 */
const initEnvBakeTarget = (renderer: THREE.Renderer, target: THREE.RenderTarget) => {
  if (!renderer.hasInitialized()) return;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.setRenderTarget(prevTarget);
};

const disposeBakeScene = (scene: THREE.Scene) => {
  // Background.js disposes the scene's background mesh (material and geometry) when the node
  // it was built with is disposed. Each bake scene only ever has one node.
  scene.backgroundNode?.dispose();
  scene.backgroundNode = null;
};

/**
 * The env bake for `size`, with `source` (the ENV_BAKE composite) as what it bakes, and a bake
 * requested. Keeps the current target, generator and environment node when the size is the
 * same; a new size replaces all three (one lit-material rebuild).
 */
export const setEnvBake = (size: SkyBoxEnvSize, source: THREE.Node): EnvBake => {
  const renderer = getRenderer();
  if (envBake && envBake.size !== size) disposeEnvBake();
  if (!envBake) {
    const target = createEnvBakeTarget(size);
    if (renderer) initEnvBakeTarget(renderer as THREE.Renderer, target);
    envBake = {
      size,
      target,
      environmentNode: pmremTexture(target.texture),
      generator: new THREE.PMREMGenerator(renderer as THREE.Renderer),
      scene: new THREE.Scene(),
    };
  } else {
    disposeBakeScene(envBake.scene);
    envBake.scene = new THREE.Scene();
  }
  envBake.scene.name = 'SkyBox.envBakeScene';
  envBake.scene.backgroundNode = source;
  isBakeRequested = true;
  return envBake;
};

/** Disposes the env bake's target, generator and bake scene. Texture PMREMs (getPMREMTexture)
 * are not touched: they belong to their source textures. */
export const disposeEnvBake = () => {
  isBakeRequested = false;
  if (!envBake) return;
  disposeBakeScene(envBake.scene);
  envBake.generator.dispose();
  envBake.target.dispose();
  envBake = null;
};

/** The active env bake, or null (direct path, or no sky box). */
export const getEnvBake = () => envBake;

/** Asks for a bake on the next sky box system tick (at most one per frame, never while a scene
 * loads). A no-op without an env bake. */
export const requestEnvBake = () => {
  if (envBake) isBakeRequested = true;
};

export const isEnvBakeRequested = () => isBakeRequested;

/** Bakes the environment now, if one is requested (called by skyBoxSystem).
 * @returns whether it baked */
export const runRequestedEnvBake = () => {
  isBakeRequested = false;
  const renderer = getRenderer();
  if (!envBake || !renderer?.hasInitialized()) return false;
  bakeHooks?.onBakeStart();
  const start = performance.now();
  envBake.generator.fromScene(envBake.scene, 0, 0.1, 100, {
    size: envBake.size,
    renderTarget: envBake.target,
  });
  bakeHooks?.onBakeEnd(performance.now() - start);
  return true;
};
