import type * as THREE from 'three/webgpu';
import { isDebugCameraActive } from '../CameraManager';
import { isDebugEnvironment } from '../Config';
import { getECSWorld } from '../ECS';
import { addOnWindowBlurFn } from '../MainLoop';
import { getCanvasElem } from '../Renderer';
import { getCurrentSceneId } from '../Scene';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { lwarn } from '../../utils/Logger';
import { pickTargetsAt, type PickOpts } from './InputPicking';
import { areAllInputsEnabled } from './InputState';
import type { BindingMeta, EnabledInDebugCam, TargetList } from './InputSharedTypes';

// NOTE! Every raycast here tests only a binding's own `targets`, never the whole scene graph.
// Cost model: each active MOUSE_HOVER binding raycasts its targets at most once per rendered
// frame (only on frames the pointer moved), and click/dblclick bindings once per event. Cheap
// for small curated target lists; hundreds of objects across many hover bindings will add up.

export type MouseButton = 'LEFT' | 'MIDDLE' | 'RIGHT';

type MouseBindingBase = BindingMeta & {
  id: string;
  enabled?: boolean; // default true
  sceneId?: string;
  enabledInDebugCam?: EnabledInDebugCam;
};

/** Fires when a press and release of `button` land on the canvas without dragging, and the
 * click hits one of `targets` (closest hit is passed). */
export type MouseClickBinding = MouseBindingBase &
  PickOpts & {
    type: 'MOUSE_CLICK';
    button: MouseButton;
    targets: TargetList;
    fn: (e: MouseEvent, intersection: THREE.Intersection) => void;
  };

/** onEnter fires when the closest hit among `targets` changes to a new object, onLeave when
 * the previously hovered object is no longer the closest hit (or the pointer left the canvas). */
export type MouseHoverBinding = MouseBindingBase &
  PickOpts & {
    type: 'MOUSE_HOVER';
    targets: TargetList;
    onEnter?: (e: MouseEvent, intersection: THREE.Intersection) => void;
    onLeave?: (e: MouseEvent) => void;
  };

/** Wheel over the canvas, no raycast. */
export type MouseWheelBinding = MouseBindingBase & {
  type: 'MOUSE_WHEEL';
  fn: (e: WheelEvent) => void;
};

/** With `targets`, fires only when the double-click hits one of them; without, always fires
 * (intersection undefined). LEFT uses the native dblclick event, RIGHT is timed manually. */
export type MouseDblClickBinding = MouseBindingBase &
  PickOpts & {
    type: 'MOUSE_DBLCLICK';
    button: 'LEFT' | 'RIGHT';
    targets?: TargetList;
    /** Max time between the two clicks, RIGHT only (LEFT follows the OS setting). Default 300. */
    maxIntervalMs?: number;
    fn: (e: MouseEvent, intersection?: THREE.Intersection) => void;
  };

export type MouseBinding =
  | MouseClickBinding
  | MouseHoverBinding
  | MouseWheelBinding
  | MouseDblClickBinding;

export type MouseBindingType = MouseBinding['type'];

const CLICK_MAX_MOVE_PX = 5;
const DEFAULT_DBLCLICK_MAX_INTERVAL_MS = 300;
const HOVER_SYSTEM_ID = 'inputMouseHoverSystem';
const MOUSE_BUTTONS: MouseButton[] = ['LEFT', 'MIDDLE', 'RIGHT'];

let bindings: MouseBinding[] = [];

let mouseInputsEnabled = true;
export const setMouseInputsEnabled = (enabled: boolean): void => {
  mouseInputsEnabled = enabled;
  hoverDirty = true; // fire onLeave / re-enter next frame
};

/** Where each button was pressed down on the canvas (cleared on release). */
const pressStarts: { [button in MouseButton]?: { x: number; y: number } } = {};
/** Per RIGHT dblclick binding id, the time of its previous (unpaired) click. */
const lastRightClickTimes = new Map<string, number>();
/** Per MOUSE_HOVER binding id, the currently hovered object's uuid. */
const hoveredUuids = new Map<string, string>();
let lastMoveEvent: MouseEvent | null = null;
let pointerOverCanvas = false;
let hoverDirty = false;
let hoverAllInputsEnabled = true;
let hoverSystemWorld: ReturnType<typeof getECSWorld> | null = null;
const hoverIntersects: THREE.Intersection[] = [];

let canvas: HTMLElement | null = null;
let listenersInitiated = false;

const getButton = (e: MouseEvent): MouseButton | undefined => MOUSE_BUTTONS[e.button];

const isInputInDebugCamInvalid = (enabledInDebugCam?: EnabledInDebugCam) =>
  isDebugEnvironment() &&
  ((enabledInDebugCam === 'NOT_ENABLED_IN_DEBUG' && isDebugCameraActive()) ||
    (enabledInDebugCam === 'ENABLED_ONLY_IN_DEBUG' && !isDebugCameraActive()));

const isBindingActive = (binding: MouseBinding) =>
  mouseInputsEnabled &&
  areAllInputsEnabled() &&
  binding.enabled !== false &&
  !isInputInDebugCamInvalid(binding.enabledInDebugCam) &&
  (!binding.sceneId || binding.sceneId === getCurrentSceneId());

/** Closest hit among the binding's targets at the event's canvas position, if any. */
const raycastTargets = (
  e: MouseEvent,
  targets: TargetList,
  opts: PickOpts,
  targetArr?: THREE.Intersection[]
): THREE.Intersection | undefined =>
  canvas ? pickTargetsAt(e.clientX, e.clientY, canvas, targets, opts, targetArr) : undefined;

const fireDblClick = (binding: MouseDblClickBinding, e: MouseEvent) => {
  if (!binding.targets) {
    binding.fn(e);
    return;
  }
  const hit = raycastTargets(e, binding.targets, binding);
  if (hit) binding.fn(e, hit);
};

const onMouseDown = (e: MouseEvent) => {
  const button = getButton(e);
  if (!button || e.target !== canvas) return;
  pressStarts[button] = { x: e.clientX, y: e.clientY };
};

const onMouseUp = (e: MouseEvent) => {
  const button = getButton(e);
  if (!button) return;
  const start = pressStarts[button];
  delete pressStarts[button];
  // A click must both start and end on the canvas without dragging (e.g. orbiting the camera)
  if (!start || e.target !== canvas) return;
  if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_MAX_MOVE_PX) return;

  const timeNow = performance.now();
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (binding.type === 'MOUSE_CLICK') {
      if (binding.button !== button || !isBindingActive(binding)) continue;
      const hit = raycastTargets(e, binding.targets, binding);
      if (hit) binding.fn(e, hit);
      continue;
    }
    if (binding.type === 'MOUSE_DBLCLICK' && binding.button === 'RIGHT' && button === 'RIGHT') {
      if (!isBindingActive(binding)) continue;
      // The native dblclick event only fires for the left button, so time right clicks here
      const lastTime = lastRightClickTimes.get(binding.id);
      const maxInterval = binding.maxIntervalMs ?? DEFAULT_DBLCLICK_MAX_INTERVAL_MS;
      if (lastTime !== undefined && timeNow - lastTime <= maxInterval) {
        lastRightClickTimes.delete(binding.id); // a third click starts a new pair
        fireDblClick(binding, e);
      } else {
        lastRightClickTimes.set(binding.id, timeNow);
      }
    }
  }
};

const onDblClick = (e: MouseEvent) => {
  if (e.target !== canvas) return;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (binding.type !== 'MOUSE_DBLCLICK' || binding.button !== 'LEFT') continue;
    if (isBindingActive(binding)) fireDblClick(binding, e);
  }
};

const onWheel = (e: WheelEvent) => {
  if (e.target !== canvas) return;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (binding.type === 'MOUSE_WHEEL' && isBindingActive(binding)) binding.fn(e);
  }
};

const onMouseMove = (e: MouseEvent) => {
  lastMoveEvent = e;
  pointerOverCanvas = e.target === canvas;
  hoverDirty = true;
};

const onPointerLeaveWindow = () => {
  pointerOverCanvas = false;
  hoverDirty = true;
};

const onContextMenu = (e: MouseEvent) => {
  // The browser's context menu would swallow right clicks meant for the scene
  if (e.target !== canvas) return;
  const hasRightBinding = bindings.some(
    (b) => (b.type === 'MOUSE_CLICK' || b.type === 'MOUSE_DBLCLICK') && b.button === 'RIGHT'
  );
  if (hasRightBinding) e.preventDefault();
};

const clearHover = (binding: MouseHoverBinding, callOnLeave: boolean) => {
  if (!hoveredUuids.has(binding.id)) return;
  hoveredUuids.delete(binding.id);
  if (callOnLeave && lastMoveEvent) binding.onLeave?.(lastMoveEvent);
};

/** Resolves hover state at most once per frame, and only on frames the pointer moved
 * (mousemove fires far more often than frames render). */
const hoverSystem = () => {
  // The master switch (InputState.ts) can't flag hover dirty itself, so notice its changes here
  const allEnabled = areAllInputsEnabled();
  if (allEnabled !== hoverAllInputsEnabled) {
    hoverAllInputsEnabled = allEnabled;
    hoverDirty = true;
  }
  if (!hoverDirty) return;
  hoverDirty = false;
  const e = lastMoveEvent;
  if (!e) return;

  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (binding.type !== 'MOUSE_HOVER') continue;
    if (binding.sceneId && binding.sceneId !== getCurrentSceneId()) {
      // Its scene is gone, so its objects likely are too: forget the hover without callbacks
      clearHover(binding, false);
      continue;
    }
    if (!isBindingActive(binding)) {
      clearHover(binding, true);
      continue;
    }

    const hit = pointerOverCanvas
      ? raycastTargets(e, binding.targets, binding, hoverIntersects)
      : undefined;
    const prevUuid = hoveredUuids.get(binding.id);
    if (hit?.object.uuid === prevUuid) continue;
    clearHover(binding, true);
    if (hit) {
      hoveredUuids.set(binding.id, hit.object.uuid);
      binding.onEnter?.(e, hit);
    }
  }
  hoverIntersects.length = 0;
};

const initHoverSystem = () => {
  const world = getECSWorld();
  if (hoverSystemWorld === world) return;
  hoverSystemWorld = world;
  world.addSystem(ECSSystemStage.MAIN, HOVER_SYSTEM_ID, hoverSystem);
};

const initMouseListeners = () => {
  if (listenersInitiated) return;
  listenersInitiated = true;
  canvas = getCanvasElem();
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('dblclick', onDblClick);
  window.addEventListener('wheel', onWheel);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('contextmenu', onContextMenu);
  document.documentElement.addEventListener('mouseleave', onPointerLeaveWindow);
  addOnWindowBlurFn('inputMousePressesClear', () => {
    for (const button of MOUSE_BUTTONS) delete pressStarts[button];
    lastRightClickTimes.clear();
    onPointerLeaveWindow();
  });
};

export const createMouseBinding = (binding: MouseBinding): void => {
  deleteMouseBinding(binding.id);
  bindings.push(binding);
  initMouseListeners();
  if (binding.type === 'MOUSE_HOVER') {
    initHoverSystem();
    hoverDirty = true; // resolve against the current pointer position right away
  }
};

export const deleteMouseBinding = (id: string): void => {
  bindings = bindings.filter((b) => b.id !== id);
  hoveredUuids.delete(id);
  lastRightClickTimes.delete(id);
};

export const setMouseBindingEnabled = (id: string, enabled: boolean): void => {
  const binding = bindings.find((b) => b.id === id);
  if (!binding) {
    lwarn(`Could not find mouse binding with id "${id}" in setMouseBindingEnabled.`);
    return;
  }
  binding.enabled = enabled;
  if (binding.type === 'MOUSE_HOVER') hoverDirty = true; // fire onLeave / re-enter next frame
};
