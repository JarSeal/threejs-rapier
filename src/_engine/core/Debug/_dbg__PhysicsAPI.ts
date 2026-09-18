import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import { type ListBladeApi } from 'tweakpane';
import type { BladeController, View } from '@tweakpane/core';
import {
  getPhysicsState,
  getPhysicsWorld,
  getResolvedTransportMode,
  isPhysicsWorldEnabled,
} from '../PhysicsAPI';
import { DEBUG_PHYSICS_API_BOOT_LS_KEY } from '../Config';
import type { PhysicsState, PhysicsWorkerTarget } from '../Physics/PhysicsAPITypes';

const LS_KEY = 'debugPhysicsApi';

type DebugPhysicsApiBoot = {
  workerTarget?: PhysicsWorkerTarget;
  useSAB?: boolean;
  maxBodies?: number;
};

const setBootOverride = (partial: DebugPhysicsApiBoot) => {
  const current = lsGetItem(DEBUG_PHYSICS_API_BOOT_LS_KEY, {}) as DebugPhysicsApiBoot;
  lsSetItem(DEBUG_PHYSICS_API_BOOT_LS_KEY, { ...current, ...partial });
  location.reload();
};

export const _createPhysicsAPIDebugGUI = () => {
  const state = getPhysicsState();
  const savedValues = lsGetItem(LS_KEY, state) as Partial<PhysicsState>;
  Object.assign(state, savedValues);

  const icon = getSvgIcon('rocketTakeoff');
  createDebuggerTab({
    id: 'physicsApiControls',
    buttonText: icon,
    title: 'Physics API controls',
    orderNr: 6,
    container: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => lsKeyHasData(LS_KEY),
        onClear: () => lsRemoveItem(LS_KEY),
        watchKey: LS_KEY,
      });
      const { container, debugGUI } = createNewDebuggerPane(
        'physicsApi',
        `${icon} Physics API Controls`,
        [clearTabBtn]
      );

      // --- Boot-time settings (require a reload to take effect) ---

      const workerTargetDropDown = debugGUI.addBlade({
        view: 'list',
        label: 'Worker target (reloads)',
        options: [
          { value: 'MAIN_THREAD', text: 'Main thread' },
          { value: 'WORKER_THREAD', text: 'Worker thread' },
        ],
        value: state.workerTarget,
      }) as ListBladeApi<BladeController<View>>;
      workerTargetDropDown.on('change', (e) => {
        setBootOverride({ workerTarget: e.value as unknown as PhysicsWorkerTarget });
      });
      debugGUI
        .addBinding(state, 'useSAB', { label: 'Use SharedArrayBuffer (reloads)' })
        .on('change', (e) => {
          setBootOverride({ useSAB: e.value });
        });
      debugGUI
        .addBinding(state, 'maxBodies', { label: 'Max bodies (reloads)', step: 1, min: 1 })
        .on('change', (e) => {
          setBootOverride({ maxBodies: e.value });
        });

      const transportModeReadout = {
        transportMode: getResolvedTransportMode() ?? 'Not created yet',
      };
      const transportModeBinding = debugGUI.addBinding(transportModeReadout, 'transportMode', {
        label: 'Resolved transport mode',
        readonly: true,
      });
      // No create/delete-world hook to subscribe to — poll, same tradeoff as
      // the spatial grid debug panel's live readout (never cleared, same precedent).
      setInterval(() => {
        transportModeReadout.transportMode = getResolvedTransportMode() ?? 'Not created yet';
        transportModeBinding.refresh();
      }, 500);

      debugGUI.addBlade({ view: 'separator' });

      // --- Live settings ---

      debugGUI
        .addBinding(state, 'timestep', { label: 'Global timestep (1 / ts)', step: 1, min: 1 })
        .on('change', (e) => {
          state.timestepRatio = 1 / e.value;
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'worldStepEnabled', { label: 'Enable world step' })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'visualizerEnabled', {
          label: 'Enable visualizer (not yet wired to a 3D visualizer)',
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI.addBinding(state, 'gravity', { label: 'Gravity' }).on('change', (e) => {
        state.gravity = { ...e.value };
        lsSetItem(LS_KEY, state);
        if (isPhysicsWorldEnabled()) {
          getPhysicsWorld().setGravity(state.gravity);
        }
      });
      debugGUI
        .addBinding(state, 'solverIterations', {
          label: 'Solver iterations',
          min: 1,
          step: 1,
        })
        .on('change', (e) => {
          state.solverIterations = e.value;
          lsSetItem(LS_KEY, state);
          if (isPhysicsWorldEnabled()) {
            getPhysicsWorld().setNumSolverIterations(e.value);
          }
        });
      debugGUI
        .addBinding(state, 'internalPgsIterations', {
          label: 'Internal PGS iterations (run at each solver iteration)',
          min: 1,
          step: 1,
        })
        .on('change', (e) => {
          state.internalPgsIterations = e.value;
          lsSetItem(LS_KEY, state);
          if (isPhysicsWorldEnabled()) {
            getPhysicsWorld().setNumInternalPgsIterations(e.value);
          }
        });
      debugGUI
        .addBinding(state, 'interpolationEnabled', { label: 'Enable interpolation' })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      const bgBehaviorDropDown = debugGUI.addBlade({
        view: 'list',
        label:
          'Background behavior (when the loop is not running or the window is hidden, not in view, another tab, or minimized)',
        options: [
          { value: 'KEEP_RUNNING', text: 'Keep running' },
          { value: 'KEEP_RUNNING_USE_MIN_DELTA', text: 'Keep running and use Minimum delta time' },
          { value: 'PAUSE', text: 'Pause' },
        ],
        value: state.backgroundBehavior,
      }) as ListBladeApi<BladeController<View>>;
      bgBehaviorDropDown.on('change', (e) => {
        state.backgroundBehavior = e.value as unknown as PhysicsState['backgroundBehavior'];
        lsSetItem(LS_KEY, state);
      });
      debugGUI
        .addBinding(state, 'minDeltaTime', {
          label: 'Minimum delta time (eg. 1 / 30fps), 0 = not in use',
          step: 0.0000000001,
          min: 0,
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'maxDeltaTime', {
          label: 'Maximum delta time (clamping to an fps, 1 / 10fps = 0.1), 0 = not in use',
          step: 0.0000000001,
          min: 0,
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'minSubSteps', {
          label: 'Minimum steps per render frame, 0 = not in use',
          step: 1,
          min: 0,
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });
      debugGUI
        .addBinding(state, 'maxSubSteps', {
          label:
            'Maximum steps per render frame (Prevents the spiral of death, should usually be the same as timestep), 0 = not in use',
          step: 1,
          min: 0,
        })
        .on('change', () => {
          lsSetItem(LS_KEY, state);
        });

      return container;
    },
  });
};
