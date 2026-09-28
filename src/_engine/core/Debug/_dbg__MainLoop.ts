import { createDebuggerTab } from '../../debug/DebuggerGUI';
import { LOOP_DEBUGGER_TAB_ID, mainLoop, type LoopState } from '../MainLoop';
import { InitOnScreenTools, updateOnScreenTools } from '../../debug/OnScreenTools';

const LS_KEY = 'AEK_debugLoop';

/**
 * Registers the Loop tab. It also hydrates loopState's persisted values (in prod test mode
 * too, where the drawer itself doesn't exist), so call it before loopState is used.
 */
export const createLoopDebugControls = (loopState: LoopState) => {
  createDebuggerTab({
    id: LOOP_DEBUGGER_TAB_ID,
    title: 'Loop controls',
    icon: 'infinity',
    lsKey: LS_KEY,
    state: loopState,
    persistKeys: ['masterPlay', 'appPlay', 'maxFPS', 'playSpeedMultiplier'],
    content: () => [
      {
        pane: true,
        content: [
          {
            key: 'masterPlay',
            label: 'Master loop',
            onChange: (value) => {
              if (value) requestAnimationFrame(mainLoop);
              updateOnScreenTools('PLAY');
            },
          },
          { key: 'appPlay', label: 'App loop', onChange: () => updateOnScreenTools('PLAY') },
          {
            key: 'maxFPS',
            label: 'Forced max FPS (0 = off)',
            step: 1,
            min: 0,
            onChange: (value) => {
              if (Number(value) > 0) loopState.maxFPSInterval = 1000 / Number(value);
            },
          },
          { key: 'playSpeedMultiplier', label: 'Play speed multiplier', step: 0.01, min: 0 },
        ],
      },
    ],
  });

  // maxFPSInterval is derived, not persisted
  if (loopState.maxFPS > 0) loopState.maxFPSInterval = 1000 / loopState.maxFPS;

  // After the hydration above: the tools render from loopState
  InitOnScreenTools();
};
