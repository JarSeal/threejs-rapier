import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

import { ECSWorld } from '../../ECS';
import { getCanvasElem } from '../../Renderer';
import { lsGetItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { ECSSystemStage } from '../../../../AppECSRegistry';
import { ComponentType } from '../../ECS/ECSCoreComponents';

export type DebugCamState = typeof DEFAULT_DEBUG_CAM_PROPS;

type DebugCamLSData = {
  [sceneId: string]: DebugCamState;
};

const DEFAULT_DEBUG_CAM_PROPS = {
  position: { x: 3, y: 3, z: 1.5 },
  target: { x: 0, y: 0, z: 0 },
  enabled: false,
  fov: 60,
  near: 0.001,
  far: 10000,
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

    currentData[scene.id] = {
      ...currentData[scene.id],
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
    if (gameCam !== undefined) world.setDisabled(gameCam, true);
    world.setDisabled(debugCam, false);

    // Fixes the first frame jump
    const orbitData = world.getComponent(debugCam, ComponentType.ORBIT_CONTROLS);
    if (orbitData) orbitData.controls.update();

    setActiveCamera(debugCam);
    if (orbitData) orbitData.controls.update();
  } else if (!useDebug && gameCam !== undefined) {
    if (debugCam !== undefined) world.setDisabled(debugCam, true);
    world.setDisabled(gameCam, false);
    setActiveCamera(gameCam);
  }
};

export const toggleOrbitControls = (world: ECSWorld, debugCamId: number, enabled: boolean) => {
  const orbitComp = world.getComponent(debugCamId, ComponentType.ORBIT_CONTROLS);
  const controls = orbitComp?.controls;
  if (!controls) return;
  controls.enabled = enabled;
};

export const getDebugCamProps = (sceneId: string) => {
  const saved = lsGetItem(LS_KEY, {}) as DebugCamLSData;
  const keys = Object.keys(saved);
  if (!keys.includes(sceneId)) saved[sceneId] = DEFAULT_DEBUG_CAM_PROPS;
  return saved[sceneId] as DebugCamState;
};

export const debugCamSceneChange = (newSceneId: string, world: ECSWorld) => {
  const debugCamId = world.getEntitiesWith(ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA).next().value;
  if (debugCamId === undefined) return;

  const objComp = world.getComponent(debugCamId, ComponentType.OBJECT3D);
  const orbitComp = world.getComponent(debugCamId, ComponentType.ORBIT_CONTROLS);
  if (!objComp || !orbitComp) return;
  const obj = objComp.value as THREE.Camera;
  const controls = orbitComp.controls;

  scene.id = newSceneId;

  const { position, target, enabled } = getDebugCamProps(newSceneId);

  obj.position.set(position.x, position.y, position.z);
  controls.target.set(target.x, target.y, target.z);
  controls.enabled = enabled;
  controls.update();

  const transform = world.getComponent(debugCamId, ComponentType.TRANSFORM);
  if (transform) {
    transform.position.copy(obj.position);
    transform.quaternion.copy(obj.quaternion);
    transform.setDirty();
  }
};
