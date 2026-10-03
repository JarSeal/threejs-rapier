/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import type { ECSWorld } from '../../../_engine/core/ECS';
import { CoreComponentType } from '../../../_engine/core/ECS/ECSRegistry';
import { lwarn } from '../../../_engine/utils/Logger';
import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from '../../../AppECSRegistry';

// Only type-only imports from `_engine/core` here, besides ECSRegistry and Logger (no local
// imports): AppECSRegistry.ts imports this file for SunShadowFitComponentType, inside the
// ECSCoreComponents ↔ AppECSRegistry import cycle (see InstancedMeshPoolTypes.ts). So the main camera
// is looked up through the world, not with CameraManager's getMainCamera.

/** Internal Key (Values) */
export enum SunShadowFitComponentType {
  SUN_SHADOW_FIT = 'TOOL_SUN_SHADOW_FIT',
}

/**
 * Fits a directional light's shadow camera to a camera's view every frame (add it to the light's
 * entity). The light keeps its direction and moves with the view, so the shadows cover the whole
 * screen wherever the camera goes, with one shadow map (no cascades).
 *
 * The covered view slice (the camera's frustum from `near` to `min(far, maxDistance)`) is wrapped
 * in a bounding sphere, so the shadow camera's extents only change when the camera zooms or the
 * window resizes, not when it turns. Its center is snapped to shadow map texels in light space,
 * so the shadows don't shimmer while the view moves.
 *
 * While the component is on a light, the light owns nothing of its position, its target's
 * position or its shadow camera's frustum (left/right/top/bottom/near/far): edits to them (eg.
 * from the debug Lights tab) are overwritten on the next view change. Lights managed by another
 * system (eg. the sky box's sun, which follows the camera on its own) are skipped with a warning.
 */
export interface SunShadowFitData {
  /** Camera entity whose view the shadow must cover (default: the current main camera, also
   * while the debug camera is active). */
  cameraEntityId?: number;
  /** Clip the covered view slice to this distance from the camera (world units). The shadow map
   * covers a sphere about this wide, so it sets the shadow resolution. */
  maxDistance: number;
  /** Extra depth toward the sun, so off-screen casters (tall walls, hills) still cast into the
   * view (world units). */
  casterExtension: number;
  /** Distance from the fitted center to the light, along the sun direction. It only places the
   * shadow camera's near and far planes. Default: `radius + casterExtension + 1`, which keeps the
   * near plane at 1. */
  lightDistance?: number;
  /** Direction toward the sun (normalized on use). Default: from the light's target to the
   * light, as the light stands when the effect first runs. Set it to turn the sun. */
  direction?: THREE.Vector3;
  /** Snap the fitted center to whole shadow map texels in light space (prevents shimmering).
   * Default true. */
  snapToTexels?: boolean;
  /** Fallback center when no camera is available (eg. the player entity). The frustum's extents
   * then stay as they are. */
  followEntityId?: number;
}

export interface SunShadowFitComponentData {
  [SunShadowFitComponentType.SUN_SHADOW_FIT]: SunShadowFitData;
}

/** Per-component runtime state, keyed by the component's data object (gone with it). */
type FitState = {
  /** Toward the sun, normalized. */
  direction: THREE.Vector3;
  /** The direction the light-space axes were built from. */
  axesDirection: THREE.Vector3;
  /** The direction of the last write. */
  lastDirection: THREE.Vector3;
  axisX: THREE.Vector3;
  axisY: THREE.Vector3;
  axisZ: THREE.Vector3;
  lastCenter: THREE.Vector3;
  lastDistance: number;
  hasWritten: boolean;
};

const states = new WeakMap<SunShadowFitData, FitState>();
/** Components whose skipped light was already warned about. */
const warned = new WeakSet<SunShadowFitData>();

// Scratch objects (no allocations on the per-frame path)
const _center = new THREE.Vector3();
const _snapped = new THREE.Vector3();
const _lightPos = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const snapToStep = (value: number, step: number) => Math.round(value / step) * step;

/** The shadow camera's axes for a light looking along -axisZ (as Matrix4.lookAt builds them
 * with the default up, including its nudge when looking straight down). */
const setLightSpaceAxes = (state: FitState) => {
  state.axesDirection.copy(state.direction);
  state.axisZ.copy(state.direction);
  state.axisX.crossVectors(UP, state.axisZ);
  if (state.axisX.lengthSq() === 0) {
    state.axisZ.z += 0.0001;
    state.axisZ.normalize();
    state.axisX.crossVectors(UP, state.axisZ);
  }
  state.axisX.normalize();
  state.axisY.crossVectors(state.axisZ, state.axisX);
};

/**
 * Writes the bounding sphere of `camera`'s view slice from its near plane to `maxDistance` (or
 * its far plane, if nearer) into `outCenter` (world space) and returns its radius, or -1 for an
 * empty slice or an unsupported camera.
 */
const getViewSliceSphere = (
  camera: THREE.Camera,
  maxDistance: number,
  outCenter: THREE.Vector3
) => {
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const cam = camera as THREE.PerspectiveCamera;
    const n = cam.near;
    const f = Math.min(cam.far, maxDistance);
    if (f <= n) return -1;
    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.getEffectiveFOV()) / 2);
    const tanX = tanY * cam.aspect;
    // k: the slice's half-diagonal per unit of depth
    const k2 = tanX * tanX + tanY * tanY;
    // The depth equally far from the near and far corners, or the far plane's center when that
    // lies beyond it (a wide view: the far corners alone set the sphere)
    const c = Math.min(f, 0.5 * (f + n) * (1 + k2));
    outCenter.set(0, 0, -c).applyMatrix4(cam.matrixWorld);
    return Math.sqrt((f - c) * (f - c) + f * f * k2);
  }
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const cam = camera as THREE.OrthographicCamera;
    const n = cam.near;
    const f = Math.min(cam.far, maxDistance);
    if (f <= n) return -1;
    const halfX = (cam.right - cam.left) / (2 * cam.zoom);
    const halfY = (cam.top - cam.bottom) / (2 * cam.zoom);
    const halfZ = (f - n) / 2;
    outCenter
      .set((cam.right + cam.left) / 2, (cam.top + cam.bottom) / 2, -(n + f) / 2)
      .applyMatrix4(cam.matrixWorld);
    return Math.sqrt(halfX * halfX + halfY * halfY + halfZ * halfZ);
  }
  return -1;
};

/** `cameraEntityId`'s camera, else the main camera (TAG_IS_MAIN_CAMERA, which the debug camera
 * never takes). */
const resolveCamera = (world: ECSWorld, data: SunShadowFitData): THREE.Camera | undefined => {
  let cameraId = data.cameraEntityId;
  if (cameraId === undefined) {
    for (const [id] of world.getStorage(CoreComponentType.TAG_IS_MAIN_CAMERA)) {
      cameraId = id;
      break;
    }
  }
  if (cameraId === undefined) return undefined;
  const value = world.getComponent(cameraId, CoreComponentType.OBJECT3D)?.value;
  return (value as THREE.Camera | undefined)?.isCamera ? (value as THREE.Camera) : undefined;
};

/** Writes the followed entity's position into `out`; false without one. */
const getFollowPosition = (world: ECSWorld, entityId: number, out: THREE.Vector3) => {
  const transformStore = world.getTypedTransformStore();
  if (transformStore) {
    const slot = transformStore.getSlot(entityId);
    if (slot === -1) return false;
    out.set(transformStore.posX[slot], transformStore.posY[slot], transformStore.posZ[slot]);
    return true;
  }
  const transform = world.getComponent(entityId, CoreComponentType.TRANSFORM);
  if (!transform) return false;
  out.copy(transform.position);
  return true;
};

/** Writes an entity's TRANSFORM position, so the ECS state matches the Object3D written here. */
const writeTransformPosition = (world: ECSWorld, entityId: number, p: THREE.Vector3) => {
  const transformStore = world.getTypedTransformStore();
  if (transformStore) {
    const slot = transformStore.getSlot(entityId);
    if (slot !== -1) transformStore.setPosition(slot, p.x, p.y, p.z);
    return;
  }
  const transform = world.getComponent(entityId, CoreComponentType.TRANSFORM);
  if (!transform) return;
  transform.position.copy(p);
  transform.setDirty();
  world.commitTransform(entityId, transform);
};

const getState = (data: SunShadowFitData, light: THREE.DirectionalLight) => {
  let state = states.get(data);
  if (state) return state;
  const direction = new THREE.Vector3();
  light.getWorldPosition(direction).sub(light.target.getWorldPosition(_lightPos));
  if (direction.lengthSq() === 0) direction.set(0, 1, 0);
  state = {
    direction: direction.normalize(),
    axesDirection: new THREE.Vector3(),
    lastDirection: new THREE.Vector3(),
    axisX: new THREE.Vector3(),
    axisY: new THREE.Vector3(),
    axisZ: new THREE.Vector3(),
    lastCenter: new THREE.Vector3(),
    lastDistance: 0,
    hasWritten: false,
  };
  setLightSpaceAxes(state);
  states.set(data, state);
  return state;
};

const warnOnce = (data: SunShadowFitData, entityId: number, reason: string) => {
  if (warned.has(data)) return;
  warned.add(data);
  lwarn(`[SunShadowFit] Skipping entity ${entityId}: ${reason}`);
};

/** ECS System */
export const sunShadowFitSystem = (world: ECSWorld) => {
  const storage = world.getStorage(SunShadowFitComponentType.SUN_SHADOW_FIT as any);
  if (!storage) return;

  for (const [entityId, data] of storage as Iterable<[number, SunShadowFitData]>) {
    if (world.isDisabled(entityId)) continue;
    const light = world.getComponent(entityId, CoreComponentType.OBJECT3D)?.value as
      | THREE.DirectionalLight
      | undefined;
    if (!light?.isDirectionalLight) {
      warnOnce(data, entityId, 'not a directional light.');
      continue;
    }
    if (world.hasComponent(entityId, CoreComponentType.MANAGED_BY)) {
      warnOnce(data, entityId, 'the light is managed by another system, which places it itself.');
      continue;
    }
    const targetId = world.getComponent(entityId, CoreComponentType.TARGET_LINK)?.targetId;
    if (targetId === undefined) continue;

    const state = getState(data, light);
    if (data.direction) {
      state.direction.copy(data.direction).normalize();
      if (!state.direction.equals(state.axesDirection)) setLightSpaceAxes(state);
    }

    // The covered sphere (or, without a camera, the followed entity and the current extents)
    const shadowCam = light.shadow.camera;
    let radius = -1;
    const camera = resolveCamera(world, data);
    if (camera) {
      camera.updateMatrixWorld();
      radius = getViewSliceSphere(camera, data.maxDistance, _center);
    }
    if (radius < 0) {
      if (data.followEntityId === undefined) continue;
      if (!getFollowPosition(world, data.followEntityId, _center)) continue;
      radius = (shadowCam.right - shadowCam.left) / 2;
    }

    // Snap the center to texels in light space (depth unsnapped: moving along the light doesn't
    // shimmer)
    const { axisX, axisY, axisZ } = state;
    if (data.snapToTexels !== false) {
      const texelSize = (radius * 2) / light.shadow.mapSize.width;
      _snapped
        .copy(axisX)
        .multiplyScalar(snapToStep(_center.dot(axisX), texelSize))
        .addScaledVector(axisY, snapToStep(_center.dot(axisY), texelSize))
        .addScaledVector(axisZ, _center.dot(axisZ));
    } else {
      _snapped.copy(_center);
    }

    const casterExtension = Math.max(0, data.casterExtension);
    const distance = data.lightDistance ?? radius + casterExtension + 1;
    const near = distance - radius - casterExtension;
    const far = distance + radius;

    // The extents (only on a zoom, a resize or a settings change)
    if (
      shadowCam.right !== radius ||
      shadowCam.top !== radius ||
      shadowCam.near !== near ||
      shadowCam.far !== far
    ) {
      shadowCam.left = -radius;
      shadowCam.right = radius;
      shadowCam.top = radius;
      shadowCam.bottom = -radius;
      shadowCam.near = near;
      shadowCam.far = far;
      shadowCam.updateProjectionMatrix();
    } else if (
      state.hasWritten &&
      distance === state.lastDistance &&
      _snapped.equals(state.lastCenter) &&
      state.direction.equals(state.lastDirection)
    ) {
      continue;
    }
    state.lastCenter.copy(_snapped);
    state.lastDirection.copy(state.direction);
    state.lastDistance = distance;
    state.hasWritten = true;

    // The Object3Ds directly (a TRANSFORM write would reach them only next frame), then the
    // TRANSFORMs, so the ECS state agrees and the next object3DSyncSystem keeps these positions
    _lightPos.copy(_snapped).addScaledVector(state.direction, distance);
    light.position.copy(_lightPos);
    light.updateMatrixWorld();
    light.target.position.copy(_snapped);
    light.target.updateMatrixWorld();
    writeTransformPosition(world, entityId, _lightPos);
    writeTransformPosition(world, targetId, _snapped);
  }
};

/** The Registration Helper */
export const registerSunShadowFitEffect = (world: ECSWorld) => {
  // After the follow camera rig has placed this frame's camera, before frustum culling
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'sunShadowFitSystem',
    sunShadowFitSystem,
    APP_RENDER_SYNC_ORDER.SHADOW_FIT
  );
  return world;
};
