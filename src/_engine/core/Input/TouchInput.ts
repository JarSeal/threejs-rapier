import type * as THREE from 'three/webgpu';
import { isDebugCameraActive } from '../CameraManager';
import { isDebugEnvironment } from '../Config';
import { addOnWindowBlurFn } from '../MainLoop';
import { getCanvasElem } from '../Renderer';
import { getCurrentSceneId } from '../Scene';
import { lwarn } from '../../utils/Logger';
import { pickTargetsAt, type PickOpts } from './InputPicking';
import { areAllInputsEnabled } from './InputState';
import type { BindingMeta, EnabledInDebugCam, TargetList } from './InputSharedTypes';

// Only gestures that start on the canvas count (touches on the HUD/debug UI are ignored).
// Browsers also emulate mouse events after a tap, so a tap can fire MOUSE_CLICK bindings too.

type TouchBindingBase = BindingMeta & {
  id: string;
  enabled?: boolean; // default true
  sceneId?: string;
  enabledInDebugCam?: EnabledInDebugCam;
};

/** A single-finger touch released quickly without moving. With `targets`, fires only when the
 * tap hits one of them (closest hit is passed); without, always fires (intersection undefined). */
export type TouchTapBinding = TouchBindingBase &
  PickOpts & {
    type: 'TOUCH_TAP';
    targets?: TargetList;
    /** touchstart -> touchend under this is a tap. Default 250. */
    maxDurationMs?: number;
    /** Moving further than this makes it a drag, not a tap. Default 10. */
    maxMoveDistancePx?: number;
    fn: (e: TouchEvent, intersection?: THREE.Intersection) => void;
  };

/** A single finger moving further than a tap would (a second finger ends it, see TOUCH_PINCH).
 * onMove's delta is in CSS pixels since the previous onMove (or onStart). */
export type TouchDragBinding = TouchBindingBase & {
  type: 'TOUCH_DRAG';
  onStart?: (e: TouchEvent) => void;
  onMove?: (e: TouchEvent, delta: { x: number; y: number }) => void;
  onEnd?: (e: TouchEvent) => void;
};

/** Two (or more) fingers: distance is between the first two touches in CSS pixels,
 * deltaDistance its change since the previous onPinch (positive = spreading apart). */
export type TouchPinchBinding = TouchBindingBase & {
  type: 'TOUCH_PINCH';
  onPinch: (e: TouchEvent, distance: number, deltaDistance: number) => void;
};

export type TouchBinding = TouchTapBinding | TouchDragBinding | TouchPinchBinding;

export type TouchBindingType = TouchBinding['type'];

const DEFAULT_TAP_MAX_DURATION_MS = 250;
const DEFAULT_TAP_MAX_MOVE_PX = 10;
const DRAG_START_PX = DEFAULT_TAP_MAX_MOVE_PX;

let bindings: TouchBinding[] = [];

let touchInputsEnabled = true;
export const setTouchInputsEnabled = (enabled: boolean): void => {
  touchInputsEnabled = enabled;
};

type SingleTouchGesture = {
  identifier: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  maxMovePx: number;
  isTapCandidate: boolean; // false once a second finger joins
  isDragging: boolean;
};

let single: SingleTouchGesture | null = null;
let pinchLastDistance: number | null = null;

let canvas: HTMLElement | null = null;
let listenersInitiated = false;

const isInputInDebugCamInvalid = (enabledInDebugCam?: EnabledInDebugCam) =>
  isDebugEnvironment() &&
  ((enabledInDebugCam === 'NOT_ENABLED_IN_DEBUG' && isDebugCameraActive()) ||
    (enabledInDebugCam === 'ENABLED_ONLY_IN_DEBUG' && !isDebugCameraActive()));

const isBindingActive = (binding: TouchBinding) =>
  touchInputsEnabled &&
  areAllInputsEnabled() &&
  binding.enabled !== false &&
  !isInputInDebugCamInvalid(binding.enabledInDebugCam) &&
  (!binding.sceneId || binding.sceneId === getCurrentSceneId());

const hasActiveBinding = (type: TouchBindingType) =>
  bindings.some((b) => b.type === type && isBindingActive(b));

const findTouch = (list: TouchList, identifier: number): Touch | undefined => {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === identifier) return list[i];
  }
  return undefined;
};

const touchDistance = (a: Touch, b: Touch) =>
  Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

const endDrag = (e: TouchEvent) => {
  if (!single?.isDragging) return;
  single.isDragging = false;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (binding.type === 'TOUCH_DRAG' && isBindingActive(binding)) binding.onEnd?.(e);
  }
};

const fireTaps = (e: TouchEvent, touch: Touch) => {
  if (!single || !canvas) return;
  const duration = performance.now() - single.startTime;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (binding.type !== 'TOUCH_TAP' || !isBindingActive(binding)) continue;
    if (duration > (binding.maxDurationMs ?? DEFAULT_TAP_MAX_DURATION_MS)) continue;
    if (single.maxMovePx > (binding.maxMoveDistancePx ?? DEFAULT_TAP_MAX_MOVE_PX)) continue;
    if (!binding.targets) {
      binding.fn(e);
      continue;
    }
    const hit = pickTargetsAt(touch.clientX, touch.clientY, canvas, binding.targets, binding);
    if (hit) binding.fn(e, hit);
  }
};

const onTouchStart = (e: TouchEvent) => {
  if (e.target !== canvas) return;
  if (e.touches.length === 1) {
    const t = e.touches[0];
    single = {
      identifier: t.identifier,
      startX: t.clientX,
      startY: t.clientY,
      lastX: t.clientX,
      lastY: t.clientY,
      startTime: performance.now(),
      maxMovePx: 0,
      isTapCandidate: true,
      isDragging: false,
    };
    pinchLastDistance = null;
    return;
  }
  // A second finger turns the gesture into a pinch: no tap, and any drag ends here
  endDrag(e);
  if (single) single.isTapCandidate = false;
  pinchLastDistance = touchDistance(e.touches[0], e.touches[1]);
};

const onTouchMove = (e: TouchEvent) => {
  if (e.target !== canvas) return;

  if (e.touches.length >= 2 && pinchLastDistance !== null) {
    if (hasActiveBinding('TOUCH_PINCH')) e.preventDefault(); // stop the native page zoom
    const distance = touchDistance(e.touches[0], e.touches[1]);
    const deltaDistance = distance - pinchLastDistance;
    pinchLastDistance = distance;
    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i];
      if (binding.type === 'TOUCH_PINCH' && isBindingActive(binding)) {
        binding.onPinch(e, distance, deltaDistance);
      }
    }
    return;
  }

  // Single finger. After a pinch the remaining finger doesn't restart a drag (it would jump).
  if (!single || !single.isTapCandidate || e.touches.length !== 1) return;
  const t = findTouch(e.touches, single.identifier);
  if (!t) return;
  if (hasActiveBinding('TOUCH_DRAG')) e.preventDefault(); // stop native scrolling
  single.maxMovePx = Math.max(
    single.maxMovePx,
    Math.hypot(t.clientX - single.startX, t.clientY - single.startY)
  );
  if (!single.isDragging) {
    if (single.maxMovePx <= DRAG_START_PX) return;
    single.isDragging = true;
    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i];
      if (binding.type === 'TOUCH_DRAG' && isBindingActive(binding)) binding.onStart?.(e);
    }
  }
  const delta = { x: t.clientX - single.lastX, y: t.clientY - single.lastY };
  single.lastX = t.clientX;
  single.lastY = t.clientY;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (binding.type === 'TOUCH_DRAG' && isBindingActive(binding)) binding.onMove?.(e, delta);
  }
};

const onTouchEnd = (e: TouchEvent) => {
  if (e.target !== canvas) return;
  if (e.touches.length >= 2) {
    pinchLastDistance = touchDistance(e.touches[0], e.touches[1]);
    return;
  }
  pinchLastDistance = null;
  if (e.touches.length === 1) return; // wait for the last finger

  endDrag(e);
  if (e.type === 'touchend' && single?.isTapCandidate) {
    const t = findTouch(e.changedTouches, single.identifier);
    if (t) fireTaps(e, t);
  }
  single = null;
};

const resetGesture = () => {
  single = null;
  pinchLastDistance = null;
};

const initTouchListeners = () => {
  if (listenersInitiated) return;
  listenersInitiated = true;
  canvas = getCanvasElem();
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  // Non-passive only where preventDefault is needed (native pinch-zoom/scroll during gestures)
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true });
  addOnWindowBlurFn('inputTouchGestureClear', resetGesture);
};

export const createTouchBinding = (binding: TouchBinding): void => {
  deleteTouchBinding(binding.id);
  bindings.push(binding);
  initTouchListeners();
};

export const deleteTouchBinding = (id: string): void => {
  bindings = bindings.filter((b) => b.id !== id);
};

export const setTouchBindingEnabled = (id: string, enabled: boolean): void => {
  const binding = bindings.find((b) => b.id === id);
  if (!binding) {
    lwarn(`Could not find touch binding with id "${id}" in setTouchBindingEnabled.`);
    return;
  }
  binding.enabled = enabled;
};
