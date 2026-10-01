import { IS_DEBUG_ENV } from '../core/Config';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';
import type { EnvBallOpts } from '../core/Debug/_dbg__EnvBall';

type EnvBallModule = typeof import('../core/Debug/_dbg__EnvBall');
let debugEnvBall: DebugModuleRef<EnvBallModule> | null = null;

/**
 * Loads the environment ball module (debug environments only).
 */
export const registerEnvBallModule = async () => {
  if (!IS_DEBUG_ENV) return;
  debugEnvBall = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__EnvBall'));
};

/**
 * Creates the environment ball: a reflective sphere left of the axes gizmo, showing the
 * environment map PBR materials sample and following the active camera (debug environments
 * only).
 * @param opts (object) { show: boolean; showInMainCamera: boolean; roughness: number }
 */
export const initEnvBall = (opts: EnvBallOpts) => {
  useDebug(debugEnvBall)?._initEnvBall(opts);
};

/**
 * Shows or hides the environment ball (it is only shown while the debug camera is active,
 * unless showInMainCamera is on, and only while there is an environment).
 * @param show (boolean)
 */
export const setEnvBallVisible = (show: boolean) => {
  useDebug(debugEnvBall)?._setEnvBallVisible(show);
};

/**
 * Sets whether the environment ball is also shown while the main (gameplay) camera is active.
 * @param show (boolean)
 */
export const setEnvBallInMainCamera = (show: boolean) => {
  useDebug(debugEnvBall)?._setEnvBallInMainCamera(show);
};

/**
 * Sets the roughness the environment ball samples the environment at (0 = mirror, 1 = fully
 * diffuse).
 * @param roughness (number) 0-1
 */
export const setEnvBallRoughness = (roughness: number) => {
  useDebug(debugEnvBall)?._setEnvBallRoughness(roughness);
};
