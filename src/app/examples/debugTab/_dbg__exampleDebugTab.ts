import { createDebuggerTab } from '../../../_engine/debug/DebuggerGUI';
import {
  BOX_DEFAULTS,
  boxSettings,
  buildBoxes,
  DEBUG_TAB_SCENE_ID,
  getBoxCount,
  setBoxColor,
  shuffleBoxes,
} from './exampleDebugTab';

// #region debug-tab (shown in the Hub: hub/pages/examples/debug-tab/)
/** The example scene's "Boxes" tab: a scene tab, removed on the scene's exit */
export const createBoxesTab = () => {
  // Read-only figures, refreshed while the tab is visible
  const info = { boxes: 0 };

  createDebuggerTab({
    id: 'exampleBoxes',
    title: 'Boxes',
    icon: 'geometry',
    sceneId: DEBUG_TAB_SCENE_ID,
    // The bindings bind to the scene's own settings, and these keys are saved under lsKey. They
    // are loaded into the object right here, when the tab is created.
    state: boxSettings,
    lsKey: 'AEK_debugExampleBoxes',
    persistKeys: ['count', 'color'],
    // The heading's clear button removed the saved keys: back to the defaults
    onClearLS: () => {
      boxSettings.count = BOX_DEFAULTS.count;
      setBoxColor(BOX_DEFAULTS.color);
      buildBoxes();
    },
    refreshIntervalMs: 500,
    onRefresh: () => {
      info.boxes = getBoxCount();
    },
    content: () => [
      {
        pane: true,
        content: [
          // onChange runs on user input only, after the value is saved
          { key: 'count', label: 'Boxes', min: 1, max: 60, step: 1, onChange: buildBoxes },
          {
            key: 'color',
            label: 'Colour',
            view: 'color',
            onChange: (value) => setBoxColor(String(value)),
          },
          { type: 'button', title: 'Shuffle', label: 'Random places', onClick: shuffleBoxes },
          { type: 'separator' },
          { key: 'boxes', target: info, label: 'In the scene', readonly: true, format: String },
        ],
      },
    ],
  });
};
// #endregion debug-tab
