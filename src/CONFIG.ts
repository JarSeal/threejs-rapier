import { AppConfig } from './_engine/core/Config';
import { editObjectPropsContentFn } from './_engine/core/UI/DragWinContents/EditObjectProps';
import { toggleDrawer } from './_engine/debug/DebuggerGUI';
import { debuggerSceneListing } from './_engine/debug/debugScenes/debuggerSceneListing';
import { createEditLightContent, EDIT_LIGHT_WIN_ID } from './_engine/core/Light';
import { createEditCameraContent, EDIT_CAMERA_WIN_ID } from './_engine/core/Camera';
import {
  CHAR_EDIT_WIN_ID,
  CHAR_TRACKER_WIN_ID,
  createEditCharacterContent,
  createTrackCharacterContent,
} from './_engine/core/Character';

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
    additionalFrictionIterations: 4,
  },
  draggableWindows: {
    [EDIT_LIGHT_WIN_ID]: { contentFn: createEditLightContent },
    [EDIT_CAMERA_WIN_ID]: { contentFn: createEditCameraContent },
    [CHAR_EDIT_WIN_ID]: { contentFn: createEditCharacterContent },
    [CHAR_TRACKER_WIN_ID]: { contentFn: createTrackCharacterContent },
    myFirstDraggableTest: { contentFn: editObjectPropsContentFn }, // @TODO: remove this
  },
};

export default config;
