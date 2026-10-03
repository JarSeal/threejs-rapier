import type * as THREE from 'three/webgpu';
import { IS_DEBUG_ENV } from '../core/Config';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

/** Debugger drawer tab id of the GPU memory and draw-call tab. */
export const GPU_MEMORY_TAB_ID = 'gpuMemoryControls';

let debugGUI: DebugModuleRef<typeof import('../core/Debug/_dbg__GPUMemory')> | null = null;

/** Creates the GPU memory debugger tab (three's GPU memory bookkeeping, draw calls) and its
 * per-frame sampler. The implementation is only loaded in debug builds. */
export const registerGPUMemoryDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__GPUMemory'));
  useDebug(debugGUI)?._createGPUMemoryDebugGUI();
};

// Sources (p345 §2.3)

/**
 * A GPU-backed object a source holds. Its bytes are three's own (`renderer.info`): a render
 * target counts its textures (an internal depth buffer too), a geometry its attributes and index,
 * and an attribute every buffer three made from its array (eg. the instance attributes an
 * `InstancedMesh`'s `instanceMatrix` is read through).
 */
export type GPUMemoryResource =
  | THREE.Texture
  | THREE.RenderTarget
  | THREE.BufferGeometry
  | THREE.BufferAttribute
  | THREE.InterleavedBufferAttribute;

export type GPUMemorySource = {
  /** Unique; registering the same id again replaces the source. */
  id: string;
  label: string;
  /** The objects it holds now. Called only while the GPU memory tab refreshes. */
  getResources: () => Iterable<GPUMemoryResource | null | undefined>;
  /** An AssetOwners key (a scene id, later `sceneId#cellKey`), or a function for one that
   * changes (eg. the current scene). Without one, the source is listed under "engine". */
  owner?: string | (() => string | null | undefined);
};

const sources = new Map<string, GPUMemorySource>();

/**
 * Names GPU resources that aren't registered assets (render targets, instance buffers), so the
 * GPU memory tab can list them and take them out of "untracked". A no-op outside the debug env.
 * @returns a function that removes the source
 */
export const registerGPUMemorySource = (source: GPUMemorySource) => {
  if (!IS_DEBUG_ENV) return () => {};
  sources.set(source.id, source);
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
  };
};

/** @internal The registered sources (the GPU memory tab). */
export const _getGPUMemorySources = (): ReadonlyMap<string, GPUMemorySource> => sources;
