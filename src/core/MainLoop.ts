import { Clock } from 'three';
import {
  createDebugGui,
  createNewDebuggerGUI,
  setDebuggerTabAndContainer,
} from '../debug/DebuggerGUI';
import { getStats, initStats } from '../debug/Stats';
import { getCurrentCamera } from './Camera';
import { getMesh } from './Mesh';
import { getRenderer } from './Renderer';
import { getCurrentScene } from './Scene';
import { lerror, lwarn } from '../utils/Logger';
import { createHudContainer } from './HUD';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getWindowSize } from '../utils/Window';

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
  if (loopState.masterPlay) {
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
    return;
  }
  delta = clock.getDelta();
  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    // @TODO: add app play loop here
    const sphere = getMesh('sphereMesh1'); // REMOVE
    if (sphere) {
      sphere.rotation.z -= getTransformValue(0.1); // REMOVE
      sphere.rotation.y += getTransformValue(0.1); // REMOVE
    }
    const box = getMesh('boxMesh1'); // REMOVE
    if (box) {
      box.rotation.y -= getTransformValue(0.1); // REMOVE
      box.rotation.z -= getTransformValue(0.1); //REMOVE
    }
    const importedBox = getMesh('importedMesh1'); // REMOVE
    if (importedBox) {
      importedBox.rotation.y += getTransformValue(0.2); // REMOVE
      importedBox.rotation.z -= getTransformValue(0.14); // REMOVE
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

// const mainLoopForProduction = () => {
//   requestAnimationFrame(mainLoop);
//   delta = clock.getDelta();
//   // @TODO: add app play loop here
//   getRenderer()?.renderAsync(getCurrentScene(), getCurrentCamera());
// };

// const mainLoopForProductionWithFPSLimiter = () => {
//   requestAnimationFrame(mainLoop);
//   delta = clock.getDelta();
//   accDelta += delta;
//   // @TODO: add app play loop here
//   if (accDelta > loopState.maxFPSInterval) {
//     getRenderer()?.renderAsync(getCurrentScene(), getCurrentCamera());
//     getStats()?.update();
//     accDelta = accDelta % loopState.maxFPSInterval;
//   }
// };

// @TODO: add env check and use either debug or production loop (and whether to use FPS limiter or not)
mainLoop = mainLoopForDebug;

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

  // HUD container
  createHudContainer();

  // Debug GUI and Stats
  // @TODO: skip these if ENV is production
  const savedValues = lsGetItem(LS_KEY, loopState);
  loopState = { ...loopState, ...savedValues };
  createDebugGui();
  initStats();

  renderer.renderAsync(currentScene, currentCamera);
  // @TODO: skip masterPlay check if ENV is production
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
    const ids = Object.keys(resizers);
    for (let i = 0; i < ids.length; i++) {
      resizers[ids[i]]();
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
setDebuggerTabAndContainer({
  id: 'loopControls',
  buttonText: 'LOOP',
  title: 'Loop controls',
  orderNr: 4,
  container: () => {
    const { container, debugGui } = createNewDebuggerGUI('Loop', 'Loop Controls');
    debugGui
      .add(loopState, 'masterPlay')
      .name('Master loop')
      .onChange((value: boolean) => {
        if (value) requestAnimationFrame(mainLoop);
        lsSetItem(LS_KEY, loopState);
      });
    debugGui
      .add(loopState, 'appPlay')
      .name('App loop')
      .onChange(() => lsSetItem(LS_KEY, loopState));
    debugGui
      .add(loopState, 'maxFPS')
      .name('Forced max FPS (0 = off)')
      .onChange((value: number) => {
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
