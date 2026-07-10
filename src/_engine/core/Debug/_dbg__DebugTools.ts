import { ListBladeApi, Pane } from 'tweakpane';
import { BladeController, View } from '@tweakpane/core';
import { getRenderer, getRendererOptions } from '../../core/Renderer';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { createNewDebuggerPane, createDebuggerTab } from '../../debug/DebuggerGUI';
import { getCurrentSceneId, getGeneratedAppData, getRootScene, getScene } from '../../core/Scene';
import { getCurrentEnvironment, getEnvs, isDebugEnvironment } from '../../core/Config';
import { isCurrentlyLoading, loadScene } from '../../core/SceneLoader';
import { lerror, llog } from '../../utils/Logger';
import { DEBUGGER_SCENE_LOADER_ID } from '../../debug/DebuggerSceneLoader';
import { openDraggableWindow } from '../../core/UI/DraggableWindow';
import { openDialog } from '../../core/UI/DialogWindow';
import { getSvgIcon } from '../../core/UI/icons/SvgIcon';
import {
  createAxesHelper,
  createGridHelper,
  createPolarGridHelper,
  toggleAxesHelperVisibility,
  toggleGridHelperVisibility,
  togglePolarGridHelperVisibility,
} from '../../core/legacy_Helpers';
import { updateOnScreenTools } from '../../debug/OnScreenTools';
import { addToast } from '../../core/UI/Toaster';
import { type SceneAsset } from '../../schemas/sceneSchema';
import { DebugCameraState, DebugToolsState } from '../../debug/_DebugToolsManager';

const LS_KEY = 'AEK_debugTools';
export const DEBUG_CAMERA_ID = '_debugCamera';
const DEFAULT_DEBUG_CAM_PARAMS: DebugCameraState = {
  enabled: false,
  latestAppCameraId: null,
  fov: 60,
  near: 0.001,
  far: 1000,
  position: [0, 0, 10],
  target: [0, 0, 0],
};
const getDefaultDebugCamParams = () => ({ ...DEFAULT_DEBUG_CAM_PARAMS }) as DebugCameraState;
let scenesDropDown: ListBladeApi<BladeController<View>>;
let sceneStarterDropDown: ListBladeApi<BladeController<View>>;
let toolsDebugGUI: Pane | null = null;

let firstDebugToolsStateLoaded = false;
let debugToolsState: DebugToolsState = {
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

/**
 * Initializes the debug tools (only for debug environments).
 */
export const _initDebugTools = () => {
  if (!isDebugEnvironment()) return;
  createDebugToolsDebugGUI();
};

// Debug GUI for sky box
const createDebugToolsDebugGUI = () => {
  const savedDebugToolsState = lsGetItem(LS_KEY, debugToolsState);
  debugToolsState = { ...debugToolsState, ...savedDebugToolsState };
  firstDebugToolsStateLoaded = true;

  const renderer = getRenderer();
  if (!renderer) {
    const msg = 'Renderer not found in createDebugToolsDebugGUI';
    lerror(msg);
    throw new Error(msg);
  }

  toggleAxesHelperVisibility(debugToolsState.helpers.showAxesHelper);
  toggleGridHelperVisibility(debugToolsState.helpers.showGridHelper);
  togglePolarGridHelperVisibility(debugToolsState.helpers.showPolarGridHelper);

  const icon = getSvgIcon('tools');
  createDebuggerTab({
    id: 'debugToolsControls',
    buttonText: icon,
    title: 'Debug tools controls',
    orderNr: 6,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane(
        'debugTools',
        `${icon} Debug Tools Controls`
      );
      toolsDebugGUI = debugGUI;
      buildDebugToolsGUI();

      return container;
    },
  });
};

/**
 * Getter for the debugToolsState object
 * @param loadFromLS (boolean) optional flag to get the debugToolsState from the LS
 * @returns debugToolsState {@link debugToolsState}
 */
export const _getDebugToolsState = (loadFromLS?: boolean) => {
  if (!firstDebugToolsStateLoaded && loadFromLS) {
    const savedDebugToolsState = lsGetItem(LS_KEY, debugToolsState);
    debugToolsState = { ...debugToolsState, ...savedDebugToolsState };
  }
  return debugToolsState;
};

const getSceneStarterDropDownOptions = () => {
  const scenesObj = getGeneratedAppData().scenes as { [id: string]: SceneAsset };
  const sceneIds = Object.keys(scenesObj);
  const scenes = sceneIds.map((id) => ({ id, name: scenesObj[id].name }));
  return [
    { value: '', text: '---NOT-SET---' },
    ...scenes.map((s) => ({ value: s.id, text: s.name || `[${s.id}]` })),
  ];
};

/**
 * Add scene to debug tools states
 * @param sceneId (string)
 */
export const _addSceneToDebugtools = (sceneId: string) => {
  if (!isDebugEnvironment()) return;
  const foundScene = getScene(sceneId);
  if (!foundScene || debugToolsState.debugCamera[sceneId]) return;

  debugToolsState.debugCamera[sceneId] = getDefaultDebugCamParams();
};

/**
 * Handles debug camera switching
 */
export const _handleDebugCameraSwitch = () => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  // @CHORE: set the new camera here
  lsSetItem(LS_KEY, debugToolsState);
  setTimeout(() => {
    updateOnScreenTools('SWITCH');
  }, 0);
};

const buildDebugToolsGUI = () => {
  const debugGUI = toolsDebugGUI;
  const currentSceneId = getCurrentSceneId();
  if (!debugGUI || !currentSceneId) return;

  const blades = debugGUI?.children || [];
  for (let i = 0; i < blades.length; i++) {
    blades[i].dispose();
  }

  const scenesObj = getGeneratedAppData().scenes as { [id: string]: SceneAsset };
  const sceneIds = Object.keys(scenesObj);
  const scenes = sceneIds.map((id) => ({ id, name: scenesObj[id].name }));

  // Scene listing
  const scenesFolder = debugGUI
    .addFolder({
      title: 'Change scene and debug start scene',
      expanded: debugToolsState.scenesListing.scenesFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.scenesListing.scenesFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  scenesDropDown = scenesFolder.addBlade({
    view: 'list',
    label: 'Change scene',
    options: scenes.map((s) => ({ value: s.id, text: s.name || `[${s.id}]` })),
    value: getCurrentSceneId(),
  }) as ListBladeApi<BladeController<View>>;
  scenesDropDown.on('change', (e) => {
    const value = String(e.value);
    if (value === getCurrentSceneId()) return;
    if (!isCurrentlyLoading()) {
      loadScene({ sceneId: value, loaderId: DEBUGGER_SCENE_LOADER_ID });
      return;
    }
    if (!isCurrentlyLoading) {
      lerror(`Could not find scene with id '${value}' in scenes dropdown debugger.`);
    }
  });
  scenesFolder
    .addBinding(debugToolsState.scenesListing, 'useDebugStartScene', {
      label: 'Use debug start scene',
    })
    .on('change', (e) => {
      sceneStarterDropDown.disabled = !e.value;
      useDebuggerSceneLoader.disabled = !e.value;
      lsSetItem(LS_KEY, debugToolsState);
    });
  sceneStarterDropDown = scenesFolder.addBlade({
    view: 'list',
    label: 'Start scene to load',
    options: getSceneStarterDropDownOptions(),
    value: debugToolsState.scenesListing.debugStartScene || '',
    disabled: !debugToolsState.scenesListing.useDebugStartScene,
  }) as ListBladeApi<BladeController<View>>;
  sceneStarterDropDown.on('change', (e) => {
    debugToolsState.scenesListing.debugStartScene = String(e.value);
    lsSetItem(LS_KEY, debugToolsState);
  });
  const useDebuggerSceneLoader = scenesFolder
    .addBinding(debugToolsState.scenesListing, 'useDebuggerSceneLoader', {
      label: 'Use debugger scene loader for start scene',
      disabled: !debugToolsState.scenesListing.useDebugStartScene,
    })
    .on('change', () => {
      lsSetItem(LS_KEY, debugToolsState);
    });

  // Helpers
  const helpersFolder = debugGUI
    .addFolder({
      title: 'Helpers',
      expanded: debugToolsState.helpers.helpersFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.helpers.helpersFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder // AXES HELPER
    .addBinding(debugToolsState.helpers, 'showAxesHelper', { label: 'Show axes helper' })
    .on('change', (e) => {
      toggleAxesHelperVisibility(e.value);
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'axesHelperSize', {
      label: 'Axes helper size',
      min: 0.1,
      step: 0.1,
    })
    .on('change', (e) => {
      createAxesHelper(Number(e.value));
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder.addBlade({ view: 'separator' });
  helpersFolder // GRID HELPER
    .addBinding(debugToolsState.helpers, 'showGridHelper', { label: 'Show grid helper' })
    .on('change', (e) => {
      toggleGridHelperVisibility(e.value);
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'gridSize', { label: 'Grid size', min: 0.01, step: 0.01 })
    .on('change', (e) => {
      createGridHelper(
        Number(e.value),
        debugToolsState.helpers.gridDivisionsSize,
        debugToolsState.helpers.gridColorCenterLine,
        debugToolsState.helpers.gridColorGrid
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'gridDivisionsSize', {
      label: "Grid division's size",
      min: 0.01,
      step: 0.01,
    })
    .on('change', (e) => {
      createGridHelper(
        debugToolsState.helpers.gridSize,
        Number(e.value),
        debugToolsState.helpers.gridColorCenterLine,
        debugToolsState.helpers.gridColorGrid
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'gridColorCenterLine', {
      label: "Grid's center line color",
      color: { type: 'float' },
    })
    .on('change', (e) => {
      createGridHelper(
        debugToolsState.helpers.gridSize,
        debugToolsState.helpers.gridDivisionsSize,
        Number(e.value),
        debugToolsState.helpers.gridColorGrid
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'gridColorGrid', {
      label: "Grid's color",
      color: { type: 'float' },
    })
    .on('change', (e) => {
      createGridHelper(
        debugToolsState.helpers.gridSize,
        debugToolsState.helpers.gridDivisionsSize,
        debugToolsState.helpers.gridColorCenterLine,
        Number(e.value)
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder.addBlade({ view: 'separator' });
  helpersFolder // POLAR GRID HELPER
    .addBinding(debugToolsState.helpers, 'showPolarGridHelper', { label: 'Show polar grid helper' })
    .on('change', (e) => {
      togglePolarGridHelperVisibility(e.value);
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'polarGridRadius', {
      label: 'Polar grid radius  ',
      min: 0.01,
      step: 0.01,
    })
    .on('change', (e) => {
      createPolarGridHelper(
        Number(e.value),
        debugToolsState.helpers.polarGridSectors,
        debugToolsState.helpers.polarGridRings,
        debugToolsState.helpers.polarGridDivisions
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'polarGridSectors', {
      label: 'Polar grid sectors',
      min: 1,
      step: 1,
    })
    .on('change', (e) => {
      createPolarGridHelper(
        debugToolsState.helpers.polarGridRadius,
        Number(e.value),
        debugToolsState.helpers.polarGridRings,
        debugToolsState.helpers.polarGridDivisions
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'polarGridRings', {
      label: 'Polar grid rings',
      min: 0,
      step: 1,
    })
    .on('change', (e) => {
      createPolarGridHelper(
        debugToolsState.helpers.polarGridRadius,
        debugToolsState.helpers.polarGridSectors,
        Number(e.value),
        debugToolsState.helpers.polarGridDivisions
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'polarGridDivisions', {
      label: 'Polar grid divisions',
      min: 0,
      step: 1,
    })
    .on('change', (e) => {
      createPolarGridHelper(
        debugToolsState.helpers.polarGridRadius,
        debugToolsState.helpers.polarGridSectors,
        debugToolsState.helpers.polarGridRings,
        Number(e.value)
      );
      lsSetItem(LS_KEY, debugToolsState);
    });

  // Logging actions
  const loggingFolder = debugGUI
    .addFolder({
      title: 'Logging actions ',
      expanded: debugToolsState.loggingActions.loggingFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.loggingActions.loggingFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  const getLogActionList = () => ({
    environmentVariables: [
      'ENV VARIABLES:********\n',
      `Current environment: ${getCurrentEnvironment()}`,
      getEnvs(),
      '**********************',
    ],
    renderer: [
      'RENDER OPTIONS:*******',
      getRendererOptions(),
      '**********************\n',
      'RENDERER:*******',
      getRenderer(),
      '**********************',
    ],
    rootScene: ['ROOT SCENE:***********', getRootScene(), '**********************'],
  });
  const getLogActionListItem = (key: string) => {
    const logActionList = getLogActionList();
    return logActionList[key as keyof typeof logActionList];
  };
  loggingFolder.addButton({ title: 'ALL' }).on('click', () => {
    const logActionList = getLogActionList();
    const keys = Object.keys(logActionList);
    for (let i = 0; i < keys.length; i++) {
      llog(...logActionList[keys[i] as keyof typeof logActionList]);
    }
  });
  const logActionList = getLogActionList();
  const logActionKeys = Object.keys(logActionList);
  for (let i = 0; i < logActionKeys.length; i++) {
    const key = logActionKeys[i] as keyof typeof logActionList;
    loggingFolder.addButton({ title: key }).on('click', () => {
      llog(...getLogActionListItem(key));
    });
  }

  // @TODO: REMOVE THESE!
  loggingFolder.addButton({ title: 'OPEN DRAGGABLE WINDOW' }).on('click', () => {
    openDraggableWindow({
      id: 'myFirstDraggableTest',
      closeIfOpen: true,
      position: { x: 400, y: 400 },
      size: { w: 200, h: 100 },
      saveToLS: true,
      title: 'My draggable window',
      isDebugWindow: true,
      disableHoriResize: false,
      disableVertResize: false,
      disableDragging: false,
      resetPosition: true,
    });
  });
  loggingFolder.addButton({ title: 'OPEN DIALOG WINDOW' }).on('click', () => {
    openDialog({
      id: 'myFirstDialogTest',
      saveToLS: true,
      title: 'My dialog window',
      // isDebugWindow: true,
      backDropClickClosesWindow: true,
    });
  });
  loggingFolder.addButton({ title: 'TEST TOASTER (info)' }).on('click', () => {
    addToast({
      title: 'INFO',
      message: 'Hello world! ' + performance.now(),
      showingTime: 4800,
    });
  });
  loggingFolder.addButton({ title: 'TEST TOASTER (warning)' }).on('click', () => {
    addToast({
      type: 'warning',
      title: 'WARNING',
      message: 'Hello world! ' + performance.now(),
      showingTime: 4800,
    });
  });
  loggingFolder.addButton({ title: 'TEST TOASTER (alert)' }).on('click', () => {
    addToast({
      type: 'alert',
      title: 'ALERT',
      message: 'Hello world! ' + performance.now(),
    });
  });

  debugGUI.refresh();
};
