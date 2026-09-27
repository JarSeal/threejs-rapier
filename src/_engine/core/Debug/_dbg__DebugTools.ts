import * as THREE from 'three/webgpu';
import { ListBladeApi, Pane } from 'tweakpane';
import { BladeController, View } from '@tweakpane/core';
import { getRenderer, getRendererOptions } from '../../core/Renderer';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import {
  createNewDebuggerPane,
  createDebuggerTab,
  DEBUGGER_SCENE_LOADER_ID,
} from '../../debug/DebuggerGUI';
import { getCurrentSceneId, getGeneratedAppData, getRootScene } from '../../core/Scene';
import { getCurrentEnvironment, getEnvs, isDebugEnvironment } from '../../core/Config';
import { isCurrentlyLoading, loadScene } from '../../core/SceneLoader';
import { lerror, llog } from '../../utils/Logger';
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
} from '../Helpers';
import { updateOnScreenTools } from '../../debug/OnScreenTools';
import { addToast } from '../../core/UI/Toaster';
import { type SceneAsset } from '../../schemas/sceneSchema';
import { DEBUG_CAMERA_ID, DebugToolsState } from '../../debug/DebugToolsManager';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import { getECSWorld, getEntityIdByAppId } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import type { DebugCamLSProps } from '../CameraManager';
import { getDebugCamProps, saveDebugCameraToLS } from './Camera/_dbg__CameraGUI';
import { DEFAULT_DEBUG_CAM_PROPS, setDebugCameraPanelRefresh } from './Camera/_dbg__DebugCamera';

const LS_KEY = 'AEK_debugTools';
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
  prodTestMode: {
    prodTestFolderExpanded: false,
    showOnScreenToolsInProdTest: true,
  },
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
      const clearTabBtn = createClearTabLSButton({
        hasData: () => lsKeyHasData(LS_KEY),
        watchKey: LS_KEY,
        onClear: () => lsRemoveItem(LS_KEY),
      });
      const { container, debugGUI } = createNewDebuggerPane(
        'debugTools',
        `${icon} Debug Tools Controls`,
        [clearTabBtn]
      );
      toolsDebugGUI = debugGUI;

      // The Debug Camera folder below registers a per-frame panel-refresh callback with
      // debugCameraSystem; it must be unregistered when this pane is torn down (e.g. switching
      // to another debug tab), or a stale callback would keep firing against disposed bindings.
      const existingOnRemoveCmp = container.props?.onRemoveCmp;
      container.props = {
        ...container.props,
        onRemoveCmp: (cmp) => {
          existingOnRemoveCmp?.(cmp);
          setDebugCameraPanelRefresh(null);
        },
      };

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

  // Production test mode
  const prodTestFolder = debugGUI
    .addFolder({
      title: 'Production test mode',
      expanded: debugToolsState.prodTestMode.prodTestFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.prodTestMode.prodTestFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  prodTestFolder
    .addBinding(debugToolsState.prodTestMode, 'showOnScreenToolsInProdTest', {
      label: 'Show top on screen tools in prod test mode',
    })
    .on('change', () => {
      lsSetItem(LS_KEY, debugToolsState);
    });

  // Debug Camera
  const debugCameraFolder = debugGUI
    .addFolder({
      title: 'Debug Camera',
      expanded: debugToolsState.debugCameraFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.debugCameraFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });

  const debugCamProxy: DebugCamLSProps = { ...getDebugCamProps(currentSceneId) };

  // Guards against a feedback loop: refreshing a binding from the viewport-driven callback
  // below (setDebugCameraPanelRefresh) can make Tweakpane re-emit that same binding's own
  // 'change' event (its displayed value no longer matches debugCamProxy once we've written the
  // live camera's values into it) — which would otherwise call applyDebugCameraProps again,
  // which calls controls.update(), which can re-dispatch OrbitControls' 'change' event, calling
  // the refresh callback again, ad infinitum (surfaced as a "Maximum call stack size exceeded"
  // when panning, since panning is what moves the target binding through this exact path).
  // While set, every binding below treats its 'change' event as an echo of our own refresh,
  // not a real user edit, and skips calling applyDebugCameraProps.
  let isRefreshingDebugCameraPanel = false;

  const applyDebugCameraProps = (partial: Partial<DebugCamLSProps>) => {
    const entityId = getEntityIdByAppId(DEBUG_CAMERA_ID);
    if (entityId === undefined) return;
    const world = getECSWorld();
    const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value as
      | THREE.PerspectiveCamera
      | undefined;
    const controls = world.getComponent(entityId, ComponentType.ORBIT_CONTROLS)?.controls;
    const settings = world.getComponent(entityId, ComponentType.CAMERA_SETTINGS);

    if (partial.position && obj) {
      obj.position.set(partial.position.x, partial.position.y, partial.position.z);
    }
    if (partial.target && controls) {
      controls.target.set(partial.target.x, partial.target.y, partial.target.z);
    }
    const hasLensChange =
      partial.fov !== undefined ||
      partial.near !== undefined ||
      partial.far !== undefined ||
      partial.zoom !== undefined;
    if (obj && hasLensChange) {
      if (partial.fov !== undefined) obj.fov = partial.fov;
      if (partial.near !== undefined) obj.near = partial.near;
      if (partial.far !== undefined) obj.far = partial.far;
      if (partial.zoom !== undefined) obj.zoom = partial.zoom;
      obj.updateProjectionMatrix();
    }
    if (settings && hasLensChange) {
      if (partial.fov !== undefined) settings.fov = partial.fov;
      if (partial.near !== undefined) settings.near = partial.near;
      if (partial.far !== undefined) settings.far = partial.far;
      if (partial.zoom !== undefined) settings.zoom = partial.zoom;
    }
    controls?.update();
    saveDebugCameraToLS(partial);
  };

  const debugCamPositionBinding = debugCameraFolder
    .addBinding(debugCamProxy, 'position', { label: 'Position' })
    .on('change', (e) => {
      if (isRefreshingDebugCameraPanel || !e.last) return;
      applyDebugCameraProps({ position: { ...e.value } });
    });
  const debugCamTargetBinding = debugCameraFolder
    .addBinding(debugCamProxy, 'target', { label: 'Target' })
    .on('change', (e) => {
      if (isRefreshingDebugCameraPanel || !e.last) return;
      applyDebugCameraProps({ target: { ...e.value } });
    });
  // Lens fields (unlike position/target above) are not gated by `e.last` — matching the
  // "Camera Controls" tab's own lens bindings (`_dbg__CameraGUI.ts`'s `createEditCameraContent`,
  // which binds directly to the live camera and applies on every intermediate slide tick) — so
  // dragging the slider updates the live view continuously instead of only on mouse-up.
  const debugCamFovBinding = debugCameraFolder
    .addBinding(debugCamProxy, 'fov', { label: 'FOV', min: 1, max: 170, step: 1 })
    .on('change', (e) => {
      if (isRefreshingDebugCameraPanel) return;
      applyDebugCameraProps({ fov: e.value });
    });
  const debugCamNearBinding = debugCameraFolder
    .addBinding(debugCamProxy, 'near', { label: 'Near', min: 0.001, step: 0.001 })
    .on('change', (e) => {
      if (isRefreshingDebugCameraPanel) return;
      applyDebugCameraProps({ near: e.value });
    });
  const debugCamFarBinding = debugCameraFolder
    .addBinding(debugCamProxy, 'far', { label: 'Far', min: 1, step: 1 })
    .on('change', (e) => {
      if (isRefreshingDebugCameraPanel) return;
      applyDebugCameraProps({ far: e.value });
    });
  const debugCamZoomBinding = debugCameraFolder
    .addBinding(debugCamProxy, 'zoom', { label: 'Zoom', min: 0.01, step: 0.01 })
    .on('change', (e) => {
      if (isRefreshingDebugCameraPanel) return;
      applyDebugCameraProps({ zoom: e.value });
    });
  debugCameraFolder.addButton({ title: 'Reset to default' }).on('click', () => {
    debugCamProxy.position = { ...DEFAULT_DEBUG_CAM_PROPS.position };
    debugCamProxy.target = { ...DEFAULT_DEBUG_CAM_PROPS.target };
    applyDebugCameraProps({
      position: { ...DEFAULT_DEBUG_CAM_PROPS.position },
      target: { ...DEFAULT_DEBUG_CAM_PROPS.target },
    });
    isRefreshingDebugCameraPanel = true;
    try {
      debugCamPositionBinding.refresh();
      debugCamTargetBinding.refresh();
    } finally {
      isRefreshingDebugCameraPanel = false;
    }
  });

  // Live-refresh the bindings above from the viewport (dragging the debug camera with
  // OrbitControls) — registered with debugCameraSystem, which calls this only on frames
  // where OrbitControls actually reported a change. Unregistered on pane teardown above.
  setDebugCameraPanelRefresh(() => {
    const entityId = getEntityIdByAppId(DEBUG_CAMERA_ID);
    if (entityId === undefined) return;
    const world = getECSWorld();
    const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value as
      | THREE.PerspectiveCamera
      | undefined;
    const controls = world.getComponent(entityId, ComponentType.ORBIT_CONTROLS)?.controls;
    if (!obj || !controls) return;

    debugCamProxy.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
    debugCamProxy.target = { x: controls.target.x, y: controls.target.y, z: controls.target.z };
    debugCamProxy.fov = obj.fov;
    debugCamProxy.near = obj.near;
    debugCamProxy.far = obj.far;
    debugCamProxy.zoom = obj.zoom;

    isRefreshingDebugCameraPanel = true;
    try {
      debugCamPositionBinding.refresh();
      debugCamTargetBinding.refresh();
      debugCamFovBinding.refresh();
      debugCamNearBinding.refresh();
      debugCamFarBinding.refresh();
      debugCamZoomBinding.refresh();
    } finally {
      isRefreshingDebugCameraPanel = false;
    }
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
