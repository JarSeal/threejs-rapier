import * as THREE from 'three/webgpu';
import { getRenderer, getRendererOptions } from '../../core/Renderer';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import {
  createDebuggerTab,
  DEBUG_TOASTER_ID,
  DEBUGGER_SCENE_LOADER_ID,
  persistDebuggerTabValue,
  updateDebuggerTab,
  type DebuggerPaneItem,
} from '../../debug/DebuggerGUI';
import { getCurrentSceneId, getGeneratedAppData, getRootScene } from '../../core/Scene';
import {
  getCurrentEnvironment,
  getEnvs,
  IS_DEBUG_ENV,
  isDebugEnvironment,
} from '../../core/Config';
import { isCurrentlyLoading, loadScene } from '../../core/SceneLoader';
import { lerror, llog } from '../../utils/Logger';
import { openDraggableWindow } from '../../core/UI/DraggableWindow';
import { openDialog } from '../../core/UI/DialogWindow';
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
import { getECSWorld, getEntityIdByAppId } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import type { DebugCamLSProps } from '../CameraManager';
import { getDebugCamProps, saveDebugCameraToLS } from './Camera/_dbg__CameraGUI';
import { DEFAULT_DEBUG_CAM_PROPS, setDebugCameraPanelRefresh } from './Camera/_dbg__DebugCamera';
import { getUndoRedoSettings, setUndoRedoSettings } from '../../debug/UndoRedo';
import {
  initAxesGizmo,
  setAxesGizmoInMainCamera,
  setAxesGizmoVisible,
} from '../../debug/AxesGizmo';

const LS_KEY = 'AEK_debugTools';
const TAB_ID = 'debugToolsControls';
/** The Debug Camera folder's values, synced from the viewport (see onOpen below). */
let debugCamPanelProxy: DebugCamLSProps | null = null;

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

const createDebugToolsDebugGUI = () => {
  const renderer = getRenderer();
  if (!renderer) {
    const msg = 'Renderer not found in createDebugToolsDebugGUI';
    lerror(msg);
    throw new Error(msg);
  }

  createDebuggerTab({
    id: TAB_ID,
    title: 'Debug tools controls',
    icon: 'tools',
    lsKey: LS_KEY,
    state: debugToolsState,
    // The nested objects are persisted whole (the same LS shape as before). The *FolderExpanded
    // fields in them are no longer used: folder states are in `${LS_KEY}UI`.
    persistKeys: ['scenesListing', 'onScreenTools', 'helpers', 'env', 'axesGizmo'],
    // Live-refresh the Debug Camera folder from the viewport (dragging the debug camera with
    // OrbitControls): debugCameraSystem calls this only on frames where OrbitControls reported
    // a change. Unregistered on unmount, so a stale callback never runs against a disposed pane.
    onOpen: () => {
      setDebugCameraPanelRefresh(refreshDebugCameraPanelFromViewport);
      return () => setDebugCameraPanelRefresh(null);
    },
    content: () => [{ pane: true, content: buildDebugToolsItems() }],
  });
  // Hydrated at registration
  firstDebugToolsStateLoaded = true;

  toggleAxesHelperVisibility(debugToolsState.helpers.showAxesHelper);
  toggleGridHelperVisibility(debugToolsState.helpers.showGridHelper);
  togglePolarGridHelperVisibility(debugToolsState.helpers.showPolarGridHelper);
  initAxesGizmo(debugToolsState.axesGizmo);
};

const ON_SCREEN_TOOLS_DISABLED_BODY_CLASS = 'aekOnScreenToolsDisabled';
const ON_SCREEN_TOOLS_OPACITY_CSS_VAR = '--aek-disabled-on-screen-tools-opacity';
const ON_SCREEN_TOOLS_TOAST_SHOWING_TIME_MS = 2000;

/**
 * Applies the "Disable on-screen tools" option: a body class (see OnScreenTools.module.scss) and
 * the opacity CSS variable, so rebuilt tool groups keep it. Idempotent. Debug env only.
 */
export const _applyOnScreenToolsDisabled = () => {
  if (!IS_DEBUG_ENV) return;
  const { disableOnScreenTools, disabledOnScreenToolsOpacity } = debugToolsState.onScreenTools;
  document.body.classList.toggle(ON_SCREEN_TOOLS_DISABLED_BODY_CLASS, disableOnScreenTools);
  document.body.style.setProperty(
    ON_SCREEN_TOOLS_OPACITY_CSS_VAR,
    String(disabledOnScreenToolsOpacity)
  );
};

/**
 * The on-screen tools shortcut (§): flips the "Disable on-screen tools" option and shows a toast.
 * @param keyHint (string) optional readable chord that was pressed, for the toast
 */
export const _toggleOnScreenToolsDisabled = (keyHint?: string) => {
  const onScreenTools = debugToolsState.onScreenTools;
  onScreenTools.disableOnScreenTools = !onScreenTools.disableOnScreenTools;
  _applyOnScreenToolsDisabled();
  if (firstDebugToolsStateLoaded) {
    persistDebuggerTabValue(TAB_ID, 'onScreenTools');
    updateDebuggerTab(TAB_ID);
  } else {
    // The tab isn't registered yet (the key bindings are, during the first scene load). Written
    // directly, or the tab's hydration would restore the old value over this one.
    lsSetItem(LS_KEY, { ...(lsGetItem(LS_KEY, {}) as object), onScreenTools });
  }
  try {
    addToast({
      toasterId: DEBUG_TOASTER_ID,
      title: 'On-screen tools',
      message: onScreenTools.disableOnScreenTools
        ? `Disabled (click-through).${keyHint ? ` Press ${keyHint} to enable.` : ''}`
        : 'Enabled',
      showingTime: ON_SCREEN_TOOLS_TOAST_SHOWING_TIME_MS,
    });
  } catch {
    // No debug toaster yet (it's created at the end of InitEngine) — the toggle itself still ran
  }
};

/** The axes gizmo shortcut (F8): flips the "Show axes gizmo" option. */
export const _toggleAxesGizmo = () => {
  const axesGizmo = debugToolsState.axesGizmo;
  axesGizmo.show = !axesGizmo.show;
  setAxesGizmoVisible(axesGizmo.show);
  persistDebuggerTabValue(TAB_ID, 'axesGizmo');
  updateDebuggerTab(TAB_ID);
};

/**
 * Getter for the debugToolsState object
 * @param loadFromLS (boolean) optional flag to get the debugToolsState from the LS
 * @returns debugToolsState {@link debugToolsState}
 */
export const _getDebugToolsState = (loadFromLS?: boolean) => {
  if (!firstDebugToolsStateLoaded && loadFromLS) loadDebugToolsStateFromLS();
  return debugToolsState;
};

type LegacyDebugToolsLS = Partial<DebugToolsState> & {
  prodTestMode?: { showOnScreenToolsInProdTest?: boolean };
};

/**
 * Shallow-merges the LS state over debugToolsState. The old `prodTestMode` key is migrated to
 * `onScreenTools` and written back right away: the tab's persist writes only keep the
 * persistKeys already in LS, so any later write would otherwise drop the migrated value.
 */
const loadDebugToolsStateFromLS = () => {
  let saved = lsGetItem(LS_KEY, {}) as LegacyDebugToolsLS | null;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
  if (saved.prodTestMode && !saved.onScreenTools) {
    const { prodTestMode, ...rest } = saved;
    saved = {
      ...rest,
      onScreenTools: {
        ...debugToolsState.onScreenTools,
        showOnScreenToolsInProdTest: prodTestMode.showOnScreenToolsInProdTest !== false,
      },
    };
    lsSetItem(LS_KEY, saved);
  }
  debugToolsState = { ...debugToolsState, ...saved };
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
  setTimeout(() => {
    updateOnScreenTools('SWITCH');
  }, 0);
};

const getDebugCamera = () => {
  const entityId = getEntityIdByAppId(DEBUG_CAMERA_ID);
  if (entityId === undefined) return null;
  const world = getECSWorld();
  return {
    obj: world.getComponent(entityId, ComponentType.OBJECT3D)?.value as
      | THREE.PerspectiveCamera
      | undefined,
    controls: world.getComponent(entityId, ComponentType.ORBIT_CONTROLS)?.controls,
    settings: world.getComponent(entityId, ComponentType.CAMERA_SETTINGS),
  };
};

const applyDebugCameraProps = (partial: Partial<DebugCamLSProps>) => {
  const debugCamera = getDebugCamera();
  if (!debugCamera) return;
  const { obj, controls, settings } = debugCamera;

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

/** The tab refresh never fires onChange, so writing the live camera back into the panel can't
 * loop back into applyDebugCameraProps (which would re-dispatch OrbitControls' change). */
const refreshDebugCameraPanelFromViewport = () => {
  const debugCamera = getDebugCamera();
  const proxy = debugCamPanelProxy;
  if (!debugCamera?.obj || !debugCamera.controls || !proxy) return;
  const { obj, controls } = debugCamera;
  proxy.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
  proxy.target = { x: controls.target.x, y: controls.target.y, z: controls.target.z };
  proxy.fov = obj.fov;
  proxy.near = obj.near;
  proxy.far = obj.far;
  proxy.zoom = obj.zoom;
  updateDebuggerTab(TAB_ID);
};

type Vec3 = { x: number; y: number; z: number };

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

const buildDebugToolsItems = (): DebuggerPaneItem<DebugToolsState>[] => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return [];

  const scenesObj = getGeneratedAppData().scenes as { [id: string]: SceneAsset };
  const sceneIds = Object.keys(scenesObj);
  const scenes = sceneIds.map((id) => ({ id, name: scenesObj[id].name }));
  const sceneProxy = { sceneId: currentSceneId };
  const isStartSceneOff = () => !debugToolsState.scenesListing.useDebugStartScene;

  const camProxy: DebugCamLSProps = { ...getDebugCamProps(currentSceneId) };
  debugCamPanelProxy = camProxy;

  const helpers = debugToolsState.helpers;
  const recreateGridHelper = () =>
    createGridHelper(
      helpers.gridSize,
      helpers.gridDivisionsSize,
      helpers.gridColorCenterLine,
      helpers.gridColorGrid
    );
  const recreatePolarGridHelper = () =>
    createPolarGridHelper(
      helpers.polarGridRadius,
      helpers.polarGridSectors,
      helpers.polarGridRings,
      helpers.polarGridDivisions
    );

  const undoRedoSettings = getUndoRedoSettings();
  const logActionList = getLogActionList();

  return [
    // Scene listing
    {
      type: 'folder',
      id: 'scenes',
      title: 'Change scene and debug start scene',
      expanded: false,
      content: [
        {
          key: 'sceneId',
          target: sceneProxy,
          label: 'Change scene',
          options: scenes.map((s) => ({ value: s.id, text: s.name || `[${s.id}]` })),
          onChange: (value) => {
            const sceneId = String(value);
            if (sceneId === getCurrentSceneId() || isCurrentlyLoading()) return;
            loadScene({ sceneId, loaderId: DEBUGGER_SCENE_LOADER_ID });
          },
        },
        {
          key: 'scenesListing.useDebugStartScene',
          label: 'Use debug start scene',
          // Re-evaluates the disabled state of the two below
          onChange: () => updateDebuggerTab(TAB_ID),
        },
        {
          key: 'scenesListing.debugStartScene',
          label: 'Start scene to load',
          options: getSceneStarterDropDownOptions(),
          disabled: isStartSceneOff,
        },
        {
          key: 'scenesListing.useDebuggerSceneLoader',
          label: 'Use debugger scene loader for start scene',
          disabled: isStartSceneOff,
        },
      ],
    },

    // On-screen tools
    {
      type: 'folder',
      id: 'onScreenTools',
      title: 'On-screen tools',
      expanded: false,
      content: [
        {
          key: 'onScreenTools.disableOnScreenTools',
          label: 'Disable on-screen tools [§]',
          onChange: _applyOnScreenToolsDisabled,
        },
        {
          key: 'onScreenTools.disabledOnScreenToolsOpacity',
          label: 'Disabled on-screen tools opacity',
          min: 0,
          max: 1,
          step: 0.01,
          onChange: _applyOnScreenToolsDisabled,
        },
        {
          key: 'onScreenTools.showOnScreenToolsInProdTest',
          label: 'Show top on screen tools in prod test mode',
        },
      ],
    },

    // Debug Camera (position/target apply on release, the lens fields on every slide tick,
    // matching the Camera Controls tab's own lens bindings)
    {
      type: 'folder',
      id: 'debugCamera',
      title: 'Debug Camera',
      expanded: false,
      content: [
        {
          key: 'position',
          target: camProxy,
          label: 'Position',
          onChange: (value, e) => {
            if (e.last) applyDebugCameraProps({ position: { ...(value as Vec3) } });
          },
        },
        {
          key: 'target',
          target: camProxy,
          label: 'Target',
          onChange: (value, e) => {
            if (e.last) applyDebugCameraProps({ target: { ...(value as Vec3) } });
          },
        },
        {
          key: 'fov',
          target: camProxy,
          label: 'FOV',
          min: 1,
          max: 170,
          step: 1,
          onChange: (value) => applyDebugCameraProps({ fov: Number(value) }),
        },
        {
          key: 'near',
          target: camProxy,
          label: 'Near',
          min: 0.001,
          step: 0.001,
          onChange: (value) => applyDebugCameraProps({ near: Number(value) }),
        },
        {
          key: 'far',
          target: camProxy,
          label: 'Far',
          min: 1,
          step: 1,
          onChange: (value) => applyDebugCameraProps({ far: Number(value) }),
        },
        {
          key: 'zoom',
          target: camProxy,
          label: 'Zoom',
          min: 0.01,
          step: 0.01,
          onChange: (value) => applyDebugCameraProps({ zoom: Number(value) }),
        },
        {
          type: 'button',
          title: 'Reset to default',
          onClick: () => {
            camProxy.position = { ...DEFAULT_DEBUG_CAM_PROPS.position };
            camProxy.target = { ...DEFAULT_DEBUG_CAM_PROPS.target };
            applyDebugCameraProps({
              position: { ...DEFAULT_DEBUG_CAM_PROPS.position },
              target: { ...DEFAULT_DEBUG_CAM_PROPS.target },
            });
            updateDebuggerTab(TAB_ID);
          },
        },
      ],
    },

    // Helpers
    {
      type: 'folder',
      id: 'helpers',
      title: 'Helpers',
      expanded: false,
      content: [
        {
          key: 'axesGizmo.show',
          label: 'Show axes gizmo [F8]',
          onChange: (value) => setAxesGizmoVisible(Boolean(value)),
        },
        {
          key: 'axesGizmo.showInMainCamera',
          label: 'Show axes gizmo in main camera',
          onChange: (value) => setAxesGizmoInMainCamera(Boolean(value)),
        },
        {
          key: 'helpers.showAxesHelper',
          label: 'Show axes helper',
          onChange: (value) => toggleAxesHelperVisibility(Boolean(value)),
        },
        {
          key: 'helpers.axesHelperSize',
          label: 'Axes helper size',
          min: 0.1,
          step: 0.1,
          onChange: (value) => createAxesHelper(Number(value)),
        },
        { type: 'separator' },
        {
          key: 'helpers.showGridHelper',
          label: 'Show grid helper',
          onChange: (value) => toggleGridHelperVisibility(Boolean(value)),
        },
        {
          key: 'helpers.gridSize',
          label: 'Grid size',
          min: 0.01,
          step: 0.01,
          onChange: recreateGridHelper,
        },
        {
          key: 'helpers.gridDivisionsSize',
          label: "Grid division's size",
          min: 0.01,
          step: 0.01,
          onChange: recreateGridHelper,
        },
        {
          key: 'helpers.gridColorCenterLine',
          label: "Grid's center line color",
          color: { type: 'float' },
          onChange: recreateGridHelper,
        },
        {
          key: 'helpers.gridColorGrid',
          label: "Grid's color",
          color: { type: 'float' },
          onChange: recreateGridHelper,
        },
        { type: 'separator' },
        {
          key: 'helpers.showPolarGridHelper',
          label: 'Show polar grid helper',
          onChange: (value) => togglePolarGridHelperVisibility(Boolean(value)),
        },
        {
          key: 'helpers.polarGridRadius',
          label: 'Polar grid radius  ',
          min: 0.01,
          step: 0.01,
          onChange: recreatePolarGridHelper,
        },
        {
          key: 'helpers.polarGridSectors',
          label: 'Polar grid sectors',
          min: 1,
          step: 1,
          onChange: recreatePolarGridHelper,
        },
        {
          key: 'helpers.polarGridRings',
          label: 'Polar grid rings',
          min: 0,
          step: 1,
          onChange: recreatePolarGridHelper,
        },
        {
          key: 'helpers.polarGridDivisions',
          label: 'Polar grid divisions',
          min: 0,
          step: 1,
          onChange: recreatePolarGridHelper,
        },
      ],
    },

    // Undo / Redo (its settings persist in the undo/redo module's own LS key)
    {
      type: 'folder',
      id: 'undoRedo',
      title: 'Undo / Redo',
      expanded: false,
      content: undoRedoSettings
        ? [
            {
              key: 'historySize',
              target: undoRedoSettings,
              label: 'History size (per scene)',
              min: 1,
              max: 500,
              step: 1,
              // Applied on release only: shrinking trims (deletes) history, so a slider drag
              // passing through a small value must not already drop entries
              onChange: (value, e) => {
                if (e.last) setUndoRedoSettings({ historySize: Number(value) });
              },
            },
            {
              key: 'showToasts',
              target: undoRedoSettings,
              label: 'Show undo/redo toasts',
              onChange: (value) => setUndoRedoSettings({ showToasts: Boolean(value) }),
            },
          ]
        : [],
    },

    // Logging actions
    {
      type: 'folder',
      id: 'logging',
      title: 'Logging actions ',
      expanded: false,
      content: [
        {
          type: 'button',
          title: 'ALL',
          onClick: () => {
            const list = getLogActionList();
            const keys = Object.keys(list) as (keyof typeof list)[];
            for (let i = 0; i < keys.length; i++) llog(...list[keys[i]]);
          },
        },
        ...(Object.keys(logActionList) as (keyof typeof logActionList)[]).map(
          (key): DebuggerPaneItem<DebugToolsState> => ({
            type: 'button',
            title: key,
            onClick: () => llog(...getLogActionList()[key]),
          })
        ),

        // @TODO: REMOVE THESE!
        {
          type: 'button',
          title: 'OPEN DRAGGABLE WINDOW',
          onClick: () =>
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
              closeOnSceneChange: true,
            }),
        },
        {
          type: 'button',
          title: 'OPEN DIALOG WINDOW',
          onClick: () =>
            openDialog({
              id: 'myFirstDialogTest',
              saveToLS: true,
              title: 'My dialog window',
              isDebugWindow: true,
              backDropClickClosesWindow: true,
              closeOnSceneChange: true,
            }),
        },
        {
          type: 'button',
          title: 'TEST TOASTER (info)',
          onClick: () =>
            addToast({
              title: 'INFO',
              message: 'Hello world! ' + performance.now(),
              showingTime: 4800,
            }),
        },
        {
          type: 'button',
          title: 'TEST TOASTER (warning)',
          onClick: () =>
            addToast({
              type: 'warning',
              title: 'WARNING',
              message: 'Hello world! ' + performance.now(),
              showingTime: 4800,
            }),
        },
        {
          type: 'button',
          title: 'TEST TOASTER (alert)',
          onClick: () =>
            addToast({
              type: 'alert',
              title: 'ALERT',
              message: 'Hello world! ' + performance.now(),
            }),
        },
      ],
    },
  ];
};
