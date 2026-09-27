import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

let debugGUI: DebugModuleRef<typeof import('../core/Debug/_dbg__Assets')> | null = null;

/** Creates the Assets debugger tab (loaded textures and geometries, incl. imported ones). The
 * implementation is only loaded in debug builds. */
export const createAssetsDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__Assets'));
  useDebug(debugGUI)?._createAssetsDebugGUI();
};
