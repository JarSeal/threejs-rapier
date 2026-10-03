import { IS_DEBUG_ENV, IS_PROD_TEST_MODE } from '../core/Config';
import { lsGetItem } from '../utils/LocalAndSessionStorage';
import { loadDebugModuleAsync, useDebug, type DebugModuleRef } from '../utils/helpers';
import {
  hydrateDebuggerTabState,
  type AnyDebuggerTabDef,
  type DebuggerTabDef,
  type UpdateDebuggerTabOpts,
} from './DebuggerGUI';

/** Draggable window id of the profiler. */
export const PROFILER_WINDOW_ID = 'aekProfiler';
/** LocalStorage key of the profiler settings (the Settings tab). */
export const PROFILER_LS_KEY = 'AEK_debugProfiler';
/** LocalStorage key of the profiler UI state: the open tab and the folder states. */
export const PROFILER_UI_LS_KEY = 'AEK_debugProfilerUI';

/** The Overview and Objects refresh rates offered in the Settings tab. */
export const PROFILER_UPDATE_RATES_HZ = [1, 2, 4, 10] as const;

/** One Overview row: its metric id and whether it is shown. */
export type ProfilerOverviewMetricEntry = { id: string; visible: boolean };

export type ProfilerSettings = {
  /** Overview and Objects refresh rate, one of {@link PROFILER_UPDATE_RATES_HZ}. */
  updateRateHz: number;
  /** The Overview rows in order. Unknown ids are dropped and new metrics appended (with their
   * default visibility) when the profiler loads, so a saved list survives new metrics. Empty =
   * the default order. */
  overviewMetrics: ProfilerOverviewMetricEntry[];
  /** Clicking the on-screen stats panels toggles the profiler window. */
  openFromStatsPanels: boolean;
  /** The profiler loads in prodTest mode too: its window stays open over the play button, and
   * the on-screen tools get its button there. Read at boot. */
  enabledInProdTest: boolean;
  /** Time the GPU work of every frame while a profiler view needs it (WebGPU with timestamp
   * queries only). */
  measureGpu: boolean;
};

export const DEFAULT_PROFILER_SETTINGS: Readonly<ProfilerSettings> = {
  updateRateHz: 4,
  overviewMetrics: [],
  openFromStatsPanels: true,
  enabledInProdTest: false,
  measureGpu: true,
};

type ProfilerModule = typeof import('../core/Debug/Profiler/_dbg__Profiler');
let profiler: DebugModuleRef<ProfilerModule> | null = null;

const useProfiler = () => useDebug(profiler, true);

/**
 * Whether the profiler is enabled in prodTest mode (its stored setting). Read straight from LS,
 * because it decides whether the profiler module loads there at all.
 * @returns boolean
 */
export const isProfilerEnabledInProdTest = () => {
  const saved = lsGetItem(PROFILER_LS_KEY, {}) as Partial<ProfilerSettings> | null;
  return Boolean(saved?.enabledInProdTest);
};

let isProfilerMode: boolean | null = null;

/** Whether this mode loads the profiler (see {@link registerProfiler}). Read once. */
const isProfilerLoadedInThisMode = () => {
  if (isProfilerMode === null) {
    isProfilerMode = IS_DEBUG_ENV || (IS_PROD_TEST_MODE && isProfilerEnabledInProdTest());
  }
  return isProfilerMode;
};

/**
 * Loads the profiler: in the debug environment, and in prodTest mode when it is enabled there
 * ({@link ProfilerSettings.enabledInProdTest}). Call before the draggable windows are restored
 * from LS, so an open profiler window gets its content.
 */
export const registerProfiler = async () => {
  if (!isProfilerLoadedInThisMode()) return;
  profiler = await loadDebugModuleAsync(
    () => import('../core/Debug/Profiler/_dbg__Profiler'),
    true,
    'Profiler'
  );
};

/**
 * Whether the profiler is loaded in this mode (see {@link registerProfiler}).
 * @returns boolean
 */
export const isProfilerAvailable = () => Boolean(useProfiler());

/** Opens the profiler window and brings it to the front, or closes it when it is on top. */
export const toggleProfilerWindow = () => {
  useProfiler()?._toggleProfilerWindow();
};

/**
 * Whether the profiler window is open (its content is mounted).
 * @returns boolean
 */
export const isProfilerWindowOpen = () => useProfiler()?._isProfilerWindowOpen() ?? false;

/**
 * Creates (or replaces, by id) a profiler window tab. The same {@link DebuggerTabDef} contract as
 * `createDebuggerTab`, so a tab can move between the drawer and the profiler by changing this
 * call. Ordered by `orderNr`, then registration order. Profiler tabs have no `sceneId`.
 * @param def (object) tab definition {@link DebuggerTabDef}
 */
export const createProfilerTab = <S extends object>(def: DebuggerTabDef<S>) => {
  hydrateDebuggerTabState(def);
  // The builder only works with string keys, S only types the call site
  useProfiler()?._createProfilerTab(def as unknown as AnyDebuggerTabDef);
};

/**
 * Opens the profiler window on a tab (switching to it if another one is showing).
 * @param id (string) tab id
 */
export const openProfilerTab = (id: string) => {
  useProfiler()?._openProfilerTab(id);
};

/**
 * Refreshes a profiler tab, but only if it is the visible one (see {@link isProfilerTabOpen}).
 * @param id (string) tab id
 * @param opts (object) optional {@link UpdateDebuggerTabOpts}
 */
export const updateProfilerTab = (id: string, opts?: UpdateDebuggerTabOpts) => {
  useProfiler()?._updateProfilerTab(id, opts);
};

/**
 * Whether a profiler tab is visible: the window is open and the tab is the mounted one.
 * @param id (string) tab id
 * @returns boolean
 */
export const isProfilerTabOpen = (id: string) => useProfiler()?._isProfilerTabOpen(id) ?? false;

/**
 * The profiler settings (the live object the Settings tab binds to). Undefined while the profiler
 * isn't loaded.
 * @returns ({@link ProfilerSettings} | undefined)
 */
export const getProfilerSettings = (): Readonly<ProfilerSettings> | undefined =>
  useProfiler()?._getProfilerSettings();

/**
 * Changes profiler settings: persists them and applies them right away (the stats panels'
 * pointer, the on-screen button, an open Settings tab).
 * @param partial (object) the settings to change {@link ProfilerSettings}
 */
export const setProfilerSettings = (partial: Partial<ProfilerSettings>) => {
  useProfiler()?._setProfilerSettings(partial);
};

// STATS SOURCES (§2.5)

/**
 * A measurement the profiler views read. It is refcounted: `acquire` runs when the first view
 * needs it (and it is available), `release` when the last one is done, so a closed profiler
 * measures nothing.
 */
export type StatsSource<T = unknown> = {
  /** Unique; registering the same id again replaces the source. */
  id: string;
  label: string;
  /** Turns the measurement on. Only switch on what is off, and remember it for `release`. */
  acquire?: () => void;
  /** Turns off what `acquire` switched on (leave alone what was already on). */
  release?: () => void;
  /** The current value, called only at the profiler's update rate. Null = no value yet. */
  read: () => T | null;
  /** True, or why the source is n/a right now ("WebGPU only", "Chromium only"). While it is n/a
   * the source is not acquired (an acquired one is released), and it is acquired as soon as it
   * becomes available. */
  availability?: () => true | string;
};

type AnyStatsSource = StatsSource<unknown>;

const statsSources = new Map<string, AnyStatsSource>();

/**
 * Registers a stats source the profiler views can read (eg. a streaming system's figures). A
 * no-op where the profiler doesn't load (see {@link registerProfiler}).
 * @param source ({@link StatsSource})
 * @returns a function that removes the source
 */
export const registerStatsSource = <T>(source: StatsSource<T>) => {
  if (!isProfilerLoadedInThisMode()) return () => {};
  const anySource = source as AnyStatsSource;
  const prev = statsSources.get(source.id);
  statsSources.set(source.id, anySource);
  if (prev) useProfiler()?._onStatsSourceReplaced(prev);
  return () => {
    if (statsSources.get(source.id) !== anySource) return;
    statsSources.delete(source.id);
    useProfiler()?._onStatsSourceReplaced(anySource);
  };
};

/** @internal The registered stats sources (the profiler). */
export const _getStatsSources = (): ReadonlyMap<string, AnyStatsSource> => statsSources;
