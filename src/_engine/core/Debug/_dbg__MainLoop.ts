import { BindingApi } from '@tweakpane/core';
import { isProdTestMode } from '../Config';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { stepPhysicsWorld } from '../PhysicsRapier';
import { mainLoop, type LoopState } from '../MainLoop';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { InitOnScreenTools, updateOnScreenTools } from '../../debug/OnScreenTools';

const LS_KEY = 'AEK_debugLoop';
let appPlayBinding: BindingApi | null = null;

export const createLoopDebugControls = (loopState: LoopState) => {
  // Init On Screen Tools
  InitOnScreenTools();

  if (!isProdTestMode) return;

  const icon = getSvgIcon('infinity');
  createDebuggerTab({
    id: 'loopControls',
    buttonText: icon,
    title: 'Loop controls',
    orderNr: 4,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('loop', `${icon} Loop Controls`);
      debugGUI.addBinding(loopState, 'masterPlay', { label: 'Master loop' }).on('change', (e) => {
        if (e.value) {
          requestAnimationFrame(mainLoop);
          requestAnimationFrame(() => stepPhysicsWorld(loopState));
        }
        lsSetItem(LS_KEY, loopState);
        updateOnScreenTools('PLAY');
      });
      appPlayBinding = debugGUI
        .addBinding(loopState, 'appPlay', { label: 'App loop' })
        .on('change', () => {
          lsSetItem(LS_KEY, loopState);
          requestAnimationFrame(() => stepPhysicsWorld(loopState));
          updateOnScreenTools('PLAY');
        });
      debugGUI
        .addBinding(loopState, 'maxFPS', { label: 'Forced max FPS (0 = off)', step: 1, min: 0 })
        .on('change', (e) => {
          const value = e.value;
          if (value > 0) {
            loopState.maxFPSInterval = 1000 / value;
          }
          lsSetItem(LS_KEY, loopState);
        });
      debugGUI
        .addBinding(loopState, 'playSpeedMultiplier', {
          label: 'Play speed multiplier',
          step: 0.01,
          min: 0,
        })
        .on('change', (e) => {
          loopState.playSpeedMultiplier = e.value;
          lsSetItem(LS_KEY, loopState);
        });
      return container;
    },
  });
};

export const refreshAppPlayBinding = () => appPlayBinding?.refresh();

export const getSavedLoopState = (loopState: LoopState): LoopState => lsGetItem(LS_KEY, loopState);
