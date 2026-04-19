import * as THREE from 'three/webgpu';
import { CoreEntityOpts, ECSWorld, getECSWorld } from './ECS';
import { getRootScene } from './Scene';
import { existsOrThrow, loadDebugModule, useDebug } from '../utils/helpers';
import { ComponentType } from './ECS/ECSRegistry';
import { ECSSystemStage } from '../../AppECSRegistry';
import { getWindowSize } from '../utils/Window';

// --- STATE ---
let activeCameraEntityId: number | null = null;
let activeCameraObject: THREE.Camera | null = null;
const debugHelpers = loadDebugModule(() => import('./Debug/Camera/CameraHelpers'));

// --- PLUGIN ---
ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.APP_RENDER_SYNC, 'cameraSyncSystem', cameraSyncSystem);
  // Resize runs in MAIN because it modifies camera matrices before the frame starts
  world.addSystem(ECSSystemStage.MAIN, 'cameraResizeSystem', cameraResizeSystem);
});

ECSWorld.registerComponentHooks(ComponentType.TAG_IS_CAMERA, {
  onDeleteEntity: (entityId, world) => {
    if (activeCameraEntityId === entityId) {
      activeCameraEntityId = null;
      activeCameraObject = null;
    }

    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (objComp) {
      disposeCamera(objComp.value as THREE.Camera);
    }
  },
});

export type CameraProps = {
  active?: boolean;
  near?: number;
  far?: number;
  zoom?: number;
} & ({ type: 'PERSPECTIVE'; fov?: number } | { type: 'ORTHOGRAPHIC'; frustumSize?: number });

export const createCameraEntity = (
  props: CameraProps,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): number => {
  const world = ecsWorld || existsOrThrow(getECSWorld(), 'No ECS World for Camera.');
  const rootScene = existsOrThrow(getRootScene(), 'No Scene for Camera.');
  const { aspect } = getWindowSize();

  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  if (props.type === 'PERSPECTIVE') {
    camera = new THREE.PerspectiveCamera(
      props.fov ?? 45,
      aspect,
      props.near ?? 0.1,
      props.far ?? 2000
    );
  } else {
    // Ortho bounds are calculated based on aspect ratio in the resize system
    const s = props.frustumSize ?? 10;
    camera = new THREE.OrthographicCamera(
      (-s * aspect) / 2,
      (s * aspect) / 2,
      s / 2,
      -s / 2,
      props.near ?? 0.1,
      props.far ?? 2000
    );
  }

  camera.zoom = props.zoom ?? 1;
  rootScene.add(camera);

  const entityId = world.createEntity(entityOpts);

  // 1. Add Components
  world.addComponent(entityId, ComponentType.TAG_IS_CAMERA, true);
  world.addComponent(entityId, ComponentType.OBJECT3D, { value: camera, _lastVersion: -1 });
  world.addComponent(entityId, ComponentType.CAMERA_SETTINGS, {
    type: props.type,
    fov: props.type === 'PERSPECTIVE' ? props.fov ?? 45 : 0,
    near: props.near ?? 0.1,
    far: props.far ?? 2000,
    zoom: props.zoom ?? 1,
    frustumSize: props.type === 'ORTHOGRAPHIC' ? props.frustumSize ?? 10 : 0,
  });

  // 2. Handle Active State
  if (props.active || activeCameraEntityId === null) {
    setActiveCamera(entityId);
  }

  // 3. Debug Helpers
  useDebug(debugHelpers)?.attachCameraHelpers(entityId, camera, world, rootScene);

  return entityId;
};

export const setActiveCamera = (entityId: number) => {
  const world = existsOrThrow(getECSWorld(), 'No ECS World for setActiveCamera.');
  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (objComp && objComp.value instanceof THREE.Camera) {
    activeCameraEntityId = entityId;
    activeCameraObject = objComp.value; // Cache the direct pointer
  }
};

export const getActiveCameraId = () => activeCameraEntityId;

export const getActiveCamera = (): THREE.Camera | undefined => activeCameraObject ?? undefined;

export const disposeCamera = (camera: THREE.Camera) => {
  // Purely Three.js / Scene cleanup
  camera.removeFromParent();
  // Note: PerspectiveCamera/OrthographicCamera don't have a .dispose()
  // but if we had custom RenderTargets, we'd kill them here.
};

// --- SYSTEMS ---

/**
 * Updates all cameras to match the current window dimensions.
 */
export const cameraResizeSystem = (world: ECSWorld) => {
  const { aspect } = getWindowSize();
  const storage = world.getStorage(ComponentType.CAMERA_SETTINGS);

  for (const [entityId, settings] of storage) {
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (!objComp) continue;

    const cam = objComp.value;

    if (settings.type === 'PERSPECTIVE' && cam instanceof THREE.PerspectiveCamera) {
      if (cam.aspect !== aspect) {
        cam.aspect = aspect;
        cam.updateProjectionMatrix();
      }
    } else if (settings.type === 'ORTHOGRAPHIC' && cam instanceof THREE.OrthographicCamera) {
      const s = settings.frustumSize;
      cam.left = (-s * aspect) / 2;
      cam.right = (s * aspect) / 2;
      cam.top = s / 2;
      cam.bottom = -s / 2;
      cam.updateProjectionMatrix();
    }
  }
};

/**
 * Syncs the Three.js Camera position/rotation with the ECS Transform.
 */
export const cameraSyncSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.OBJECT3D);
  for (const [entityId, objComp] of storage) {
    if (!world.hasComponent(entityId, ComponentType.TAG_IS_CAMERA)) continue;
    if (world.isDisabled(entityId)) continue;

    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (transform && objComp._lastVersion !== transform.version) {
      objComp.value.position.copy(transform.position);
      objComp.value.quaternion.copy(transform.quaternion);
      objComp.value.scale.copy(transform.scale);
      objComp._lastVersion = transform.version;
    }
  }
};
