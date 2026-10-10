/**
 * Views (docs/plans/_DONE_p083_editor-creator-view.md): what the whole canvas shows and what the main
 * loop ticks. There is always exactly one active view. The built-in Runtime view is the loaded
 * scene running with the game/app debugger; editor views (the material editor, …) are
 * registered by modules and show their own private scene and camera.
 *
 * While an editor view is active, the loaded scene is suspended: it stays in memory, but the
 * main loop renders none of it and runs none of its per-frame work (ECS stages, scene loopers,
 * physics, held keys), and getElapsedTime stands still (MainLoop.ts). Switching back to the
 * Runtime view resumes it where it was. Views are not viewports (Viewports.ts): viewports are
 * composited over whichever view is active.
 *
 * No view is registered in production (yet), where this costs the main loop one boolean check.
 */
import type * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import type { SvgIconKey } from './UI/icons/SvgIcon';
import { IS_DEBUG_ENV } from './Config';
import { setSceneDebugCameraInputEnabled } from './CameraManager';
import { setAppInputsSuspended } from './Input/InputState';
import {
  isAppPlaying,
  renderFrameWhileMasterPaused,
  setSceneSuspended,
  toggleAppPlay,
} from './MainLoop';
import { setDrawerSuspendedByView, toggleDrawer } from '../debug/DebuggerGUI';
import { updateOnScreenTools } from '../debug/OnScreenTools';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { lerror, lwarn } from '../utils/Logger';

/** The built-in Runtime view's id: the loaded scene with the game/app debugger. */
export const RUNTIME_VIEW_ID = 'runtime';

/** The Runtime view's view tools button (it has no {@link ViewDef}). */
export const RUNTIME_VIEW_BUTTON: Readonly<{ id: string; title: string; icon: SvgIconKey }> = {
  id: RUNTIME_VIEW_ID,
  title: 'Runtime',
  icon: 'runtime',
};

/** On <body> while an editor view is active: hides the suspended scene's HUD (styles/index.scss)
 * except the elements with KEEP_IN_VIEWS_CLASS (HUD.ts). */
const EDITOR_VIEW_BODY_CLASS = 'aekEditorView';
/** On <body> while that editor view is active (`aekView_<id>`), for the view's own styles. */
const getViewBodyClass = (id: string) => `aekView_${id}`;

/** The active view and the editor views' play flags, restored on refresh (debug env only). */
const LS_KEY = 'AEK_debugViews';
type ViewsLSData = { activeViewId: string; viewPlay: Record<string, boolean> };

/**
 * An orbit camera that debug tools can drive, like the scene debug camera: the axes gizmo
 * follows it, aligns it to an axis and orbits it by a drag. An editor view returns its own from
 * `getCameraRig` (createViewCamera builds one).
 */
export type ViewCameraRig = {
  camera: THREE.Camera;
  controls: OrbitControls;
  /** Disables the controls' canvas input while a debug tool moves the camera itself (the
   * gizmo's drag). `controls.update()` keeps running: it turns the camera to its target. */
  setControlsSuspended: (suspended: boolean) => void;
  /** After a debug tool moved the camera (a gizmo align or drag ended), eg. to save its pose:
   * OrbitControls' `end` event only fires for its own input. */
  onMoveEnd?: () => void;
};

/** An editor view (the Runtime view is built in, not a ViewDef). */
export type ViewDef = {
  /** Unique view id, never {@link RUNTIME_VIEW_ID}. */
  id: string;
  /** The view's name: its view tools button's tooltip and its switch toast (eg. "Material editor"). */
  title: string;
  /** Its view tools button's icon. */
  icon: SvgIconKey;
  /** 'small' for an icon that fills its whole box (eg. a sphere), so it matches the others. */
  iconSize?: 'small';
  /** Position in the view tools group (the Runtime view is always first). */
  orderNr?: number;
  /** The view's own private scene (never added to the root scene). */
  scene: THREE.Scene;
  /** The camera the view is rendered with (nothing is rendered while it returns null). */
  getCamera: () => THREE.Camera | null;
  /** The view's orbit camera rig, which the axes gizmo follows and drives (without one, the
   * gizmo only follows `getCamera`, like the main camera in the Runtime view). */
  getCameraRig?: () => ViewCameraRig | null;
  /** Runs on every switch to this view, before it is rendered for the first time. */
  onEnter?: () => void | Promise<void>;
  /** Runs on every switch away from this view. */
  onExit?: () => void;
  /** Every frame the master loop runs (camera controls, UI). */
  mainUpdate?: (delta: number) => void;
  /** Every frame while the view is playing ({@link isViewPlaying}), eg. an auto-rotation. */
  update?: (delta: number) => void;
  /** What the debug drawer key (h) does in this view. */
  toggleDrawer?: () => void;
};

/** When a view frame listener runs (see {@link addViewFrameListener}). */
export type ViewFrameListenerPhase = 'BEFORE_UPDATE' | 'AFTER_RENDER';

/** A listener for {@link addViewFrameListener}, called with the frame's delta. */
export type ViewFrameListener = (delta: number) => void;
/** A listener for {@link addViewChangeListener}: the new view's id and the previous one's. */
export type ViewChangeListener = (viewId: string, prevViewId: string) => void;

const views = new Map<string, ViewDef>();
/** The active editor view, null in the Runtime view (and between two editor views). */
let activeView: ViewDef | null = null;
/** Whether the scene is suspended: from the start of a switch to an editor view until the
 * switch back to the Runtime view has finished. */
let isSuspended = false;
/** Editor views' play flags (missing = playing). */
const viewPlay: Record<string, boolean> = {};
const beforeUpdateListeners: ViewFrameListener[] = [];
const afterRenderListeners: ViewFrameListener[] = [];
const changeListeners = new Set<ViewChangeListener>();
/** setActiveView calls run one after another (see setActiveView). */
let switchQueue: Promise<unknown> = Promise.resolve();

/**
 * Registers an editor view. A view with the same id is replaced, unless it is active.
 * @param def ({@link ViewDef}) the view
 */
export const registerView = (def: ViewDef) => {
  if (def.id === RUNTIME_VIEW_ID) {
    lerror(`View id "${RUNTIME_VIEW_ID}" is the built-in Runtime view's, in registerView.`);
    return;
  }
  const existing = views.get(def.id);
  if (existing) {
    if (existing === activeView) {
      lwarn(`View "${def.id}" is active and can't be replaced, in registerView.`);
      return;
    }
    lwarn(`View with id "${def.id}" already exists, in registerView. Replacing it.`);
  }
  views.set(def.id, def);
  updateOnScreenTools('VIEW');
};

/**
 * Unregisters an editor view. An active one switches to the Runtime view first.
 * @param id (string) view id
 */
export const unregisterView = async (id: string) => {
  if (!views.has(id)) return;
  if (getActiveViewId() === id) await setActiveView(RUNTIME_VIEW_ID);
  views.delete(id);
  updateOnScreenTools('VIEW');
};

/** The registered editor views, in the view tools group's order (`orderNr`, then registration
 * order). The Runtime view ({@link RUNTIME_VIEW_BUTTON}) is not one of them. */
export const getViews = () => {
  const list = [...views.values()];
  // A stable sort, so the views without an orderNr keep their registration order, last
  const order = (view: ViewDef) => view.orderNr ?? Number.MAX_SAFE_INTEGER;
  return list.sort((a, b) => order(a) - order(b));
};

/** The id of the active view ({@link RUNTIME_VIEW_ID} for the Runtime view). */
export const getActiveViewId = () => activeView?.id ?? RUNTIME_VIEW_ID;

/** The active editor view, or null while the Runtime view is active. */
export const getActiveView = () => activeView;

/** The camera the active editor view is rendered from: its rig's camera, else its `getCamera()`.
 * Null in the Runtime view, and during a switch between editor views. */
export const getActiveViewCamera = (): THREE.Camera | null => {
  const view = activeView;
  if (!view) return null;
  return view.getCameraRig?.()?.camera ?? view.getCamera();
};

/** Whether the Runtime view is active (no editor view, and no switch to one running). */
export const isRuntimeViewActive = () => !isSuspended;

/**
 * Whether a view is playing: an editor view's own play flag (gates its `update`), or for the
 * Runtime view the app loop (isAppPlaying).
 * @param id (string) optional view id, the active view by default
 */
export const isViewPlaying = (id = getActiveViewId()) =>
  id === RUNTIME_VIEW_ID ? isAppPlaying() : viewPlay[id] ?? true;

/**
 * Toggles the active view's play state: an editor view's own play flag, or in the Runtime view
 * the app loop (toggleAppPlay). The master loop (toggleMainPlay) stops every view.
 * @param value (boolean) optional value, the opposite of the current state by default
 */
export const toggleViewPlay = (value?: boolean) => {
  const id = getActiveViewId();
  if (id === RUNTIME_VIEW_ID) {
    toggleAppPlay(value);
    return;
  }
  viewPlay[id] = value ?? !isViewPlaying(id);
  persistViews();
};

/** What the debug drawer key (h) does: the debug drawer in the Runtime view, the editor view's
 * `toggleDrawer` in an editor view (nothing when it has none, or during a switch). */
export const toggleActiveViewDrawer = () => {
  if (!isSuspended) {
    toggleDrawer();
    return;
  }
  activeView?.toggleDrawer?.();
};

/**
 * Adds a listener that runs once per frame, only while an editor view is active (the scene's ECS
 * stages don't run then): for debug tools that must keep working in every view.
 * @param fn ((delta: number) => void) the listener
 * @param phase ({@link ViewFrameListenerPhase}) 'BEFORE_UPDATE' (default): before the view's
 * `mainUpdate`; 'AFTER_RENDER': right after the view is rendered (where LATE_MAIN would run)
 * @returns (() => void) its remover
 */
export const addViewFrameListener = (
  fn: ViewFrameListener,
  phase: ViewFrameListenerPhase = 'BEFORE_UPDATE'
) => {
  const listeners = phase === 'AFTER_RENDER' ? afterRenderListeners : beforeUpdateListeners;
  listeners.push(fn);
  return () => {
    const index = listeners.indexOf(fn);
    if (index > -1) listeners.splice(index, 1);
  };
};

/**
 * Adds a listener that runs after every finished view switch.
 * @param fn ((viewId: string, prevViewId: string) => void) the listener
 * @returns (() => void) its remover
 */
export const addViewChangeListener = (fn: ViewChangeListener) => {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
};

/** MainLoop only: the active editor view's frame, in place of the scene's per-frame work. */
export const runActiveViewFrame = (delta: number) => {
  for (let i = 0; i < beforeUpdateListeners.length; i++) beforeUpdateListeners[i](delta);
  const view = activeView;
  if (!view) return;
  view.mainUpdate?.(delta);
  if (view.update && isViewPlaying(view.id)) view.update(delta);
};

/** MainLoop only: right after the active editor view was rendered. */
export const runActiveViewAfterRender = (delta: number) => {
  for (let i = 0; i < afterRenderListeners.length; i++) afterRenderListeners[i](delta);
};

const suspendScene = () => {
  isSuspended = true;
  setSceneSuspended(true);
  // App keyboard, mouse and touch bindings ignore input (debug key bindings still run). A flag of
  // its own, so a scene loaded meanwhile (app code, HMR) doesn't lift it at the load's end, and
  // the new scene is suspended as soon as it exists (suspension is a loop state)
  setAppInputsSuspended(true);
  // Its OrbitControls listen on the canvas, and debugCameraSystem doesn't run to disable them
  setSceneDebugCameraInputEnabled(false);
  // Hides the scene's HUD; the debug drawer keeps its open state but leaves debugDrawerOpen to
  // the editor view
  document.body.classList.add(EDITOR_VIEW_BODY_CLASS);
  setDrawerSuspendedByView(true);
};

const resumeScene = () => {
  setDrawerSuspendedByView(false);
  document.body.classList.remove(EDITOR_VIEW_BODY_CLASS);
  setSceneDebugCameraInputEnabled(true);
  setAppInputsSuspended(false);
  setSceneSuspended(false);
  isSuspended = false;
};

/** Saves the active view and the play flags (debug env only: no view is registered elsewhere). */
const persistViews = () => {
  if (!IS_DEBUG_ENV) return;
  lsSetItem(LS_KEY, { activeViewId: getActiveViewId(), viewPlay } satisfies ViewsLSData);
};

const notifyViewChange = (viewId: string, prevViewId: string) => {
  for (const fn of changeListeners) {
    try {
      fn(viewId, prevViewId);
    } catch (err) {
      lerror('View change listener failed.', err);
    }
  }
};

const switchView = async (id: string) => {
  const prevId = getActiveViewId();
  if (id === prevId) return true;

  let next: ViewDef | null = null;
  if (id !== RUNTIME_VIEW_ID) {
    next = views.get(id) ?? null;
    if (!next) {
      lwarn(`Could not find view "${id}", in setActiveView.`);
      return false;
    }
  }

  if (activeView) {
    const leaving = activeView;
    try {
      leaving.onExit?.();
    } catch (err) {
      lerror(`View "${leaving.id}" onExit failed, in setActiveView.`, err);
    }
    document.body.classList.remove(getViewBodyClass(leaving.id));
    // Until the next view has entered, the canvas keeps its last frame (MainLoop's renderScene)
    activeView = null;
  } else {
    suspendScene();
  }

  if (next) {
    document.body.classList.add(getViewBodyClass(id));
    try {
      await next.onEnter?.();
    } catch (err) {
      lerror(`View "${id}" onEnter failed, in setActiveView. Returning to the Runtime view.`, err);
      document.body.classList.remove(getViewBodyClass(id));
      resumeScene();
      persistViews();
      notifyViewChange(RUNTIME_VIEW_ID, prevId);
      updateOnScreenTools();
      renderFrameWhileMasterPaused();
      return false;
    }
    activeView = next;
  } else {
    resumeScene();
  }

  persistViews();
  notifyViewChange(id, prevId);
  // The view tools' active button, the play group's pause button, and the switch tools (only
  // built in the Runtime view)
  updateOnScreenTools();
  renderFrameWhileMasterPaused();
  return true;
};

/**
 * Switches the active view. Calls run one after another: a switch still running its `onEnter`
 * makes the next call wait. Switching to the active view is a no-op.
 * @param id (string) view id ({@link RUNTIME_VIEW_ID} for the Runtime view)
 * @returns (Promise<boolean>) whether the view is now active
 */
export const setActiveView = (id: string): Promise<boolean> => {
  const result = switchQueue.then(() => switchView(id));
  switchQueue = result.catch(() => false);
  return result;
};

/**
 * Restores the view that was active before a refresh, and the editor views' play flags. InitApp
 * calls it once at the end of the boot (debug env), after the views are registered and the first
 * scene has loaded (the scene is needed when switching back). A saved view that is no longer
 * registered falls back to the Runtime view and clears the saved state.
 * @returns (Promise<boolean>) whether a saved editor view is now active
 */
export const restoreSavedView = async () => {
  if (!IS_DEBUG_ENV) return false;
  const saved = lsGetItem(LS_KEY, {}) as Partial<ViewsLSData> | null;
  if (!saved || typeof saved !== 'object') return false;
  const id = typeof saved.activeViewId === 'string' ? saved.activeViewId : RUNTIME_VIEW_ID;
  if (id !== RUNTIME_VIEW_ID && !views.has(id)) {
    lwarn(`Saved view "${id}" is not registered, staying in the Runtime view.`);
    lsRemoveItem(LS_KEY);
    return false;
  }
  if (saved.viewPlay && typeof saved.viewPlay === 'object') {
    for (const [viewId, isPlaying] of Object.entries(saved.viewPlay)) {
      if (typeof isPlaying === 'boolean') viewPlay[viewId] = isPlaying;
    }
  }
  if (id === RUNTIME_VIEW_ID) return false;
  return setActiveView(id);
};
