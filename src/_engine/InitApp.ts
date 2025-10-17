import { type Scene } from 'three/webgpu';
import { isDebugEnvironment, loadConfig } from './core/Config';
import { createHudContainer, getHUDRootCMP } from './core/HUD';
import { initMainLoop } from './core/MainLoop';
import { createPhysicsDebugMesh, InitRapierPhysics } from './core/PhysicsRapier';
import { createRootScene, getRootScene } from './core/Scene';
import './styles/index.scss';
import { lerror } from './utils/Logger';
import { buildSkyBoxDebugGUI } from './core/SkyBox';
import { createDebuggerSceneLoader } from './debug/DebuggerSceneLoader';
import { createRendererDebugGUI } from './core/Renderer';
import { loadDraggableWindowStatesFromLS } from './core/UI/DraggableWindow';
import { createLightsDebuggerGUI } from './core/Light';
import { createCamerasDebuggerGUI } from './core/Camera';
import { createCharactersDebuggerGUI } from './core/Character';
import { createToaster } from './core/UI/Toaster';

/**
 * Initializes the engine and injects the start function (startFn) into the engine
 * @param appStartFn (function) app start function, () => Promise<undefined>
 */
export const InitEngine = async (appStartFn: () => Promise<undefined>) => {
  // Start app
  try {
    // Load env variables and other configurations
    loadConfig();

    // Create base scene
    createRootScene();

    // HUD container
    createHudContainer();

    await InitRapierPhysics();
    await appStartFn();

    // Start engine/loop if root scene has children
    const rootScene = getRootScene() as Scene;
    if (rootScene.children.length) await initMainLoop();

    // Create debug GUIs and utils
    if (isDebugEnvironment()) {
      createRendererDebugGUI();
      createLightsDebuggerGUI();
      createCamerasDebuggerGUI();
      createCharactersDebuggerGUI();
      createPhysicsDebugMesh();
      buildSkyBoxDebugGUI();
      createDebuggerSceneLoader();
      getHUDRootCMP().add(
        createToaster({ id: 'debugToaster', settings: { offset: { x: '18px', y: '-268px' } } })
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
