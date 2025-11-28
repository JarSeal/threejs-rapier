import { Clock, type Renderer, type Scene } from 'three/webgpu';
import { createNewDebuggerPane, createDebuggerTab } from '../debug/DebuggerGUI';
import { getStats, initStats, startCustomMeasurments, updateRestOfStats } from '../debug/Stats';
import { getAllCamerasAsArray, getCurrentCamera } from './Camera';
import { getRenderer } from './Renderer';
import {
  getCurrentSceneId,
  getRootScene,
  getSceneResizers,
  runSceneAppLoopers,
  runSceneMainLateLoopers,
  runSceneMainLoopers,
} from './Scene';
import { lerror, lwarn } from '../utils/Logger';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getWindowSize } from '../utils/Window';
import { getEnv, isDebugEnvironment, isProdTestMode, isProductionEnvironment } from './Config';
import { initDebugTools } from '../debug/DebugTools';
import { getPhysicsState, renderPhysicsObjects, stepPhysicsWorld } from './PhysicsRapier';
import { getSvgIcon } from './UI/icons/SvgIcon';
import { updateHelpers } from './Helpers';
import { InitOnScreenTools, updateOnScreenTools } from '../debug/OnScreenTools';
import { BindingApi } from '@tweakpane/core';
import { updateInputControllerLoopActions } from './InputControls';
import { countRayCastFrames, initRayCasting } from './Raycast';

const LS_KEY = 'debugLoop';
const clock = new Clock();
let delta = 0;
let deltaApp = 0;
let mainLoopInitiated = false;
let lastRenderTime = performance.now();
const resizers: { [key: string]: () => void } = {};

export type LoopState = {
  masterPlay: boolean;
  appPlay: boolean;
  isMasterPlaying: boolean;
  isAppPlaying: boolean;
  playSpeedMultiplier: number;
  maxFPS: number;
  maxFPSInterval: number;
  isWindowHidden: boolean;
  isUnloading: boolean;
};

let loopState: LoopState = {
  masterPlay: true,
  appPlay: true,
  isMasterPlaying: false,
  isAppPlaying: false,
  playSpeedMultiplier: 1,
  maxFPS: 0, // 0 = maxFPS limiter is off and is not used
  maxFPSInterval: 0, // if maxFPS = 60, then this would be 1000 / 60
  isWindowHidden: false,
  isUnloading: false,
};

/**
 * Returns the main loop delta time
 * @returns (number) delta time
 */
export const getDelta = () => delta;

/**
 * Returns the app loop delta time
 * @returns (number) delta time
 */
export const getAppDelta = () => deltaApp;

/**
 * Returns linear speed value in relation to main loop delta time
 * @param unitsPerSecond (number) units per second
 * @returns (number) transformed speed value (delta * unitsPerSecond)
 */
export const transformMainSpeedValue = (unitsPerSecond: number) => delta * unitsPerSecond;

/**
 * Returns linear speed value in relation to app loop delta time
 * @param unitsPerSecond (number) units per second
 * @returns (number) transformed speed value (delta * unitsPerSecond)
 */
export const transformAppSpeedValue = (unitsPerSecond: number) => deltaApp * unitsPerSecond;

/**
 * Transforms time value in relation to the loopState.playSpeedMultiplier
 * @param durationInMs (number) duration in milliseconds to transform
 * @returns (number) transformed duration in milliseconds (durationInMs * loopState.playSpeedMultiplier)
 */
export const transformTimeValue = (durationInMs: number) =>
  durationInMs * loopState.playSpeedMultiplier;

let mainLoop: () => void = () => {};

// LOOP (for debug)
// **************************************
const mainLoopForDebug = async () => {
  startCustomMeasurments();

  const dt = clock.getDelta();

  if (loopState.masterPlay) {
    delta = dt * loopState.playSpeedMultiplier;
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
  }

  // --- Max FPS limiter ---
  let skipFrame = false;
  if (loopState.maxFPS > 0) {
    const nowMs = performance.now();
    if (nowMs - lastRenderTime < loopState.maxFPSInterval) {
      skipFrame = true; // Skip rendering this frame
    } else {
      lastRenderTime = nowMs;
    }
  }

  // Update helpers (only in debug)
  updateHelpers(skipFrame);

  // main loopers
  runSceneMainLoopers(delta, skipFrame);

  const renderer = getRenderer() as Renderer;
  const rootScene = getRootScene() as Scene;
  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    deltaApp = dt * loopState.playSpeedMultiplier;

    // Step the physics
    stepPhysicsWorld(loopState);

    // Render physics objects
    renderPhysicsObjects();

    // app loopers
    runSceneAppLoopers(delta);

    // Update loop action inputs if physics is disabled
    const physicsState = getPhysicsState();
    const sceneId = getCurrentSceneId();
    const physDisabled =
      !sceneId || !physicsState.enabled || !physicsState.scenes[sceneId].worldStepEnabled;
    if (physDisabled) updateInputControllerLoopActions(delta);

    // Count ray cast frames
    countRayCastFrames();
  } else {
    // Only master loop is playing (app loop is paused)
    loopState.isAppPlaying = false;
  }

  if (skipFrame) return;

  // Update stats-gl
  getStats()?.update();

  renderer.render(rootScene, getCurrentCamera());

  runSceneMainLateLoopers(delta);

  updateRestOfStats(renderer);
};

// LOOP (for production)
// **************************************
const mainLoopForProduction = async () => {
  const dt = clock.getDelta();
  if (loopState.masterPlay) {
    delta = dt * loopState.playSpeedMultiplier;
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
  }

  // main loopers
  runSceneMainLoopers(delta, false);

  if (loopState.appPlay) {
    loopState.isAppPlaying = true;

    // Step the physics
    stepPhysicsWorld(loopState);

    // Render physics objects
    renderPhysicsObjects();
    // app loopers
    runSceneAppLoopers(deltaApp);
    // Update loop action inputs if physics is disabled
    const physicsState = getPhysicsState();
    const sceneId = getCurrentSceneId();
    const physDisabled =
      !sceneId || !physicsState.enabled || !physicsState.scenes[sceneId].worldStepEnabled;
    if (physDisabled) updateInputControllerLoopActions(delta);
  }
  (getRenderer() as Renderer).render(getRootScene() as Scene, getCurrentCamera());
  runSceneMainLateLoopers(delta);
};

// LOOP (for production with FPS limiter)
// **************************************
const mainLoopForProductionWithFPSLimiter = async () => {
  const dt = clock.getDelta();

  if (loopState.masterPlay) {
    delta = dt * loopState.playSpeedMultiplier;
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
  }

  // --- Max FPS limiter ---
  let skipFrame = false;
  if (loopState.maxFPS > 0) {
    const nowMs = performance.now();
    if (nowMs - lastRenderTime < loopState.maxFPSInterval) {
      skipFrame = true; // Skip rendering this frame
    } else {
      lastRenderTime = nowMs;
    }
  }

  // main loopers
  runSceneMainLoopers(delta, skipFrame);

  const renderer = getRenderer() as Renderer;
  const rootScene = getRootScene() as Scene;

  if (loopState.appPlay) {
    loopState.isAppPlaying = true;

    // Step the physics
    stepPhysicsWorld(loopState);

    if (skipFrame) return;

    // Render physics objects
    renderPhysicsObjects();
    // app loopers
    runSceneAppLoopers(delta);
    // Update loop action inputs if physics is disabled
    const physicsState = getPhysicsState();
    const sceneId = getCurrentSceneId();
    const physDisabled =
      !sceneId || !physicsState.enabled || !physicsState.scenes[sceneId].worldStepEnabled;
    if (physDisabled) updateInputControllerLoopActions(delta);
  } else {
    if (skipFrame) return;
  }
  renderer.render(rootScene, getCurrentCamera());
  runSceneMainLateLoopers(delta);
};

/**
 * Initializes the main loop. Requires that the renderer, camera, and scene have been created.
 */
export const initMainLoop = async () => {
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
    const renderer = getRenderer();
    if (!renderer) throw new Error('Could not find current renderer in canvas resizer.');
    const windowSize = getWindowSize();
    const cameras = getAllCamerasAsArray();
    for (let i = 0; i < cameras.length; i++) {
      cameras[i].aspect = windowSize.aspect;
      cameras[i].updateProjectionMatrix();
    }
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

  if (isDebugEnvironment() || isProdTestMode()) {
    const savedValues = lsGetItem(LS_KEY, loopState);
    loopState = {
      ...loopState,
      ...savedValues,
    };
    createLoopDebugControls();
  }

  initRayCasting();

  if (isDebugEnvironment()) {
    initStats();
    initDebugTools();

    mainLoop = mainLoopForDebug;
  } else if (isProductionEnvironment() && loopState.maxFPS > 0) {
    mainLoop = mainLoopForProductionWithFPSLimiter;
  } else {
    mainLoop = mainLoopForProduction;
  }

  await renderer.renderAsync(getRootScene() as Scene, currentCamera);
  if (loopState.masterPlay) {
    // Wait for a few loops and start the main loop and physics loop
    setTimeout(() => requestAnimationFrame(mainLoop), 100);
    setTimeout(() => requestAnimationFrame(() => stepPhysicsWorld(loopState)), 100);
  }
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
let appPlayBinding: BindingApi | null = null;
const createLoopDebugControls = () => {
  // Init On Screen Tools
  InitOnScreenTools();
  initWinVisibilityListener();

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

const visibilityChangeFns: { [id: string]: (isHidden: boolean) => void } = {};
export const addVisibilityChangeFn = (id: string, fn: (isHidden: boolean) => void) =>
  (visibilityChangeFns[id] = fn);

export const deleteVisibilityChangeFn = (id: string) => delete visibilityChangeFns[id];

window.addEventListener('beforeunload', () => (loopState.isUnloading = true));
const initWinVisibilityListener = () => {
  document.addEventListener('visibilitychange', () => {
    if (loopState.isUnloading) return;
    const isHidden = document.hidden;
    loopState.isWindowHidden = isHidden;
    const keys = Object.keys(visibilityChangeFns);
    for (let i = 0; i < keys.length; i++) {
      visibilityChangeFns[keys[i]](isHidden);
    }
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
  if (loopState.masterPlay && !loopState.isMasterPlaying) {
    loopState.isMasterPlaying = true;
    requestAnimationFrame(mainLoop);
  }
};

/**
 * Toggles the app loop player state (play / pause)
 * @param value (boolean) optional value whether the loop state in playing (true) or paused (false). If not provided then value is the opposite to the current value.
 */
export const toggleAppPlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.appPlay = value;
    appPlayBinding?.refresh();
    return;
  }
  loopState.appPlay = !loopState.appPlay;
  appPlayBinding?.refresh();
};

/**
 * Returns the read-only loop state object
 * @returns ({@link LoopState}) copy of LoopState
 */
export const getReadOnlyLoopState = () => JSON.parse(JSON.stringify(loopState)) as LoopState;

/**
 * Returns the play speed multiplier
 * @returns (number) loopState.playSpeedMultiplier
 */
export const getPlaySpeedMultiplier = () => loopState.playSpeedMultiplier;

export const setPlaySpeedMultiplier = (multiplier: number) =>
  (loopState.playSpeedMultiplier = multiplier < 0 ? 0 : multiplier);
