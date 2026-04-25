import { type Scene } from 'three/webgpu';
import { isDebugEnvironment, loadConfig, PROJECT_METADATA } from './core/Config';
import { createHudContainer, getHUDRootCMP } from './core/HUD';
import { initMainLoop } from './core/MainLoop';
import { InitRapierPhysics } from './core/PhysicsRapier';
import { createRootScene, getRootScene } from './core/Scene';
import './styles/index.scss';
import { lerror, llog } from './utils/Logger';
import { createSkyBoxDebugGUI } from './core/SkyBox';
import { createDebuggerSceneLoader } from './debug/DebuggerSceneLoader';
import { createRendererDebugGUI } from './core/Renderer';
import { loadDraggableWindowStatesFromLS } from './core/UI/DraggableWindow';
import { createLightsDebuggerGUI } from './core/Light';
import { createCharactersDebuggerGUI } from './core/Character';
import { createToaster } from './core/UI/Toaster';
import { getStatsCmp } from './debug/Stats';
import { getSvgIcon } from './core/UI/icons/SvgIcon';

// ECS Core Plugins
import './core/ECS/ECSCoreSystems';
import './core/_MeshManager';

// App Plugins
import '../AppECSPlugins';

import { initECSWorld } from './core/ECS';
import { initDebugCamera } from './core/_CameraManager';

/**
 * Initializes the engine and injects the start function (startFn) into the engine
 * @param appStartFn (function) app start function, () => Promise<undefined>
 */
export const InitEngine = async (appStartFn: () => Promise<undefined>) => {
  // Start app
  try {
    // Load env variables and other configurations
    loadConfig();

    // Sets the engine version to the HTML
    setEngineVersionToDOM();

    // Create base scene
    createRootScene();

    // Init ECS
    const ecsWorld = initECSWorld();

    // Initializes the debug camera (if in debug mode)
    await initDebugCamera(ecsWorld);

    // HUD container
    createHudContainer();

    await InitRapierPhysics();
    await appStartFn();

    // Start engine/loop if root scene has children
    const rootScene = getRootScene() as Scene;
    if (rootScene.children.length) initMainLoop();

    // Create debug GUIs and utils
    if (isDebugEnvironment()) {
      createRendererDebugGUI();
      createLightsDebuggerGUI();
      createCharactersDebuggerGUI();
      createSkyBoxDebugGUI();
      createDebuggerSceneLoader();

      // Make the debug toaster appear above the stats cmp
      const statsCmp = getStatsCmp();
      let yOffset = '-268px';
      if (statsCmp) yOffset = `${-statsCmp.elem.offsetHeight - 16}px`;
      getHUDRootCMP().add(
        createToaster({
          id: 'debugToaster',
          settings: {
            animationTimeMs: 200,
            verticalPosition: 'bottom',
            horizontalPosition: 'left',
            toastDirection: 'up',
            toastAppearFromDirection: 'left',
            offset: { x: '18px', y: yOffset },
            closeBtnIcon: getSvgIcon('x'),
            icons: {
              info: getSvgIcon('info'),
              warning: getSvgIcon('warning'),
              alert: getSvgIcon('alert'),
            },
          },
        })
      );
    }

    // Load draggableWindow states
    loadDraggableWindowStatesFromLS();
  } catch (err) {
    const msg = 'Error at app start function (InitEngine)';
    lerror(msg, err);
    throw new Error(msg);
  }
};

const consoleBootText = () => {
  const meta = PROJECT_METADATA;

  // Define styles
  const sBrand = 'color: #00d4ff; font-weight: bold; font-size: 1.2em;';
  const sInfo = 'color: #888;';
  const sBlue = 'color: #00d2ff; font-weight: bold;';
  const sEng = 'color: #ff9955; font-style: italic;';
  const sApp = 'color: #ff9955; font-style: italic;';

  llog(
    `%c${meta.engine.name}%c starting...\n` +
      `%cEngine version: %c${meta.engine.version} %c${meta.engine.codename}\n` +
      `%cApp version: %c${meta.app.version} %c${meta.app.codename}\n` +
      `%cVersion checksum: %c${meta.versionChecksum}`,
    // Line 1 styles
    sBrand,
    sInfo,
    // Line 2 styles
    sInfo,
    sBlue,
    sEng,
    // Line 3 styles
    sInfo,
    sBlue,
    sApp,
    // Line 4 styles
    sInfo,
    sBlue
  );
};

const setEngineVersionToDOM = () => {
  consoleBootText();
  // @CHORE: add metadata as header metadata tag (remove these below)
  const elemEng = document.getElementById('engineVersion');
  if (elemEng) elemEng.textContent = PROJECT_METADATA.engine.version;
  const elemApp = document.getElementById('appVersion');
  if (elemApp) elemApp.textContent = PROJECT_METADATA.app.version;
};
