import { IS_DEBUG_ENV, IS_PROD_TEST_MODE } from '../core/Config';
import type { DebugModuleRef } from '../utils/helpers';
import { loadDebugModuleAsync, useDebug } from '../utils/helpers';
import type { DebugKeyShortcutsTab } from '../core/Debug/_dbg__DebugKeyShortcuts';

type LightGUIModule = typeof import('../core/Debug/_dbg__DebugTools');
let debugGUI: DebugModuleRef<LightGUIModule> | null = null;
export const DEBUG_CAMERA_ID = '_debugCamera';

export type DebugToolsState = {
  scenesListing: {
    scenesFolderExpanded: boolean;
    useDebugStartScene: boolean;
    debugStartScene: string;
    useDebuggerSceneLoader: boolean;
  };
  loggingActions: {
    loggingFolderExpanded: boolean;
  };
  undoRedo: {
    undoRedoFolderExpanded: boolean;
  };
  /** Replaces the old `prodTestMode` key (migrated on LS load, see _dbg__DebugTools.ts). */
  onScreenTools: {
    showOnScreenToolsInProdTest: boolean;
    /** Makes the on-screen tools, the drawer handle, the stats panel and the axes gizmo
     * click-through and dims them (debug env only). */
    disableOnScreenTools: boolean;
    disabledOnScreenToolsOpacity: number;
  };
  debugCameraFolderExpanded: boolean;
  /** Top-level (not in helpers): hydration replaces a persisted key whole, so a new field
   * inside an existing key would be undefined for anyone with saved state. */
  axesGizmo: {
    show: boolean;
    showInMainCamera: boolean;
  };
  /** Top-level, as axesGizmo. */
  envBall: {
    show: boolean;
    showInMainCamera: boolean;
    roughness: number;
  };
  /** The "File server" folder (p342). Top-level, as axesGizmo. Its default is
   * `AppConfig.devFiles`, and it's saved only once changed in the tab. */
  devFiles: {
    /** See `AppConfig.devFiles.saveHistorySize` (-1 = all, 0 = saving off) */
    saveHistorySize: number;
  };
  helpers: {
    helpersFolderExpanded: boolean;
    showAxesHelper: boolean;
    axesHelperSize: number;
    showGridHelper: boolean;
    gridSize: number;
    gridDivisionsSize: number;
    gridColorCenterLine: number;
    gridColorGrid: number;
    showPolarGridHelper: boolean;
    polarGridRadius: number;
    polarGridSectors: number;
    polarGridRings: number;
    polarGridDivisions: number;
  };
};

const defaultDebugToolsState: DebugToolsState = {
  scenesListing: {
    scenesFolderExpanded: false,
    useDebugStartScene: false,
    debugStartScene: '',
    useDebuggerSceneLoader: false,
  },
  loggingActions: {
    loggingFolderExpanded: false,
  },
  undoRedo: {
    undoRedoFolderExpanded: false,
  },
  onScreenTools: {
    showOnScreenToolsInProdTest: true,
    disableOnScreenTools: false,
    disabledOnScreenToolsOpacity: 0.5,
  },
  debugCameraFolderExpanded: false,
  axesGizmo: {
    show: true,
    showInMainCamera: false,
  },
  envBall: {
    show: true,
    showInMainCamera: false,
    roughness: 0,
  },
  // Outside the debug env saving into `__saveData` is off
  devFiles: {
    saveHistorySize: 0,
  },
  helpers: {
    helpersFolderExpanded: false,
    showAxesHelper: false,
    axesHelperSize: 1,
    showGridHelper: false,
    gridSize: 100,
    gridDivisionsSize: 100,
    gridColorCenterLine: 0x888888,
    gridColorGrid: 0x444444,
    showPolarGridHelper: false,
    polarGridRadius: 10,
    polarGridSectors: 16,
    polarGridRings: 8,
    polarGridDivisions: 16,
  },
};

export const registerDebugToolsModule = async () => {
  if (!IS_DEBUG_ENV && !IS_PROD_TEST_MODE) return;
  // includeInProdTestMode: true — so isProdTest mode can still read the persisted
  // "debug start scene" setting via getDebugToolsState() below (SceneLoader.ts's
  // scene-to-load decision), even though the debug tools UI panel itself
  // (initDebugTools()/_initDebugTools) stays IS_DEBUG_ENV-only and never renders here.
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__DebugTools'), true);
  // Applied here (before the first scene load), not when the tab is built, so the on-screen
  // tools never start out fully visible and clickable
  if (IS_DEBUG_ENV) {
    getDebugToolsState(true);
    useDebug(debugGUI)?._applyOnScreenToolsDisabled();
  }
};

/**
 * Initializes the debug tools (only for debug environments).
 */
export const initDebugTools = () => {
  if (!IS_DEBUG_ENV) return;
  useDebug(debugGUI)?._initDebugTools();
};

/**
 * Getter for the debugToolsState object
 * @param loadFromLS (boolean) optional flag to get the debugToolsState from the LS
 * @returns the Debug tools tab's state, or its defaults while the debug module isn't loaded
 */
export const getDebugToolsState = (loadFromLS?: boolean) =>
  useDebug(debugGUI, true)?._getDebugToolsState(loadFromLS) || defaultDebugToolsState;

/**
 * The axes gizmo shortcut (F10): hides it, or shows it (also in the main camera, when that is
 * active), with a toast. Persisted, and the Debug Tools tab is refreshed if open.
 */
export const toggleAxesGizmo = () => {
  useDebug(debugGUI)?._toggleAxesGizmo();
};

/**
 * The environment ball shortcut (F9): hides it, or shows it (also in the main camera, when that
 * is active), with a toast. Persisted, and the Debug Tools tab is refreshed if open.
 */
export const toggleEnvBall = () => {
  useDebug(debugGUI)?._toggleEnvBall();
};

/**
 * Toggles the "Disable on-screen tools" option (the § shortcut): applied, persisted, the Debug
 * Tools tab is refreshed if open, and a toast is shown. Debug env only.
 * @param keyHint (string) optional readable chord that was pressed, for the toast
 */
export const toggleOnScreenToolsDisabled = (keyHint?: string) => {
  useDebug(debugGUI)?._toggleOnScreenToolsDisabled(keyHint);
};

/**
 * Opens the Debug key shortcuts dialog on a tab, or switches the open dialog to it (the u and i
 * shortcuts, and the Debug Tools tab's buttons). Debug env only.
 * @param tab ('APP' | 'AEKASHA') the tab to show
 */
export const openDebugKeyShortcutsDialog = (tab: DebugKeyShortcutsTab) => {
  useDebug(debugGUI)?._openDebugKeyShortcutsDialog(tab);
};

/**
 * Handles debug camera switching
 */
export const handleDebugCameraSwitch = () => {
  useDebug(debugGUI)?._handleDebugCameraSwitch();
};
