import {
  getAllCamerasAsArray,
  getMainAppCameraId,
  isAnyCameraHelperVisible,
  isDebugCameraActive,
  setCurrentCamera,
  toggleAllCameraHelpers,
  toggleDebugCamera,
} from '../CameraManager';
import { IS_DEBUG_ENV, IS_PROD_TEST_MODE } from '../../core/Config';
import { getHUDRootCMP } from '../../core/HUD';
import { isAnyLightHelperVisible, toggleAllLightHelpers } from '../LightManager';
import { getReadOnlyLoopState, toggleAppPlay, toggleMainPlay } from '../../core/MainLoop';
import { getPhysicsState } from '../../core/PhysicsAPI';
import { getCurrentSceneId, getGeneratedAppData } from '../../core/Scene';
import { isCurrentlyLoading, loadScene } from '../../core/SceneLoader';
import { getSvgIcon } from '../../core/UI/icons/SvgIcon';
import { CMP, TCMP } from '../../utils/CMP';
import styles from './OnScreenTools.module.scss';
import { getECSWorld } from '../../core/ECS';
import { type SceneAsset } from '../../schemas/sceneSchema';
import { type ToolTypes } from '../../debug/OnScreenTools';
import { addDebugToast, DEBUGGER_SCENE_LOADER_ID } from '../../debug/DebuggerGUI';
import { DebugModuleRef, loadDebugModule, useDebug } from '../../utils/helpers';
import { getDebugToolsState } from '../../debug/DebugToolsManager';
import { canRedo, canUndo, redoLastAction, undoLastAction } from '../../debug/UndoRedo';

let playToolsCMP: TCMP | null = null;
let switchToolsCMP: TCMP | null = null;
let undoRedoToolsCMP: TCMP | null = null;

// This file (a lazily-loaded _dbg__ module) also loads in IS_PROD_TEST_MODE (see
// debug/OnScreenTools.ts's registerOnScreenTools), but the physics wireframe system is
// IS_DEBUG_ENV-only — never reaches prodTest, matching PhysicsManager.registerPhysicsManager's
// own gating. Cross-referencing it via loadDebugModule (not a static import) is what keeps
// that scoping intact: a static import would run this module's side effects unconditionally
// the moment _dbg__OnScreenTools.ts itself loads, regardless of IS_DEBUG_ENV.
const physicsDebugDrawRef: DebugModuleRef<typeof import('./_dbg__PhysicsDebugDraw')> | null =
  loadDebugModule(() => import('./_dbg__PhysicsDebugDraw'));

/** Reloads the app with one mode query param on and the other one removed. */
const reloadInMode = (onParam: 'isProdTest' | 'isDebug', offParam: 'isProdTest' | 'isDebug') => {
  const queryData = new URLSearchParams(window.location.search.slice(1));
  queryData.set(onParam, 'true');
  queryData.delete(offParam);
  const newUrl = new URL(window.location.href);
  newUrl.search = queryData.toString();
  window.location.href = newUrl.toString();
};

/** Reloads the app in production test mode (the on-screen play button). */
export const _playInProdTestMode = () => reloadInMode('isProdTest', 'isDebug');

/** Reloads the app in debug mode (the on-screen stop button in production test mode). */
export const _stopProdTestMode = () => reloadInMode('isDebug', 'isProdTest');

/** A toast of the camera that is now active: the debug camera, or the app camera by name (with
 * the same icons as the on-screen debug camera button and camera dropdown). */
const showActiveCameraToast = () => {
  if (isDebugCameraActive()) {
    addDebugToast({ title: 'Debug camera', icon: getSvgIcon('aspectRatio') });
    return;
  }
  const appCamId = getMainAppCameraId();
  const appCamName = getAllCamerasAsArray().find((c) => c.appId === appCamId)?.name;
  addDebugToast({
    title: 'App camera',
    message: appCamName || 'No app camera',
    icon: getSvgIcon('camera'),
  });
};

/** Toggles between the debug camera and the app camera (F1, the debug camera button). */
export const _toggleDebugCameraWithToast = () => {
  toggleDebugCamera(getECSWorld(), !isDebugCameraActive());
  _updateOnScreenTools('SWITCH');
  showActiveCameraToast();
};

// PLAY TOOLS
const playTools = () => {
  const hudRootCMP = getHUDRootCMP();
  if (!hudRootCMP) return;

  if (playToolsCMP) playToolsCMP.remove();
  playToolsCMP = null;

  // Toggled in the Debug Tools Controls tab ("On-screen tools" folder); read from LS
  // here because that tab (and its state loading) never runs in prodTest mode itself.
  if (IS_PROD_TEST_MODE && !getDebugToolsState(true).onScreenTools.showOnScreenToolsInProdTest) {
    return;
  }

  playToolsCMP = CMP({ class: [styles.onScreenToolGroup, 'onScreenToolGroup', 'playTools'] });

  const buttonBaseClasses = [styles.onScreenTool, 'onScreenTool'];

  if (!IS_PROD_TEST_MODE) {
    // Play prod test
    const playProdTestBtn = CMP({
      class: buttonBaseClasses,
      html: () => `<button>${getSvgIcon('playFill')}</button>`,
      attr: { title: 'Play in production test mode (F5)' },
      onClick: (e) => {
        e.stopPropagation();
        _playInProdTestMode();
      },
    });
    playToolsCMP.add(playProdTestBtn);
  } else {
    // Stop prod test
    const stopProdTestBtn = CMP({
      class: buttonBaseClasses,
      html: () => `<button>${getSvgIcon('stop')}</button>`,
      attr: { title: 'Stop production test mode (F5)' },
      onClick: (e) => {
        e.stopPropagation();
        _stopProdTestMode();
      },
    });
    playToolsCMP.add(stopProdTestBtn);
  }

  // App loop button
  const loopState = getReadOnlyLoopState();
  const mainLoopBtn = CMP({
    class: [
      ...buttonBaseClasses,
      ...(loopState.masterPlay ? [styles.active, 'onScreenToolActive'] : []),
    ],
    html: () => `<button>${getSvgIcon('infinity')}</button>`,
    attr: {
      title: `Play main loop (F6, currently ${loopState.masterPlay ? 'playing' : 'not playing'})`,
    },
    onClick: (e) => {
      e.stopPropagation();
      toggleMainPlay();
      _updateOnScreenTools('PLAY');
    },
  });
  playToolsCMP.add(mainLoopBtn);

  const appLoopBtn = CMP({
    class: [
      ...buttonBaseClasses,
      ...(!loopState.appPlay ? [styles.active, 'onScreenToolActive'] : []),
    ],
    html: () => `<button>${getSvgIcon('pause')}</button>`,
    attr: {
      title: `Pause app loop (F7, currently ${loopState.appPlay ? 'playing' : 'not playing'})`,
    },
    onClick: (e) => {
      e.stopPropagation();
      toggleAppPlay();
      _updateOnScreenTools('PLAY');
    },
  });
  playToolsCMP.add(appLoopBtn);

  hudRootCMP.add(playToolsCMP);
};

// SWITCH TOOLS
const switchTools = () => {
  const hudRootCMP = getHUDRootCMP();
  if (!hudRootCMP) return;

  if (switchToolsCMP) switchToolsCMP.remove();
  switchToolsCMP = CMP({ class: [styles.onScreenToolGroup, 'onScreenToolGroup', 'switchTools'] });

  const isDebugActive = isDebugCameraActive();

  // Use debug cam button
  const useDebugCamBtnClasses = [styles.onScreenTool, 'onScreenTool'];
  if (isDebugActive) useDebugCamBtnClasses.push(styles.active, 'onScreenToolActive');

  const useDebugCamBtn = CMP({
    class: useDebugCamBtnClasses,
    html: () => `<button>${getSvgIcon('aspectRatio')}</button>`,
    attr: { title: 'Toggle between debug camera and app camera' },
    onClick: (e) => {
      e.stopPropagation();
      _toggleDebugCameraWithToast();
    },
  });

  // Select camera dropdown
  const selectDropdownClasses = [
    styles.onScreenTool,
    styles.onScreenToolDropDown,
    'onScreenTool',
    'onScreenDropDown',
  ];
  const camSelectorId = 'onScreenSelectCamDropDown';

  const allAppCameras = getAllCamerasAsArray();
  const currentAppCamId = getMainAppCameraId();

  // Find the current app camera's human-readable name
  const currentAppCam = allAppCameras.find((c) => c.appId === currentAppCamId);
  const currentAppCamName = currentAppCam ? currentAppCam.name : 'No App Camera';

  // The dummy option now uses the App Camera's name.
  // It is 'hidden' from the expanded list but shows when the dropdown is closed.
  let camOptions = isDebugActive
    ? `<option value="_debug_placeholder_" disabled selected hidden>${currentAppCamName}</option>`
    : '';

  camOptions += allAppCameras
    .map((cam) => {
      // Only mark it selected if the debug camera is OFF
      const isSelected = !isDebugActive && currentAppCamId === cam.appId;
      return `<option value="${cam.appId}"${isSelected ? ' selected="true"' : ''}>${cam.name}</option>`;
    })
    .join('');

  // Apply the strikethrough to the <select> element itself when debug is active.
  const selectStyle = isDebugActive ? ' style="text-decoration: line-through; opacity: 0.6;"' : '';

  const camSelectCMP = CMP({
    id: camSelectorId,
    idAttr: true,
    html: () => `<select title="Change camera"${selectStyle}>\n  ${camOptions}\n</select>`,
    onInput: (e) => {
      const target = e.target as HTMLSelectElement;
      const selectedAppId = target.options[target.options.selectedIndex].value;
      if (!selectedAppId || selectedAppId === '_debug_placeholder_') return;

      setCurrentCamera(selectedAppId);

      if (isDebugCameraActive()) {
        toggleDebugCamera(getECSWorld(), false);
      }

      _updateOnScreenTools('SWITCH');
      showActiveCameraToast();
    },
  });

  const selectCamDropDown = CMP({
    class: [
      ...selectDropdownClasses,
      ...(!isDebugActive ? [styles.active, 'onScreenToolActive'] : []),
    ],
    html: () => `<label for="${camSelectorId}">
  ${getSvgIcon('camera', 'small')}
  ${camSelectCMP}
</label>`,
  });

  // Select scene dropdown
  const sceneSelectorId = 'onScreenSelectSceneDropDown';
  const scenes = getGeneratedAppData().scenes as unknown as { [id: string]: SceneAsset };
  const generatedSceneIds = Object.keys(scenes);
  const currentActiveSceneId = getCurrentSceneId();
  const sceneOptions = generatedSceneIds
    .map((id) => {
      const isSelected = currentActiveSceneId === id;
      // Use the config name attribute if declared, otherwise fall back to raw key string ID
      const label = scenes[id as keyof typeof scenes]?.name || `[${id}]`;
      return `<option value="${id}"${isSelected ? ' selected="true"' : ''}>${label}</option>`;
    })
    .join('\n');

  const sceneSelectCMP = CMP({
    id: sceneSelectorId,
    idAttr: true,
    html: () => `<select title="Change scene">
      ${sceneOptions}
    </select>`,
    onInput: (e) => {
      const target = e.target as HTMLSelectElement;
      const value = target.options[target.options.selectedIndex].value;

      if (isCurrentlyLoading()) return; // Protection block

      loadScene({
        sceneId: value,
        // If a classic panel matches, pass it. Otherwise, pass undefined so it reads sceneFileObjects natively
        loaderId: DEBUGGER_SCENE_LOADER_ID,
      });
    },
  });

  const selectSceneDropDown = CMP({
    class: selectDropdownClasses,
    html: () => `<label for="${sceneSelectorId}">
      ${getSvgIcon('easel', 'small')}
      ${sceneSelectCMP}
    </label>`,
  });

  // Light helpers toggle
  const toggleLightHelpersBtnClasses = [styles.onScreenTool, 'onScreenTool'];
  if (isAnyLightHelperVisible()) {
    toggleLightHelpersBtnClasses.push(styles.active, 'onScreenToolActive');
  }
  const toggleLightHelpersBtn = CMP({
    class: toggleLightHelpersBtnClasses,
    html: () => `<button>${getSvgIcon('lamp', 'small')}</button>`,
    attr: { title: 'Hide / show all light helpers' },
    onClick: (e) => {
      e.stopPropagation();
      toggleAllLightHelpers();
      _updateOnScreenTools('SWITCH');
    },
  });

  // Camera helpers toggle
  const toggleCameraHelpersBtnClasses = [styles.onScreenTool, 'onScreenTool'];
  if (isAnyCameraHelperVisible()) {
    toggleCameraHelpersBtnClasses.push(styles.active, 'onScreenToolActive');
  }
  const toggleCameraHelpersBtn = CMP({
    class: toggleCameraHelpersBtnClasses,
    html: () => `<button>${getSvgIcon('cameraReels', 'small')}</button>`,
    attr: { title: 'Hide / show all camera helpers' },
    onClick: (e) => {
      e.stopPropagation();
      toggleAllCameraHelpers();
      _updateOnScreenTools('SWITCH');
    },
  });

  // Physics wireframes master visibility toggle. A display-only filter over whatever
  // per-entity wireframes are already switched on (see _dbg__PhysicsDebugDraw.ts) — it
  // never adds/removes any entity's own DEBUG_PHYSICS_WIREFRAME toggle.
  const physicsState = getPhysicsState();
  const togglePhysicsHelpersBtn = CMP({
    class: [
      styles.onScreenTool,
      'onScreenTool',
      ...(useDebug(physicsDebugDrawRef)?.isWireframeMasterVisible() ?? true
        ? [styles.active, 'onScreenToolActive']
        : []),
    ],
    html: () => `<button>${getSvgIcon('rocket', 'small')}</button>`,
    attr: { title: 'Hide / show all physics wireframes' },
    onClick: (e) => {
      e.stopPropagation();
      useDebug(physicsDebugDrawRef)?.toggleWireframeMasterVisible();
      _updateOnScreenTools('SWITCH');
    },
  });

  switchToolsCMP.add(useDebugCamBtn);
  switchToolsCMP.add(selectCamDropDown);
  switchToolsCMP.add(selectSceneDropDown);
  switchToolsCMP.add(toggleLightHelpersBtn);
  switchToolsCMP.add(toggleCameraHelpersBtn);
  if (physicsState.enabled) switchToolsCMP.add(togglePhysicsHelpersBtn);

  hudRootCMP.add(switchToolsCMP);
};

// UNDO / REDO TOOLS
// Debug environment only (never prod test mode, which has no debugger to make edits with) —
// the IS_PROD_TEST_MODE early returns in _InitOnScreenTools/_updateOnScreenTools keep it out.
// The undo/redo module refreshes this group itself (updateOnScreenTools('UNDO')) whenever
// the history changes.
const undoRedoTools = () => {
  const hudRootCMP = getHUDRootCMP();
  if (!hudRootCMP) return;

  if (undoRedoToolsCMP) undoRedoToolsCMP.remove();
  undoRedoToolsCMP = CMP({
    class: [styles.onScreenToolGroup, 'onScreenToolGroup', 'undoRedoTools'],
  });

  const undoBtn = CMP({
    class: [styles.onScreenTool, 'onScreenTool'],
    html: () => `<button${!canUndo() ? ' disabled' : ''}>${getSvgIcon('undo')}</button>`,
    attr: { title: 'Undo (Ctrl+Z / ⌘Z)' },
    onClick: (e) => {
      e.stopPropagation();
      undoLastAction();
    },
  });
  undoRedoToolsCMP.add(undoBtn);

  const redoBtn = CMP({
    class: [styles.onScreenTool, 'onScreenTool'],
    html: () => `<button${!canRedo() ? ' disabled' : ''}>${getSvgIcon('redo')}</button>`,
    attr: { title: 'Redo (Ctrl+Shift+Z / ⇧⌘Z)' },
    onClick: (e) => {
      e.stopPropagation();
      redoLastAction();
    },
  });
  undoRedoToolsCMP.add(redoBtn);

  hudRootCMP.add(undoRedoToolsCMP);
};

export const _InitOnScreenTools = () => {
  if (!IS_DEBUG_ENV && !IS_PROD_TEST_MODE) return;

  if (IS_PROD_TEST_MODE) {
    playTools();
    return;
  }

  playTools();
  switchTools();
  undoRedoTools();
};

const updateTool = (toolType: ToolTypes) => {
  switch (toolType) {
    case 'PLAY':
      playTools();
      break;
    case 'SWITCH':
      switchTools();
      break;
    case 'UNDO':
      undoRedoTools();
      break;
  }
};

export const _updateOnScreenTools = (tools?: ToolTypes[] | ToolTypes) => {
  if (!IS_DEBUG_ENV && !IS_PROD_TEST_MODE) return;

  if (IS_PROD_TEST_MODE) {
    playTools();
    return;
  }

  // Updates all tools
  if (!tools) {
    _InitOnScreenTools();
    return;
  }

  if (Array.isArray(tools)) {
    // Update an array of selected tools
    for (let i = 0; i < tools.length; i++) {
      updateTool(tools[i]);
    }
    return;
  }

  // Update one tool
  updateTool(tools);
};
