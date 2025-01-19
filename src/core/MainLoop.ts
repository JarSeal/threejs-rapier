import { Clock } from 'three/webgpu';
import {
  createDebugGui,
  createNewDebuggerGUI,
  setDebuggerTabAndContainer,
} from '../debug/DebuggerGUI';
import { getStats, initStats } from '../debug/Stats';
import { getCurrentCamera } from './Camera';
import { getRenderer } from './Renderer';
import {
  getCurrentScene,
  getSceneAppLoopers,
  getSceneMainLoopers,
  getSceneResizers,
} from './Scene';
import { lerror, lwarn } from '../utils/Logger';
import { createHudContainer } from './HUD';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getWindowSize } from '../utils/Window';
import { getEnv, isCurrentEnvironment, isDebugEnvironment } from './Config';
import { initDebugTools } from '../debug/DebugTools';

const LS_KEY = 'debugLoop';
const clock = new Clock();
let delta = 0;
let accDelta = clock.getDelta();
const resizers: { [key: string]: () => void } = {};

type LoopState = {
  masterPlay: boolean;
  appPlay: boolean;
  isMasterPlaying: boolean;
  isAppPlaying: boolean;
  maxFPS: number;
  maxFPSInterval: number;
};

let loopState: LoopState = {
  masterPlay: true,
  appPlay: true,
  isMasterPlaying: false,
  isAppPlaying: false,
  maxFPS: 0, // 0 = maxFPS limiter is off and is not used
  maxFPSInterval: 0, // if maxFPS = 60, then this would be 1 / 60
};

export const getDelta = () => delta;
export const getTransformValue = (speedInUnitsPerSecond: number) => delta * speedInUnitsPerSecond;

let mainLoop: () => void = () => {};

const mainLoopForDebug = () => {
  delta = clock.getDelta();
  if (loopState.masterPlay) {
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
    return;
  }
  // main loopers
  const mainLoopers = getSceneMainLoopers();
  if (mainLoopers) {
    for (let i = 0; i < mainLoopers.length; i++) {
      mainLoopers[i](delta);
    }
  }
  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    // app loopers
    const appLoopers = getSceneAppLoopers();
    if (appLoopers) {
      for (let i = 0; i < appLoopers.length; i++) {
        appLoopers[i](delta);
      }
    }
  } else {
    loopState.isAppPlaying = false;
  }
  if (loopState.maxFPS > 0) {
    accDelta += delta;
    if (accDelta > loopState.maxFPSInterval) {
      getRenderer()?.renderAsync(getCurrentScene(), getCurrentCamera());
      getStats()?.update();
      accDelta = accDelta % loopState.maxFPSInterval;
    }
  } else {
    // No maxFPS limiter
    getRenderer()?.renderAsync(getCurrentScene(), getCurrentCamera());
    getStats()?.update();
  }
};

const mainLoopForProduction = () => {
  requestAnimationFrame(mainLoop);
  delta = clock.getDelta();
  // @TODO: add app play loop here
  getRenderer()?.renderAsync(getCurrentScene(), getCurrentCamera());
};

const mainLoopForProductionWithFPSLimiter = () => {
  requestAnimationFrame(mainLoop);
  delta = clock.getDelta();
  accDelta += delta;
  // @TODO: add app play loop here
  if (accDelta > loopState.maxFPSInterval) {
    getRenderer()?.renderAsync(getCurrentScene(), getCurrentCamera());
    getStats()?.update();
    accDelta = accDelta % loopState.maxFPSInterval;
  }
};

// Init mainLoop
export const initMainLoop = () => {
  const renderer = getRenderer();
  const currentScene = getCurrentScene();
  const currentCamera = getCurrentCamera();
  if (!renderer) {
    const msg = 'Renderer has not been created or has been deleted (initMainLoop).';
    lerror(msg);
    throw new Error(msg);
  }
  if (!currentScene) {
    const msg = 'Current scene has not been created or has been deleted (initMainLoop).';
    lerror(msg);
    throw new Error(msg);
  }
  if (!currentCamera) {
    const msg = 'Current camera has not been created or has been deleted (initMainLoop).';
    lerror(msg);
    throw new Error(msg);
  }

  if (isDebugEnvironment()) {
    mainLoop = mainLoopForDebug;
  } else if (isCurrentEnvironment('production') && loopState.maxFPS > 0) {
    mainLoop = mainLoopForProductionWithFPSLimiter;
  } else {
    mainLoop = mainLoopForProduction;
  }

  // HUD container
  createHudContainer();

  const maxFPS = Number(getEnv('VITE_MAX_FPS'));
  if (maxFPS !== undefined && !isNaN(maxFPS)) {
    loopState.maxFPS = maxFPS;
    if (maxFPS > 0) loopState.maxFPSInterval = 1 / maxFPS;
  }

  if (isDebugEnvironment()) {
    // Debug GUI and Stats (if debug environment)
    createDebugGui();
    const savedValues = lsGetItem(LS_KEY, loopState);
    loopState = {
      ...loopState,
      ...savedValues,
      ...(maxFPS !== undefined && !isNaN(maxFPS)
        ? { maxFPS: loopState.maxFPS, maxFPSInterval: loopState.maxFPSInterval }
        : {}),
    };
    createLoopDebugGUI();
    initStats();
    initDebugTools();
  }

  renderer.renderAsync(currentScene, currentCamera);
  if (loopState.masterPlay) requestAnimationFrame(mainLoop);
};

// Resizers
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

export const addResizer = (id: string, resizer: () => void) => {
  if (resizers[id]) {
    throw new Error(
      `A resizer with the id "${id}" already exists. Delete the old resizer first before adding one with this id or pick another id.`
    );
  }
  resizers[id] = resizer;
};

export const deleteResizer = (id: string) => {
  if (!resizers[id]) {
    lwarn(`Could not find resizer with id "${id}" in deleteResizer.`);
    return;
  }
  delete resizers[id];
};

// Debug GUI for loop
const createLoopDebugGUI = () => {
  setDebuggerTabAndContainer({
    id: 'loopControls',
    buttonText: 'LOOP',
    title: 'Loop controls',
    orderNr: 4,
    container: () => {
      const { container, debugGUI } = createNewDebuggerGUI('loop', 'Loop Controls');
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
      return container;
    },
  });
};

export const toggleMainPlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.masterPlay = value;
  } else {
    loopState.masterPlay = !loopState.masterPlay;
  }
  if (loopState.masterPlay && !loopState.isMasterPlaying) mainLoop();
};

export const toggleGamePlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.appPlay = value;
    return;
  }
  loopState.appPlay = !loopState.appPlay;
};
