import * as THREE from 'three/webgpu';
import { CoreEntityOpts, ECSWorld, getECSWorld } from './ECS';
import { getCurrentSceneId, getRootScene, registerOnAllSceneEnterings } from './Scene';
import { DebugModuleRef, existsOrThrow, loadDebugModule, useDebug } from '../utils/helpers';
import { ECSSystemStage } from '../../AppECSRegistry';
import { getWindowSize } from '../utils/Window';
import { IS_DEBUG_ENV } from './Config';
import { ComponentType } from './ECS/ECSCoreComponents';

// --- STATE ---
let activeCameraEntityId: number | null = null;
let activeCameraObject: THREE.Camera | null = null;
let debugCameraEntityId: number | null = null;

// We load these at initDebugCamera, because loading them would break the app (these load before loadConfig() in InitApp)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let debugHelpers: DebugModuleRef<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let debugCamera: DebugModuleRef<any> | null = null;

const _m1 = new THREE.Matrix4();
const _v1 = new THREE.Vector3();

// --- PLUGIN ---
ECSWorld.registerPlugin((world) => {
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
  const world = ecsWorld || getECSWorld();
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

  if (props.active || activeCameraEntityId === null) {
    setActiveCamera(entityId);
  }

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

export const setMainCamera = (world: ECSWorld, newMainId: number) => {
  const mainCams = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA);
  for (const oldId of mainCams) {
    world.removeComponent(oldId, ComponentType.TAG_IS_MAIN_CAMERA);
    if (!isDebugCameraActive()) {
      world.setDisabled(oldId, true);
    }
  }
  world.addComponent(newMainId, ComponentType.TAG_IS_MAIN_CAMERA, true);
  if (!isDebugCameraActive()) {
    world.setDisabled(newMainId, false);
    setActiveCamera(newMainId);
  }
};

// --- DEBUG CAMERA ---

export const initDebugCamera = async (world: ECSWorld) => {
  if (debugHelpers) return;

  const camImporter = () => import('./Debug/Camera/DebugCamera');
  debugHelpers = loadDebugModule(() => import('./Debug/Camera/CameraHelpers'));
  debugCamera = loadDebugModule(camImporter);

  if (IS_DEBUG_ENV) {
    registerOnAllSceneEnterings('debugCamEnterSceneLogic', () => {
      const newSceneId = getCurrentSceneId();
      const module = useDebug(debugCamera);
      if (!module || !newSceneId) return;

      // If controls aren't attached yet (e.g. initial boot), attach them now.
      // This ensures the Canvas is ready and the correct Scene ID is used.
      if (
        debugCameraEntityId &&
        !world.hasComponent(debugCameraEntityId, ComponentType.ORBIT_CONTROLS)
      ) {
        module.attachOrbitControls(debugCameraEntityId, world, newSceneId);
      }

      module.debugCamSceneChange(newSceneId, world);
      const props = module.getDebugCamProps(newSceneId);
      toggleDebugCamera(world, props.enabled);
    });

    debugCameraEntityId = createCameraEntity(
      { type: 'PERSPECTIVE', active: false, fov: 60, near: 0.1, far: 2000 },
      { userData: { name: 'DebugOrbitCamera' } },
      world
    );

    world.addComponent(debugCameraEntityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA, true);
    world.addComponent(debugCameraEntityId, ComponentType.PERSISTENT, true);
  }
};

export const toggleDebugCamera = (world: ECSWorld, useDebugCam: boolean) =>
  useDebug(debugCamera)?.toggleDebugCamera(world, useDebugCam, setActiveCamera);

export const isDebugCameraActive = (): boolean => {
  if (activeCameraEntityId === null) return false;
  const world = getECSWorld();
  return world.hasComponent(activeCameraEntityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA);
};

/**
 * Performs a one-time rotation update to make the camera face a specific point.
 */
export const cameraLookAtPoint = (
  entityId: number,
  point: { x: number; y: number; z: number },
  ecsWorld?: ECSWorld
) => {
  const world = ecsWorld || getECSWorld();
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (!transform) return;
  _v1.set(point.x, point.y, point.z);
  _m1.lookAt(transform.position, _v1, THREE.Object3D.DEFAULT_UP);
  transform.quaternion.setFromRotationMatrix(_m1);
  transform.setDirty();
};

// --- SYSTEMS ---

/**
 * Updates all cameras to match the current window dimensions.
 */
// @TODO: Check if this is really needed. This runs unnecessarily on every frame and we could handle this in the resize event.
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

// --- LEGACY CODE --- (@TODO: remove or refactor at some point)

/** * UI BRIDGE: Replaces legacy Camera.ts getAllCameras
 * Queries ECS storage instead of a manual map.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const getAllCameras = (_onlyInScene: boolean = false) => {
  const world = getECSWorld();
  const storage = world.getStorage(ComponentType.TAG_IS_CAMERA);
  const result: { [id: string]: THREE.PerspectiveCamera } = {};

  for (const [entityId] of storage) {
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    const appId = world.getComponent(entityId, ComponentType.APP_ID);

    if (objComp && appId) {
      const cam = objComp.value as THREE.PerspectiveCamera;
      // The UI uses the appId.id as the unique key
      result[appId.id] = cam;
    }
  }
  return result;
};

/** UI BRIDGE: Returns the current camera THREE.js object */
export const getCurrentCamera = () => {
  if (activeCameraEntityId === null) return null;
  return (
    (getECSWorld().getComponent(activeCameraEntityId, ComponentType.OBJECT3D)
      ?.value as THREE.Camera) || null
  );
};

/** UI BRIDGE: Returns the appId of the active camera */
export const getCurrentCameraId = () => {
  if (activeCameraEntityId === null) return null;
  return getECSWorld().getComponent(activeCameraEntityId, ComponentType.APP_ID)?.id || null;
};

/** UI BRIDGE: Sets active camera via appId string */
export const setCurrentCamera = (appId: string) => {
  const world = getECSWorld();
  const ids = world.getStorage(ComponentType.APP_ID);

  for (const [entityId, data] of ids) {
    if (data.id === appId) {
      setActiveCamera(entityId);
      break;
    }
  }
};
