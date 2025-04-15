import { AppConfig } from './_engine/core/Config';
import { toggleDrawer } from './_engine/debug/DebuggerGUI';
import { debugSceneListing } from './_engine/debug/DebugSceneListing';

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
  debugScenes: debugSceneListing,
  physics: {
    enabled: true,
    worldStepEnabled: true,
    gravity: { x: 0, y: -9.81, z: 0 },
    timestep: 60,
  },
};

export default config;
