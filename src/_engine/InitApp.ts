import { loadConfig } from './core/Config';
import { initMainLoop } from './core/MainLoop';
import { InitPhysics } from './core/Physics';
import { getCurrentScene, getCurrentSceneId } from './core/Scene';
import './styles/index.scss';
import { lerror } from './utils/Logger';

/**
 * Initializes the engine and injects the start function (startFn) into the engine
 * @param appStartFn (function) app start function, () => Promise<undefined>
 */
export const InitEngine = async (appStartFn: () => void) => {
  // Load env variables and other configurations
  loadConfig();

  // Start app
  try {
    appStartFn();
  } catch (err) {
    const msg = 'Error at app start function';
    lerror(msg, err);
    throw new Error(msg);
  }

  // Init physics
  InitPhysics();

  const currentScene = getCurrentScene();
  const currentSceneId = getCurrentSceneId();
  if (!currentScene || !currentSceneId) {
    const msg = 'Could not find current scene in InitEngine';
    lerror(msg);
    return;
  }

  // Start engine/loop
  initMainLoop();
};
