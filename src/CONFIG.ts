import { AppConfig } from './_engine/core/Config';
import { toggleDrawer } from './_engine/debug/DebuggerGUI';

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
  physics: {
    enabled: true,
    worldStepEnabled: true,
    visualizerEnabled: false,
    gravity: { x: 0, y: -9.81, z: 0 },
    timestep: 60,
    solverIterations: 10,
    internalPgsIterations: 1,
    interpolationMode: 'FIXED_PHYSICS',
    workerTarget: 'WORKER_THREAD',
    useSAB: true,
  },
  // Per-state colors (0xrrggbb) for the physics collider wireframes, switched on per
  // entity from the Physics API debugger tab. Omit the whole section, or any single key,
  // to take the engine defaults instead.
  debugPhysicsWireframe: {
    colors: {
      disabled: 0x555555, // dark grey
      sensor: 0xb8a000, // dark yellow
      sleeping: 0x8b0000, // dark red
      kinematic: 0x2266ff, // blue
      fixed: 0xdddddd, // light grey
      awake: 0xff0000, // red
    },
    lineThickness: 1,
  },
  debugCamera: {
    position: { x: 3, y: 3, z: 1.5 },
    target: { x: 0, y: 0, z: 0 },
    fov: 60,
    near: 0.1,
    far: 1000,
    zoom: 1,
  },
};

export default config;
