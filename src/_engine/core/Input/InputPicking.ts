import type * as THREE from 'three/webgpu';
import { getActiveCamera } from '../CameraManager';
import { castRayFromScreenPosition } from '../Raycast';
import type { TargetList } from './InputSharedTypes';

/** Raycast options shared by pointer bindings (Mouse/Touch) that pick scene objects. */
export type PickOpts = {
  /** Defaults to the camera currently rendering (getActiveCamera), so picking matches what
   * is on screen — including while the debug camera is active. */
  camera?: THREE.Camera;
  /** Raycast the targets' descendants too. Default true. */
  recursive?: boolean;
};

/** Closest hit among `targets` at a viewport position (MouseEvent/Touch clientX/clientY)
 * on `canvas`, if any. `targetArr` is cleared and reused to avoid allocating per call. */
export const pickTargetsAt = (
  clientX: number,
  clientY: number,
  canvas: HTMLElement,
  targets: TargetList,
  opts: PickOpts,
  targetArr?: THREE.Intersection[]
): THREE.Intersection | undefined => {
  const camera = opts.camera ?? getActiveCamera();
  if (!camera) return undefined;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return undefined;
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
  const objects = typeof targets === 'function' ? targets() : targets;
  if (!objects.length) return undefined;
  if (targetArr) targetArr.length = 0;
  return castRayFromScreenPosition(objects, ndcX, ndcY, camera, {
    recursive: opts.recursive ?? true,
    optionalTargetArr: targetArr,
  })[0];
};
