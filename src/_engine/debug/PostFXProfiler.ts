import { getConfig, IS_DEBUG_ENV } from '../core/Config';
import type { DebugModuleRef } from '../utils/helpers';
import { loadDebugModuleAsync, useDebug } from '../utils/helpers';

type PostFxProfilerModule = typeof import('../core/Debug/_dbg__PostFXProfiler');
let profiler: DebugModuleRef<PostFxProfilerModule> | null = null;

/** Loads the PostFX profiler (debug only), and starts measuring if AppConfig.postFx.measureEnabled is set. */
export const registerPostFxProfiler = async () => {
  if (!IS_DEBUG_ENV) return;
  if (!profiler) {
    profiler = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__PostFXProfiler'));
  }
  if (getConfig().postFx?.measureEnabled) useDebug(profiler)?._setPostFxMeasureEnabled(true);
};

/**
 * Switches PostFX per-pass measuring on or off, live (debug only). See getPostFxPassStats().
 * @param enabled (boolean)
 */
export const setPostFxMeasureEnabled = async (enabled: boolean) => {
  if (!IS_DEBUG_ENV) return;
  if (!profiler) {
    profiler = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__PostFXProfiler'));
  }
  useDebug(profiler)?._setPostFxMeasureEnabled(enabled);
};

/**
 * Whether PostFX per-pass measuring is on.
 * @returns boolean
 */
export const isPostFxMeasureEnabled = () => useDebug(profiler)?._isPostFxMeasureEnabled() || false;

/**
 * Returns the smoothed per-PostFX pass CPU and GPU times (`PostFxStats`), or null when not
 * measuring.
 */
export const getPostFxPassStats = () => useDebug(profiler)?._getPostFxPassStats() || null;
