import { Timer, type Renderer, type Scene, type Camera } from 'three/webgpu';
import { getStats, initStats, startCustomMeasurements, updateRestOfStats } from '../debug/Stats';
import { getCurrentCamera } from './CameraManager';
import { getRenderer } from './Renderer';
import {
  getRootScene,
  getSceneResizers,
  runSceneAppLoopers,
  runSceneMainLateLoopers,
  runSceneMainLoopers,
} from './Scene';
import { lerror, lwarn } from '../utils/Logger';
import { getWindowSize } from '../utils/Window';
import { getEnv, isDebugEnvironment, isProdTestMode, isProductionEnvironment } from './Config';
import { initDebugTools } from '../debug/DebugToolsManager';
import { flushPhysicsEvents, getPhysicsState, stepPhysics } from './PhysicsAPI';
import { pollHeldKeyBindings } from './Input/KeyboardInput';
import { countRayCastFrames, initRayCasting } from './Raycast';
import { getAllECSWorlds } from './ECS';
import { getActiveCamera } from './CameraManager';
import { existsOrThrow } from '../utils/assert';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

const timer = new Timer();
let delta = 0;
let deltaApp = 0;
let elapsed = 0;
let discardNextElapsedDelta = true; // the first frame's delta is time since module load
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
  isLoadingScene: boolean;
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
  isLoadingScene: false,
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
 * Returns the main loop's accumulated elapsed time in seconds: the sum of every main loop
 * delta, so it scales with loopState.playSpeedMultiplier and stands still while the master
 * loop is paused (it keeps running while only the app loop is paused). Unlike TSL's `time`
 * node (renderer wall-clock), this is the clock anything that must freeze and speed up with
 * the loop should read.
 * @returns (number) elapsed time in seconds
 */
export const getElapsedTime = () => elapsed;

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

export let mainLoop: () => void = () => {};

/** Everything that has to run in lockstep with the simulation, once per fixed physics
 * sub-step right before it (see stepPhysics): held-key input, then the previous step's
 * collision events, then every world's APP_PHYSICS_STEP systems — the same order legacy
 * PhysicsRapier.ts's baseStepper polled held keys, drained its event queue and ran its scene
 * physics loopers in (see flushPhysicsEvents for why the order matters). */
const runPhysicsSubStep = (stepDelta: number) => {
  pollHeldKeyBindings(stepDelta);
  flushPhysicsEvents();
  for (const world of getAllECSWorlds()) world.updatePhysicsStep(stepDelta);
};

/** Steps the new Physics API (running runPhysicsSubStep before each sub-step). Falls back to
 * polling held keys once with the raw frame delta whenever physics itself isn't running at
 * all, so held-key-driven input (e.g. debug camera movement) still works with physics off. */
const stepPhysicsAndPollHeldKeys = (delta: number) => {
  stepPhysics(loopState, runPhysicsSubStep);
  const physicsState = getPhysicsState();
  if (!physicsState.enabled || !physicsState.worldStepEnabled) pollHeldKeyBindings(delta);
};

/** Advances getElapsedTime by this frame's delta. Must run in every loop variant right after
 * the masterPlay check. The timer is never reset across a master pause, so the first delta
 * after resuming spans the whole paused duration — it is discarded (as stepPhysics does for
 * physics), otherwise the elapsed time would jump forward instead of having stood still.
 * Starts out true, which also covers a loop that starts paused (saved loop state) and so
 * never reaches the paused branch before its first resume.
 * Detected here rather than in toggleMainPlay because the debug GUI's master loop toggle
 * flips loopState.masterPlay directly. */
const advanceElapsedTime = () => {
  if (!loopState.masterPlay) {
    discardNextElapsedDelta = true;
    return;
  }
  if (discardNextElapsedDelta) {
    discardNextElapsedDelta = false;
    return;
  }
  elapsed += delta;
};

const renderScene = () => {
  const renderer = getRenderer() as Renderer;
  const rootScene = getRootScene() as Scene;
  const camera = getActiveCamera() as Camera;

  existsOrThrow(
    renderer && rootScene && camera,
    `Error in renderScene, missing renderer, rootScene, and/or camera. Status:\nrenderer: ${Boolean(renderer)}\nrootScene: ${Boolean(rootScene)}\ncamera: ${Boolean(camera)}`
  );

  renderer.render(rootScene, camera);
};

// LOOP (for debug)
// **************************************
const mainLoopForDebug = async () => {
  startCustomMeasurements();

  timer.update();
  const dt = timer.getDelta();

  if (loopState.masterPlay) {
    delta = dt * loopState.playSpeedMultiplier;
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
  }
  advanceElapsedTime();

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
  for (const world of getAllECSWorlds()) world.updateMainLoop(delta);
  runSceneMainLoopers(delta, skipFrame);

  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    deltaApp = dt * loopState.playSpeedMultiplier;

    // Step the physics and poll held-key input at the same cadence
    stepPhysicsAndPollHeldKeys(delta);

    // app loopers
    for (const world of getAllECSWorlds()) world.updateAppLoop(deltaApp);
    runSceneAppLoopers(deltaApp);

    // Count ray cast frames
    countRayCastFrames();
  } else {
    // Only master loop is playing (app loop is paused)
    loopState.isAppPlaying = false;
  }

  if (skipFrame) return;

  // Update stats-gl
  getStats()?.update();

  renderScene();

  for (const world of getAllECSWorlds()) world.updateLateMainLoop(delta);
  runSceneMainLateLoopers(delta);

  updateRestOfStats(getRenderer() as Renderer);
};

// LOOP (for production)
// **************************************
const mainLoopForProduction = async () => {
  timer.update();
  const dt = timer.getDelta();
  if (loopState.masterPlay) {
    delta = dt * loopState.playSpeedMultiplier;
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
  }
  advanceElapsedTime();

  // main loopers
  for (const world of getAllECSWorlds()) world.updateMainLoop(delta);
  runSceneMainLoopers(delta, false);

  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    deltaApp = dt * loopState.playSpeedMultiplier;

    // Step the physics and poll held-key input at the same cadence
    stepPhysicsAndPollHeldKeys(delta);

    // app loopers
    for (const world of getAllECSWorlds()) world.updateAppLoop(deltaApp);
    runSceneAppLoopers(deltaApp);
  }

  renderScene();

  for (const world of getAllECSWorlds()) world.updateLateMainLoop(delta);
  runSceneMainLateLoopers(delta);
};

// LOOP (for production with FPS limiter)
// **************************************
const mainLoopForProductionWithFPSLimiter = async () => {
  timer.update();
  const dt = timer.getDelta();

  if (loopState.masterPlay) {
    delta = dt * loopState.playSpeedMultiplier;
    requestAnimationFrame(mainLoop);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
  }
  advanceElapsedTime();

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
  for (const world of getAllECSWorlds()) world.updateMainLoop(delta);
  runSceneMainLoopers(delta, skipFrame);

  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    deltaApp = dt * loopState.playSpeedMultiplier;

    // Step the physics (always, even on a skipped render frame, so it doesn't fall behind)
    stepPhysicsAndPollHeldKeys(delta);

    if (skipFrame) return;

    // app loopers
    for (const world of getAllECSWorlds()) world.updateAppLoop(deltaApp);
    runSceneAppLoopers(deltaApp);
  } else {
    if (skipFrame) return;
  }

  renderScene();

  for (const world of getAllECSWorlds()) world.updateLateMainLoop(delta);
  runSceneMainLateLoopers(delta);
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
  addResizer('canvasResizer', () => {
    const renderer = getRenderer();
    if (!renderer) throw new Error('Could not find current renderer in canvas resizer.');
    const { width, height } = getWindowSize();
    renderer.setSize(width, height);
  });
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

  initWinVisibilityListener();

  if (isDebugEnvironment() || isProdTestMode()) {
    const gui = useDebug(debugGUI, true);
    if (gui) {
      loopState = gui.getSavedLoopState(loopState);
      gui.createLoopDebugControls(loopState);
    }
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

  renderScene();

  if (loopState.masterPlay) {
    // Wait for a few loops and start the main loop (which steps physics itself each frame)
    setTimeout(() => requestAnimationFrame(mainLoop), 100);
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
    useDebug(debugGUI, true)?.refreshAppPlayBinding();
    return;
  }
  loopState.appPlay = !loopState.appPlay;
  useDebug(debugGUI, true)?.refreshAppPlayBinding();
};

/**
 * Sets the loopState.isLoadingScene boolean.
 * @param isLoading (boolean) value for whether the scene is loading or not.
 */
export const setIsLoadingScene = (isLoading: boolean) => (loopState.isLoadingScene = isLoading);

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

let visibilityChangeFns: { [id: string]: (isHidden: boolean) => void } = {};
export const addVisibilityChangeFn = (id: string, fn: (isHidden: boolean) => void) =>
  (visibilityChangeFns[id] = fn);
export const deleteVisibilityChangeFn = (id: string) => delete visibilityChangeFns[id];
export const deleteAllVisibilityChangeFns = () => (visibilityChangeFns = {});
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

let beforeUnloadFns: { [id: string]: () => void } = {};
export const addBeforeUnloadFn = (id: string, fn: () => void) => (beforeUnloadFns[id] = fn);
export const deleteBeforeUnloadFn = (id: string) => delete beforeUnloadFns[id];
export const deleteAllBeforeUnloadFns = () => (beforeUnloadFns = {});
window.addEventListener('beforeunload', () => {
  loopState.isUnloading = true;
  const keys = Object.keys(beforeUnloadFns);
  for (let i = 0; i < keys.length; i++) {
    beforeUnloadFns[keys[i]]();
  }
});

let onWindowBlurFns: { [id: string]: () => void } = {};
export const addOnWindowBlurFn = (id: string, fn: () => void) => (onWindowBlurFns[id] = fn);
export const deleteAddOnWindowBlurFn = (id: string) => delete onWindowBlurFns[id];
export const deleteAllOnWindowBlurFns = () => (onWindowBlurFns = {});
window.addEventListener('blur', () => {
  const keys = Object.keys(onWindowBlurFns);
  for (let i = 0; i < keys.length; i++) {
    onWindowBlurFns[keys[i]]();
  }
});

// Debug
type MainLoopGUIModule = typeof import('../core/Debug/_dbg__MainLoop');
let debugGUI: DebugModuleRef<MainLoopGUIModule> | null = null;

export const registerMainLoopDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__MainLoop'), true);
};
