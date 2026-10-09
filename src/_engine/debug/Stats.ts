import type { Renderer } from 'three/webgpu';
import { IS_DEBUG_ENV } from '../core/Config';
import type { DebugModuleRef } from '../utils/helpers';
import { loadDebugModuleAsync, useDebug } from '../utils/helpers';

export type StatsOptions = {
  /** @deprecated Unused: the Statistics tab keeps its folder states in `AEK_debugStatsUI`. */
  performanceFolderExpanded?: boolean;
  /** stats-gl builds its FPS and CPU panels together (only via its own trackFPS), so these two
   * are applied by always building both and detaching the panel afterwards. */
  trackFPS?: boolean;
  trackCPU?: boolean;
  /** Engine-side panel (not stats-gl's): time spent in app logic, as a theoretical FPS. */
  trackTFPS?: boolean;
  trackGPU?: boolean;
  trackCPT?: boolean;
  /** Drawn as a small overlay inside the CPU panel, so it requires trackCPU. */
  trackHz?: boolean;
  logsPerSecond?: number;
  graphsPerSecond?: number;
  samplesLog?: number;
  samplesGraph?: number;
  precision?: number;
  /** @deprecated Unused: the Statistics tab keeps its folder states in `AEK_debugStatsUI`. */
  outlookFolderExpanded?: boolean;
  horizontal?: boolean;
  mode?: number;
  enabled?: boolean;
};

export const defaultStatsOptions = {
  performanceFolderExpanded: true,
  trackFPS: true,
  trackCPU: true,
  trackTFPS: true,
  trackGPU: false,
  trackHz: false,
  trackCPT: false,
  // PHY tracking is deliberately absent here: it lives with the boot-time physics overrides
  // (see _dbg__PhysicsBootOverrides.ts), because physics initializes long before initStats()
  // and so cannot read this. The Statistics tab's "Track PHY" toggle writes there instead.
  outlookFolderExpanded: true,
  horizontal: false,
  enabled: true,
};

type StatsGUIModule = typeof import('../core/Debug/_dbg__Stats');
let debugGUI: DebugModuleRef<StatsGUIModule> | null = null;

export const registerStatsModule = async () => {
  if (!IS_DEBUG_ENV) return;
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__Stats'));
};

/**
 * Initializes statistics for debugging
 * @param config ({@link StatsOptions}) optional configurations for stats
 * @returns ({@link Stats} | null)
 */
export const initStats = (config?: StatsOptions) => useDebug(debugGUI)?._initStats(config);

export const updateRestOfStats = (renderer: Renderer) => {
  useDebug(debugGUI)?._updateRestOfStats(renderer);
};

export const updatePhysicsPanel = (value: number) => {
  useDebug(debugGUI)?._updatePhysicsPanel(value);
};

/** Applies the profiler's "open from stats panels" setting to the stats panels (their pointer and
 * title) and refreshes the Statistics tab's toggle of it. Debug env only. */
export const updateStatsProfilerEntryPoint = () => {
  useDebug(debugGUI)?._applyProfilerEntryPoint();
};

export const startCustomMeasurements = () => {
  useDebug(debugGUI)?._startCustomMeasurements();
};

/**
 * Returns the stats 'stats-gl' instance
 * @returns ({@link Stats} | null)
 */
export const getStats = () => useDebug(debugGUI)?._getStats();

/**
 * Returns the stats configurations
 */
export const getStatsConfig = () => useDebug(debugGUI)?._getStatsConfig();

export const getStatsCmp = () => useDebug(debugGUI)?._getStatsCmp();
