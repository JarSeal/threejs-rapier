import { AppConfig } from './_engine/core/Config';
import { editObjectPropsContentFn } from './_engine/core/UI/DragWinContents/EditObjectProps';
import { toggleDrawer } from './_engine/debug/DebuggerGUI';
import { debuggerSceneListing } from './_engine/debug/debugScenes/debuggerSceneListing';
import { createEditLightContent } from './_engine/core/Light';
import { createEditCameraContent } from './_engine/core/Camera';

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
    additionalFrictionIterations: 4,
  },
  draggableWindows: {
    lightEditorWindow: { contentFn: createEditLightContent },
    cameraEditorWindow: { contentFn: createEditCameraContent },
    myFirstDraggableTest: { contentFn: editObjectPropsContentFn }, // @TODO: remove this
  },
};

export default config;
