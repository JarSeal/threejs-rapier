import { IS_DEBUG_ENV } from '../core/Config';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

type AxesGizmoModule = typeof import('../core/Debug/_dbg__AxesGizmo');
let debugGizmo: DebugModuleRef<AxesGizmoModule> | null = null;

/**
 * Loads the axes gizmo module (debug environments only).
 */
export const registerAxesGizmoModule = async () => {
  if (!IS_DEBUG_ENV) return;
  debugGizmo = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__AxesGizmo'));
};

/**
 * Creates the axes gizmo: a Blender-style orientation gizmo in the top-right corner that
 * follows the active camera (debug environments only).
 * @param opts (object) { show: boolean; showInMainCamera: boolean }
 */
export const initAxesGizmo = (opts: { show: boolean; showInMainCamera: boolean }) => {
  useDebug(debugGizmo)?._initAxesGizmo(opts);
};

/**
 * Shows or hides the axes gizmo (it is only shown while the debug camera is active, unless
 * showInMainCamera is on).
 * @param show (boolean)
 */
export const setAxesGizmoVisible = (show: boolean) => {
  useDebug(debugGizmo)?._setAxesGizmoVisible(show);
};

/**
 * Sets whether the axes gizmo is also shown while the main (gameplay) camera is active.
 * @param show (boolean)
 */
export const setAxesGizmoInMainCamera = (show: boolean) => {
  useDebug(debugGizmo)?._setAxesGizmoInMainCamera(show);
};
