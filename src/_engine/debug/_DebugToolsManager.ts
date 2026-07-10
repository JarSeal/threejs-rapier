import { IS_DEBUG_ENV } from '../core/Config';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

type LightGUIModule = typeof import('../core/Debug/_dbg__DebugTools');
export let debugGUI: DebugModuleRef<LightGUIModule> | null = null;
export const DEBUG_CAMERA_ID = '_debugCamera';

export type DebugCameraState = {
  enabled: boolean;
  latestAppCameraId: null | string;
  fov: number;
  near: number;
  far: number;
  position: number[];
  target: number[];
};

export type DebugToolsState = {
  env: {
    envBallFolderExpanded: boolean;
    envBallVisible: boolean;
    separateBallValues: boolean;
    ballRoughness: number;
    ballDefaultRoughness: number;
  };
  scenesListing: {
    scenesFolderExpanded: boolean;
    useDebugStartScene: boolean;
    debugStartScene: string;
    useDebuggerSceneLoader: boolean;
  };
  loggingActions: {
    loggingFolderExpanded: boolean;
  };
  debugCamera: { [sceneId: string]: DebugCameraState };
  debugCameraFolderExpanded: boolean;
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
  env: {
    envBallFolderExpanded: false,
    envBallVisible: false,
    separateBallValues: false,
    ballRoughness: 0,
    ballDefaultRoughness: 0,
  },
  scenesListing: {
    scenesFolderExpanded: false,
    useDebugStartScene: false,
    debugStartScene: '',
    useDebuggerSceneLoader: false,
  },
  loggingActions: {
    loggingFolderExpanded: false,
  },
  debugCamera: {},
  debugCameraFolderExpanded: false,
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
  if (!IS_DEBUG_ENV) return;
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__DebugTools'));
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
 * @returns debugToolsState {@link debugToolsState}
 */
export const getDebugToolsState = (loadFromLS?: boolean) =>
  useDebug(debugGUI)?._getDebugToolsState(loadFromLS) || defaultDebugToolsState;

/**
 * Add scene to debug tools states
 * @param sceneId (string)
 */
export const addSceneToDebugtools = (sceneId: string) => {
  useDebug(debugGUI)?._addSceneToDebugtools(sceneId);
};

/**
 * Handles debug camera switching
 */
export const handleDebugCameraSwitch = () => {
  useDebug(debugGUI)?._handleDebugCameraSwitch();
};
