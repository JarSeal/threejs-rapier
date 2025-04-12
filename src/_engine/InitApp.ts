import { isDebugEnvironment, loadConfig } from './core/Config';
import { createHudContainer } from './core/HUD';
import { initMainLoop } from './core/MainLoop';
import { createPhysicsDebugMesh } from './core/PhysicsRapier';
import { getCurrentScene, getCurrentSceneId } from './core/Scene';
import './styles/index.scss';
import { lerror } from './utils/Logger';

/**
 * Initializes the engine and injects the start function (startFn) into the engine
 * @param appStartFn (function) app start function, () => Promise<undefined>
 */
export const InitEngine = async (appStartFn: () => Promise<undefined>) => {
  // Load env variables and other configurations
  loadConfig();

  // HUD container
  createHudContainer();

  // Start app
  try {
    await appStartFn();
  } catch (err) {
    const msg = 'Error at app start function';
    lerror(msg, err);
    throw new Error(msg);
  }

  const currentScene = getCurrentScene();
  const currentSceneId = getCurrentSceneId();
  if (!currentScene || !currentSceneId) {
    const msg = 'Could not find current scene in InitEngine';
    lerror(msg);
    return;
  }

  if (isDebugEnvironment()) {
    createPhysicsDebugMesh();
  }

  // Start engine/loop
  initMainLoop();
};
