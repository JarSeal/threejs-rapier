import {
  getAllCamerasAsArray,
  getMainAppCameraId,
  isAnyCameraHelperVisible,
  isDebugCameraActive,
  setCurrentCamera,
  toggleAllCameraHelpers,
  toggleDebugCamera,
} from '../core/_CameraManager';
import { isDebugEnvironment, isProdTestMode } from '../core/Config';
import { getHUDRootCMP } from '../core/HUD';
import { isAnyLightHelperVisible, toggleAllLightHelpers } from '../core/_LightManager';
import { getReadOnlyLoopState, toggleAppPlay, toggleMainPlay } from '../core/MainLoop';
import {
  buildPhysicsDebugGUI,
  getPhysicsState,
  togglePhysicsVisualizer,
} from '../core/PhysicsRapier';
import { getCurrentSceneId } from '../core/Scene';
import { isCurrentlyLoading, loadScene } from '../core/SceneLoader';
import { getSvgIcon } from '../core/UI/icons/SvgIcon';
import { CMP, TCMP } from '../utils/CMP';
import { lerror } from '../utils/Logger';
import { DEBUGGER_SCENE_LOADER_ID } from './DebuggerSceneLoader';
import { debuggerSceneListing } from './debugScenes/debuggerSceneListing';
import styles from './OnScreenTools.module.scss';
import { getECSWorld } from '../core/ECS';

let playToolsCMP: TCMP | null = null;
let switchToolsCMP: TCMP | null = null;

// PLAY TOOLS
const playTools = () => {
  const hudRootCMP = getHUDRootCMP();
  if (!hudRootCMP) return;

  const isProdTest = isProdTestMode();

  if (playToolsCMP) playToolsCMP.remove();
  playToolsCMP = CMP({ class: [styles.onScreenToolGroup, 'onScreenToolGroup', 'playTools'] });

  const buttonBaseClasses = [styles.onScreenTool, 'onScreenTool'];

  if (!isProdTest) {
    // Play prod test
    const playProdTestBtn = CMP({
      class: buttonBaseClasses,
      html: () => `<button>${getSvgIcon('playFill')}</button>`,
      attr: { title: 'Play in production test mode' },
      onClick: (e) => {
        e.stopPropagation();
        const queryData = new URLSearchParams(window.location.search.slice(1));
        queryData.set('isProdTest', 'true');
        queryData.delete('isDebug');
        const newUrl = new URL(window.location.href);
        newUrl.search = queryData.toString();
        window.location.href = newUrl.toString();
      },
    });
    playToolsCMP.add(playProdTestBtn);
  } else {
    // Stop prod test
    const stopProdTestBtn = CMP({
      class: buttonBaseClasses,
      html: () => `<button>${getSvgIcon('stop')}</button>`,
      attr: { title: 'Stop production test mode' },
      onClick: (e) => {
        e.stopPropagation();
        const queryData = new URLSearchParams(window.location.search.slice(1));
        queryData.set('isDebug', 'true');
        queryData.delete('isProdTest');
        const newUrl = new URL(window.location.href);
        newUrl.search = queryData.toString();
        window.location.href = newUrl.toString();
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
      title: `Play main loop (currently ${loopState.masterPlay ? 'playing' : 'not playing'})`,
    },
    onClick: (e) => {
      e.stopPropagation();
      toggleMainPlay();
      updateOnScreenTools('PLAY');
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
      title: `Pause app loop (currently ${loopState.appPlay ? 'playing' : 'not playing'})`,
    },
    onClick: (e) => {
      e.stopPropagation();
      toggleAppPlay();
      updateOnScreenTools('PLAY');
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
      // Directly toggle ECS state
      toggleDebugCamera(getECSWorld(), !isDebugActive);
      updateOnScreenTools('SWITCH');
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

      updateOnScreenTools('SWITCH');
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
  const sceneOptions = debuggerSceneListing.map(
    (s) =>
      `<option value="${s.id}"${getCurrentSceneId() === s.id ? ' selected="true"' : ''}>${s.text || `[${s.id}]`}</option>`
  );
  const sceneSelectCMP = CMP({
    id: sceneSelectorId,
    idAttr: true,
    html: () => `<select title="Change scene">
  ${sceneOptions}
</select>`,
    onInput: (e) => {
      const target = e.target as HTMLSelectElement;
      const value = target.options[target.options.selectedIndex].value;
      const nextScene = debuggerSceneListing.find((s) => s.id === value);
      if (!isCurrentlyLoading() && nextScene) {
        loadScene({ nextSceneFn: nextScene.fn, loaderId: DEBUGGER_SCENE_LOADER_ID });
        return;
      }
      if (!isCurrentlyLoading) {
        lerror(
          `Could not find scene with id '${value}' in scenes on screen switcher tools dropdown.`
        );
      }
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
      updateOnScreenTools('SWITCH');
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
      updateOnScreenTools('SWITCH');
    },
  });

  // Physics visualizer toggle
  const physicsState = getPhysicsState();
  const togglePhysicsHelpersBtn = CMP({
    class: [
      styles.onScreenTool,
      'onScreenTool',
      ...(physicsState.scenes[getCurrentSceneId() || '']?.visualizerEnabled
        ? [styles.active, 'onScreenToolActive']
        : []),
    ],
    html: () => `<button>${getSvgIcon('rocket', 'small')}</button>`,
    attr: { title: 'Hide / show physics visualizer' },
    onClick: (e) => {
      e.stopPropagation();
      togglePhysicsVisualizer(!physicsState.scenes[getCurrentSceneId() || '']?.visualizerEnabled);
      buildPhysicsDebugGUI();
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

export const InitOnScreenTools = () => {
  if (!isDebugEnvironment() && !isProdTestMode()) return;

  if (isProdTestMode()) {
    playTools();
    return;
  }

  playTools();
  switchTools();
};

type ToolTypes = 'SWITCH' | 'PLAY';

const updateTool = (toolType: ToolTypes) => {
  switch (toolType) {
    case 'PLAY':
      playTools();
    case 'SWITCH':
      switchTools();
  }
};

export const updateOnScreenTools = (tools?: ToolTypes[] | ToolTypes) => {
  if (!isDebugEnvironment() && !isProdTestMode()) return;

  if (isProdTestMode()) {
    playTools();
    return;
  }

  // Updates all tools
  if (!tools) {
    InitOnScreenTools();
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
