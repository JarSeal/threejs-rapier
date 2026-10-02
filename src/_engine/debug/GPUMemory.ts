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
