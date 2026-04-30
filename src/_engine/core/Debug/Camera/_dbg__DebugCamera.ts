import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

import { ECSWorld } from '../../ECS';
import { getCanvasElem } from '../../Renderer';
import { lsGetItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { ECSSystemStage } from '../../../../AppECSRegistry';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import type { CameraDebugLSData, DebugCamLSProps } from '../../_CameraManager';

const DEFAULT_DEBUG_CAM_PROPS: DebugCamLSProps = {
  position: { x: 3, y: 3, z: 1.5 },
  target: { x: 0, y: 0, z: 0 },
  enabled: false,
  latestAppCameraId: null as string | null,
  fov: 60,
  near: 0.001,
  far: 100000,
  zoom: 1,
};

const LS_KEY = 'AEK_debugCams';
const scene = { id: '' };

ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.MAIN, 'debugCameraSystem', debugCameraSystem);
});

export const attachOrbitControls = (entityId: number, world: ECSWorld, sceneId: string) => {
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value as THREE.Camera;
  const canvas = getCanvasElem();

  const controls = new OrbitControls(obj, canvas);

  // --- MEMORIZATION (Load) ---
  const props = getDebugCamProps(sceneId);
  const { position, target, enabled } = props;
  obj.position.set(position.x, position.y, position.z);
  controls.target.set(target.x, target.y, target.z);
  controls.enabled = enabled;
  controls.update();

  scene.id = sceneId;

  controls.addEventListener('end', () => {
    const currentData = lsGetItem(LS_KEY, {});

    currentData[scene.id].debugCam = {
      ...currentData[scene.id].debugCam,
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    };

    lsSetItem(LS_KEY, currentData);
  });

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
    data.controls.enabled = !isDisabled;

    if (isDisabled) continue;

    data.controls.update();

    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);

    if (transform && objComp) {
      transform.position.copy(objComp.value.position);
      transform.quaternion.copy(objComp.value.quaternion);
      transform.setDirty();
      objComp._lastVersion = transform.version;
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
  } else if (!useDebug && gameCam !== undefined) {
    if (debugCam !== undefined) world.setDisabled(debugCam, true);
    setActiveCamera(gameCam);
  }

  // --- Save active state to LocalStorage ---
  if (scene.id) {
    const currentData = lsGetItem(LS_KEY, {}) as CameraDebugLSData;
    if (!currentData[scene.id]) {
      currentData[scene.id] = { debugCam: { ...DEFAULT_DEBUG_CAM_PROPS }, cams: {} };
    }
    currentData[scene.id].debugCam.enabled = useDebug;
    lsSetItem(LS_KEY, currentData);
  }
};

export const toggleOrbitControls = (world: ECSWorld, debugCamId: number, enabled: boolean) => {
  const orbitComp = world.getComponent(debugCamId, ComponentType.ORBIT_CONTROLS);
  const controls = orbitComp?.controls;
  if (!controls) return;
  controls.enabled = enabled;
};

export const getDebugCamProps = (sceneId: string) => {
  const saved = lsGetItem(LS_KEY, {}) as CameraDebugLSData;
  const keys = Object.keys(saved);
  if (!keys.includes(sceneId)) {
    saved[sceneId] = { debugCam: { ...DEFAULT_DEBUG_CAM_PROPS }, cams: {} };
  }
  return saved[sceneId].debugCam || { ...DEFAULT_DEBUG_CAM_PROPS };
};

export const debugCamSceneChange = (newSceneId: string, world: ECSWorld) => {
  const debugCamId = world.getEntitiesWith(ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA).next().value;
  if (debugCamId === undefined) return;

  const objComp = world.getComponent(debugCamId, ComponentType.OBJECT3D);
  const orbitComp = world.getComponent(debugCamId, ComponentType.ORBIT_CONTROLS);
  if (!objComp || !orbitComp) return;

  const obj = objComp.value as THREE.PerspectiveCamera; // Type cast for lens access
  const controls = orbitComp.controls;

  scene.id = newSceneId;

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
  controls.enabled = enabled;
  controls.update();

  // Sync ECS Transform
  const transform = world.getComponent(debugCamId, ComponentType.TRANSFORM);
  if (transform) {
    transform.position.copy(obj.position);
    transform.quaternion.copy(obj.quaternion);
    transform.setDirty();
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

export const setLatestAppCameraId = (sceneId: string, appId: string) => {
  const currentData = lsGetItem(LS_KEY, {}) as CameraDebugLSData;
  if (!currentData[sceneId]) {
    currentData[sceneId] = { debugCam: { ...DEFAULT_DEBUG_CAM_PROPS }, cams: {} };
  }
  currentData[sceneId].debugCam.latestAppCameraId = appId;
  lsSetItem(LS_KEY, currentData);
};
