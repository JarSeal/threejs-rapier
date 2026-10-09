import type * as THREE from 'three/webgpu';
import type { DebugModuleRef } from '../utils/helpers';
import { loadDebugModuleAsync, useDebug } from '../utils/helpers';
import { isProfilerLoadedInThisMode } from './Profiler';

/** Profiler window tab id of the GPU memory and draw-call tab. */
export const GPU_MEMORY_TAB_ID = 'gpuMemory';

let debugGUI: DebugModuleRef<typeof import('../core/Debug/_dbg__GPUMemory')> | null = null;

/** Creates the profiler's GPU memory tab (three's GPU memory bookkeeping, draw calls) and its
 * per-frame sampler. The implementation is only loaded where the profiler is: the debug env, and
 * prodTest mode when the profiler is enabled there. Call after `registerProfiler` (the tab needs
 * the profiler) and before the renderer is created (the allocation tracker). */
export const registerGPUMemoryDebugGUI = async () => {
  if (!isProfilerLoadedInThisMode()) return;
  debugGUI = await loadDebugModuleAsync(
    () => import('../core/Debug/_dbg__GPUMemory'),
    true,
    'GPU memory'
  );
  useDebug(debugGUI, true)?._createGPUMemoryDebugGUI();
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
 * GPU memory tab can list them and take them out of "untracked". A no-op where the profiler
 * doesn't load (outside the debug env, unless it is enabled in prodTest mode).
 * @returns a function that removes the source
 */
export const registerGPUMemorySource = (source: GPUMemorySource) => {
  if (!isProfilerLoadedInThisMode()) return () => {};
  sources.set(source.id, source);
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
  };
};

/** @internal The registered sources (the GPU memory tab). */
export const _getGPUMemorySources = (): ReadonlyMap<string, GPUMemorySource> => sources;
