import { AppConfig } from './_engine/core/Config';
import { toggleDrawer } from './_engine/debug/DebuggerGUI';
import { debuggerSceneListing } from './_engine/debug/debugScenes/debuggerSceneListing';

export const MAIN_APP_CAM_ID = 'mainAppCam';

const config: AppConfig = {
  debugKeys: [
    {
      enabled: true,
      id: 'sc-toggle-debug-drawer',
      key: ['h', 'H'],
      type: 'KEY_UP',
      fn: () => toggleDrawer(),
    },
  ],
  debugScenes: debuggerSceneListing,
  physics: {
    enabled: true,
    worldStepEnabled: true,
    visualizerEnabled: false,
    gravity: { x: 0, y: -9.81, z: 0 },
    timestep: 60,
    solverIterations: 10,
    internalPgsIterations: 1,
    interpolationEnabled: true,
  },
};

export default config;
