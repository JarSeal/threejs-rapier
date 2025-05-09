import { Pane } from 'tweakpane';
import { AppConfig } from './_engine/core/Config';
import { editObjectPropsContentFn } from './_engine/core/UI/DragWinContents/EditObjectProps';
import { toggleDrawer } from './_engine/debug/DebuggerGUI';
import { debuggerSceneListing } from './_engine/debug/debugScenes/debuggerSceneListing';
import { buildStatsDebugGUI } from './_engine/debug/Stats';
import { CMP } from './_engine/utils/CMP';
import { createEditLightContent } from './_engine/core/Light';

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
    worldStepEnabled: false,
    gravity: { x: 0, y: -9.81, z: 0 },
    timestep: 60,
  },
  draggableWindows: {
    lightEditorWindow: { contentFn: createEditLightContent },
    myFirstDraggableTest: { contentFn: editObjectPropsContentFn },
    statsDraggableWin: {
      contentFn: () => {
        const cmp = CMP();
        const debugGUI = new Pane({ container: cmp.elem });
        buildStatsDebugGUI(debugGUI);
        return cmp;
      },
    },
  },
};

export default config;
