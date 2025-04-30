import { Clock, type Scene } from 'three/webgpu';
import { createDebugGui, createNewDebuggerPane, createDebuggerTab } from '../debug/DebuggerGUI';
import { getStats, initStats } from '../debug/Stats';
import { getCurrentCamera } from './Camera';
import { getRenderer } from './Renderer';
import {
  getRootScene,
  getSceneAppLoopers,
  getSceneMainLateLoopers,
  getSceneMainLoopers,
  getSceneResizers,
} from './Scene';
import { lerror, lwarn } from '../utils/Logger';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getWindowSize } from '../utils/Window';
import { getEnv, isCurrentEnvironment, isDebugEnvironment } from './Config';
import { initDebugTools } from '../debug/DebugTools';
import { stepPhysicsWorld } from './PhysicsRapier';

const LS_KEY = 'debugLoop';
const clock = new Clock();
let delta = 0;
let accDelta = clock.getDelta();
let mainLoopInitiated = false;
const resizers: { [key: string]: () => void } = {};

type LoopState = {
  masterPlay: boolean;
  appPlay: boolean;
  isMasterPlaying: boolean;
  isAppPlaying: boolean;
  playSpeedMultiplier: number;
  maxFPS: number;
  maxFPSInterval: number;
};

let loopState: LoopState = {
  masterPlay: true,
  appPlay: true,
  isMasterPlaying: false,
  isAppPlaying: false,
  playSpeedMultiplier: 1,
  maxFPS: 0, // 0 = maxFPS limiter is off and is not used
  maxFPSInterval: 0, // if maxFPS = 60, then this would be 1 / 60
};

/**
 * Returns the loop delta time
 * @returns (number) delta time
 */
export const getDelta = () => delta;

/**
 * Returns linear speed value in relation to delta time
 * @param unitsPerSecond (number) units per second
 * @returns (number) transformed speed value (delta * unitsPerSecond)
 */
export const transformSpeedValue = (unitsPerSecond: number) => delta * unitsPerSecond;

/**
 * Transforms time value in relation to the loopState.playSpeedMultiplier
 * @param durationInMs (number) duration in milliseconds to transform
 * @returns (number) transformed duration in milliseconds (durationInMs * loopState.playSpeedMultiplier)
 */
export const transformTimeValue = (durationInMs: number) =>
  durationInMs * loopState.playSpeedMultiplier;

let mainLoop: () => void = () => {};

const runMainLateLoopers = () => {
  // main late loopers
  const mainLateLoopers = getSceneMainLateLoopers();
  for (let i = 0; i < mainLateLoopers.length; i++) {
    mainLateLoopers[i](delta);
  }
};

// LOOP (for debug)
// **************************************
const mainLoopForDebug = async () => {
  const dt = clock.getDelta();
  delta = dt * loopState.playSpeedMultiplier;
  if (loopState.masterPlay) {
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
    return;
  }
  // main loopers
  const mainLoopers = getSceneMainLoopers();
  for (let i = 0; i < mainLoopers.length; i++) {
    mainLoopers[i](delta);
  }
  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    // app loopers
    const appLoopers = getSceneAppLoopers();
    for (let i = 0; i < appLoopers.length; i++) {
      appLoopers[i](delta);
    }

    stepPhysicsWorld(delta);

    const renderer = getRenderer();
    const windowSize = getWindowSize();
    const rootScene = getRootScene() as Scene;
    renderer?.setViewport(0, 0, windowSize.width, windowSize.height);
    if (loopState.maxFPS > 0) {
      // maxFPS limiter
      accDelta += delta;
      if (accDelta > loopState.maxFPSInterval) {
        await renderer?.renderAsync(rootScene, getCurrentCamera()).then(() => {
          runMainLateLoopers();
          getStats()?.update();
          accDelta = accDelta % loopState.maxFPSInterval;
        });
      }
    } else {
      // No maxFPS limiter
      await renderer?.renderAsync(rootScene, getCurrentCamera()).then(() => {
        runMainLateLoopers();
        getStats()?.update();
      });
    }
  } else {
    loopState.isAppPlaying = false;
    runMainLateLoopers();
    getStats()?.update();
  }
};

// LOOP (for production)
// **************************************
const mainLoopForProduction = async () => {
  const dt = clock.getDelta();
  delta = dt * loopState.playSpeedMultiplier;
  if (loopState.masterPlay) {
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
    return;
  }
  // main loopers
  const mainLoopers = getSceneMainLoopers();
  for (let i = 0; i < mainLoopers.length; i++) {
    mainLoopers[i](delta);
  }
  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    // app loopers
    const appLoopers = getSceneAppLoopers();
    for (let i = 0; i < appLoopers.length; i++) {
      appLoopers[i](delta);
    }

    stepPhysicsWorld(delta);

    const renderer = getRenderer();
    const windowSize = getWindowSize();
    const rootScene = getRootScene() as Scene;
    renderer?.setViewport(0, 0, windowSize.width, windowSize.height);
    // No maxFPS limiter
    await renderer?.renderAsync(rootScene, getCurrentCamera()).then(() => {
      runMainLateLoopers();
    });
  } else {
    loopState.isAppPlaying = false;
    runMainLateLoopers();
  }
};

// LOOP (for production with FPS limiter)
// **************************************
const mainLoopForProductionWithFPSLimiter = async () => {
  requestAnimationFrame(mainLoop);
  delta = clock.getDelta() * loopState.playSpeedMultiplier;
  accDelta += delta;
  // @TODO: add app play loop here
  if (accDelta > loopState.maxFPSInterval) {
    await getRenderer()?.renderAsync(getRootScene() as Scene, getCurrentCamera());
    getStats()?.update();
    accDelta = accDelta % loopState.maxFPSInterval;
  }
};

/**
 * Initializes the main loop. Requires that the renderer, camera, and scene have been created.
 */
export const initMainLoop = () => {
  // Make sure initMainLoop is only initiated once
  if (mainLoopInitiated) return;
  mainLoopInitiated = true;

  const renderer = getRenderer();
  const currentCamera = getCurrentCamera();
  if (!renderer) {
    const msg = 'Renderer has not been created or has been deleted (initMainLoop).';
    lerror(msg);
    throw new Error(msg);
  }
  if (!currentCamera) {
    const msg = 'Current camera has not been created or has been deleted (initMainLoop).';
    lerror(msg);
    throw new Error(msg);
  }

  // Add three.js global resizer
  resizers['canvasResizer'] = () => {
    const camera = getCurrentCamera();
    const renderer = getRenderer();
    if (!camera) throw new Error('Could not find current camera in canvas resizer.');
    if (!renderer) throw new Error('Could not find current renderer in canvas resizer.');
    const windowSize = getWindowSize();
    camera.aspect = windowSize.aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(windowSize.width, windowSize.height);
  };
  window.addEventListener(
    'resize',
    () => {
      // Global resizers
      const ids = Object.keys(resizers);
      for (let i = 0; i < ids.length; i++) {
        resizers[ids[i]]();
      }

      // Scene resizers
      const sceneResizers = getSceneResizers();
      if (sceneResizers) {
        for (let i = 0; i < sceneResizers.length; i++) {
          sceneResizers[i]();
        }
      }
    },
    false
  );

  const maxFPS = Number(getEnv('VITE_MAX_FPS'));
  if (maxFPS !== undefined && !isNaN(maxFPS)) {
    loopState.maxFPS = maxFPS;
    if (maxFPS > 0) loopState.maxFPSInterval = 1 / maxFPS;
  }

  if (isDebugEnvironment()) {
    // Debug GUI and Stats (if debug environment)
    const savedValues = lsGetItem(LS_KEY, loopState);
    loopState = {
      ...loopState,
      ...savedValues,
    };
    createLoopDebugControls();
    initStats();
    initDebugTools();
  }

  if (isDebugEnvironment()) {
    mainLoop = mainLoopForDebug;
  } else if (isCurrentEnvironment('production') && loopState.maxFPS > 0) {
    mainLoop = mainLoopForProductionWithFPSLimiter;
  } else {
    mainLoop = mainLoopForProduction;
  }

  renderer.renderAsync(getRootScene() as Scene, currentCamera);
  if (loopState.masterPlay) requestAnimationFrame(mainLoop);
};

/**
 * Adds a global resizer function.
 * @param id (string) resizer id
 * @param resizer (() => void) resizer function
 */
export const addResizer = (id: string, resizer: () => void) => {
  if (resizers[id]) {
    throw new Error(
      `A resizer with the id "${id}" already exists. Delete the old resizer first before adding one with this id or pick another id.`
    );
  }
  resizers[id] = resizer;
};

/**
 * Deletes a resizer with an id
 * @param id (string) resizer id
 */
export const deleteResizer = (id: string) => {
  if (!resizers[id]) {
    lwarn(`Could not find resizer with id "${id}" in deleteResizer.`);
    return;
  }
  delete resizers[id];
};

// Debug GUI for loop
const createLoopDebugControls = () => {
  createDebugGui();
  createDebuggerTab({
    id: 'loopControls',
    buttonText: 'LOOP',
    title: 'Loop controls',
    orderNr: 4,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('loop', 'Loop Controls');
      debugGUI.addBinding(loopState, 'masterPlay', { label: 'Master loop' }).on('change', (e) => {
        if (e.value) requestAnimationFrame(mainLoop);
        lsSetItem(LS_KEY, loopState);
      });
      debugGUI
        .addBinding(loopState, 'appPlay', { label: 'App loop' })
        .on('change', () => lsSetItem(LS_KEY, loopState));
      debugGUI
        .addBinding(loopState, 'maxFPS', { label: 'Forced max FPS (0 = off)', step: 1, min: 0 })
        .on('change', (e) => {
          const value = e.value;
          if (value > 0) {
            loopState.maxFPSInterval = 1 / value;
            lsSetItem(LS_KEY, loopState);
            return;
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

/**
 * Toggles the main loop player state (play / pause)
 * @param value (boolean) optional value whether the loop state in playing (true) or paused (false). If not provided then value is the opposite to the current value.
 */
export const toggleMainPlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.masterPlay = value;
  } else {
    loopState.masterPlay = !loopState.masterPlay;
  }
  if (loopState.masterPlay && !loopState.isMasterPlaying) mainLoop();
};

/**
 * Toggles the app loop player state (play / pause)
 * @param value (boolean) optional value whether the loop state in playing (true) or paused (false). If not provided then value is the opposite to the current value.
 */
export const toggleGamePlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.appPlay = value;
    return;
  }
  loopState.appPlay = !loopState.appPlay;
};

/**
 * Returns the read-only loop state object
 * @returns ({@link LoopState}) copy of LoopState
 */
export const getReadOnlyLoopState = () => JSON.parse(JSON.stringify(loopState));

/**
 * Returns the play speed multiplier
 * @returns (number) loopState.playSpeedMultiplier
 */
export const getPlaySpeedMultiplier = () => loopState.playSpeedMultiplier;

export const setPlaySpeedMultiplier = (multiplier: number) =>
  (loopState.playSpeedMultiplier = multiplier < 0 ? 0 : multiplier);
