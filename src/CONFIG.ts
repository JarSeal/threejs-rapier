import { AppConfig } from './_engine/core/Config';
import { toggleDrawer } from './_engine/debug/DebuggerGUI';

const config: AppConfig = {
  debugKeys: [
    {
      enabled: true,
      id: 'sc-toggle-debug-drawer',
      key: 'h',
      fn: () => toggleDrawer(),
    },
  ],
  physics: {
    enabled: true,
    gravity: { x: 0, y: -9.81, z: 0 },
    timestep: 60,
  },
};

export default config;
