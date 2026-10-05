import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

import { ECSWorld } from '../../ECS';
import { getCanvasElem } from '../../Renderer';
import { ECSSystemStage } from '../../../../AppECSRegistry';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import type { DebugCamLSProps } from '../../CameraManager';
import { getDebugCamProps, saveDebugCameraToLS, updateCamerasDebuggerGUI } from './_dbg__CameraGUI';
import { getConfig } from '../../Config';

const configDebugCamera = getConfig().debugCamera;

export const DEFAULT_DEBUG_CAM_PROPS: DebugCamLSProps = {
  position: configDebugCamera?.position ?? { x: 3, y: 3, z: 1.5 },
  target: configDebugCamera?.target ?? { x: 0, y: 0, z: 0 },
  enabled: false,
  latestAppCameraId: null as string | null,
  fov: configDebugCamera?.fov ?? 60,
  near: configDebugCamera?.near ?? 0.1,
  far: configDebugCamera?.far ?? 1000,
  zoom: configDebugCamera?.zoom ?? 1,
};

ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.MAIN, 'debugCameraSystem', debugCameraSystem);
});

let panelRefreshCallback: (() => void) | null = null;
/** Set while another debug tool moves the debug camera itself (the axes gizmo's drag orbit):
 * debugCameraSystem then keeps the OrbitControls disabled instead of re-enabling them. */
let isControlsSuspended = false;
/** False while an editor view is active (ViewManager.ts): the scene is suspended and the
 * canvas belongs to the view, so the OrbitControls stay disabled, also when a scene loads
 * meanwhile. */
let isSceneInputEnabled = true;

/**
 * Enables or disables the scene debug camera's canvas input (its OrbitControls), right away:
 * debugCameraSystem doesn't run while an editor view suspends the scene. ViewManager.ts only
 * (through CameraManager's setSceneDebugCameraInputEnabled).
 * @param enabled (boolean)
 * @param world (ECSWorld) the world the debug camera is in
 */
export const setSceneDebugCameraInputEnabled = (enabled: boolean, world: ECSWorld) => {
  isSceneInputEnabled = enabled;
  for (const [entityId, data] of world.getStorage(ComponentType.ORBIT_CONTROLS)) {
    data.controls.enabled = enabled && !world.isDisabled(entityId) && !isControlsSuspended;
  }
};

/**
 * Suspends (disables) the debug camera's OrbitControls while another debug tool moves the
 * camera itself, eg. the axes gizmo's drag orbit. `controls.update()` still runs every frame.
 * @param suspended (boolean)
 */
export const setDebugCameraControlsSuspended = (suspended: boolean) => {
  isControlsSuspended = suspended;
};

/**
 * Registers a callback that `debugCameraSystem` calls once per frame whenever OrbitControls
 * reports a change, so a debug-tools panel showing live camera values can refresh itself
 * without polling. Pass `null` to unregister (e.g. when the panel's pane is torn down) —
 * callers must do so, since a stale callback would otherwise keep firing against disposed
 * Tweakpane bindings. Kept as a plain callback (rather than an import) so this file never
 * has to import the debug-tools panel module back.
 */
export const setDebugCameraPanelRefresh = (cb: (() => void) | null) => {
  panelRefreshCallback = cb;
};

export const attachOrbitControls = (entityId: number, world: ECSWorld, sceneId: string) => {
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value as THREE.Camera;
  const canvas = getCanvasElem();

  const controls = new OrbitControls(obj, canvas);

  // --- MEMORIZATION (Load) ---
  const props = getDebugCamProps(sceneId);
  const { position, target, enabled } = props;
  obj.position.set(position.x, position.y, position.z);
  controls.target.set(target.x, target.y, target.z);
  controls.enabled = enabled && isSceneInputEnabled;
  controls.update();

  controls.addEventListener('end', () => {
    saveDebugCameraToLS({
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    });
  });

  // OrbitControls applies rotate/pan/dolly synchronously inside its own pointermove handler
  // (it calls its internal update() there directly), dispatching 'change' immediately — well
  // before debugCameraSystem's next per-frame poll ever sees a diff to react to. So a live panel
  // must hook 'change' directly rather than relying on that poll's own `changed` return value.
  controls.addEventListener('change', () => panelRefreshCallback?.());

  world.addComponent(entityId, ComponentType.ORBIT_CONTROLS, {
    controls,
    sceneId,
  });
};

/**
 * System to sync OrbitControls back to ECS Transform
 */
export function debugCameraSystem(world: ECSWorld) {
  const storage = world.getStorage(ComponentType.ORBIT_CONTROLS);

  for (const [entityId, data] of storage) {
    const isDisabled = world.isDisabled(entityId);
    data.controls.enabled = !isDisabled && !isControlsSuspended && isSceneInputEnabled;

    if (isDisabled) continue;

    const changed = data.controls.update();

    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);

    if (changed && transform && objComp) {
      transform.position.copy(objComp.value.position);
      transform.quaternion.copy(objComp.value.quaternion);
      transform.setDirty();
      objComp._lastVersion = transform.version;
      world.commitTransform(entityId, transform);
    }
  }
}

export const toggleDebugCamera = (
  world: ECSWorld,
  useDebug: boolean,
  setActiveCamera: (entityId: number) => void
) => {
  const gameCam = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA).next().value;
  const debugCam = world.getEntitiesWith(ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA).next().value;

  if (useDebug && debugCam !== undefined) {
    // if (gameCam !== undefined) world.setDisabled(gameCam, true);
    world.setDisabled(debugCam, false);

    const orbitData = world.getComponent(debugCam, ComponentType.ORBIT_CONTROLS);
    if (orbitData) orbitData.controls.update();

    setActiveCamera(debugCam);
  } else if (!useDebug) {
    if (debugCam !== undefined) world.setDisabled(debugCam, true);
    setActiveCamera(gameCam);
  }

  saveDebugCameraToLS({ enabled: useDebug });

  updateCamerasDebuggerGUI('LIST');
};

export const debugCamSceneChange = (newSceneId: string, world: ECSWorld) => {
  const debugCamId = world.getEntitiesWith(ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA).next().value;
  if (debugCamId === undefined) return;

  const objComp = world.getComponent(debugCamId, ComponentType.OBJECT3D);
  const orbitComp = world.getComponent(debugCamId, ComponentType.ORBIT_CONTROLS);
  if (!objComp || !orbitComp) return;

  const obj = objComp.value as THREE.PerspectiveCamera; // Type cast for lens access
  const controls = orbitComp.controls;

  // Fetch props (returns DEFAULT_DEBUG_CAM_PROPS if no LS data exists)
  const { position, target, enabled, fov, near, far, zoom } = getDebugCamProps(newSceneId);

  // Update Three.js Lens Properties
  obj.position.set(position.x, position.y, position.z);
  obj.fov = fov;
  obj.near = near;
  obj.far = far;
  obj.zoom = zoom;
  obj.updateProjectionMatrix();

  // Update OrbitControls
  controls.target.set(target.x, target.y, target.z);
  controls.enabled = enabled && isSceneInputEnabled;
  controls.update();

  // Sync ECS Transform
  const transform = world.getComponent(debugCamId, ComponentType.TRANSFORM);
  if (transform) {
    transform.position.copy(obj.position);
    transform.quaternion.copy(obj.quaternion);
    transform.setDirty();
    world.commitTransform(debugCamId, transform);
  }

  // Sync ECS Camera Settings (Source of Truth)
  const settings = world.getComponent(debugCamId, ComponentType.CAMERA_SETTINGS);
  if (settings) {
    settings.fov = fov;
    settings.near = near;
    settings.far = far;
    settings.zoom = zoom;
  }
};

export const setLatestAppCameraId = (appId: string) => {
  saveDebugCameraToLS({ latestAppCameraId: appId });
  updateCamerasDebuggerGUI('LIST');
};
