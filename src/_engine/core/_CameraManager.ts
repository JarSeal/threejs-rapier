import * as THREE from 'three/webgpu';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from './ECS';
import { getCurrentSceneId, getRootScene, registerOnAllSceneEnterings } from './Scene';
import { DebugModuleRef, loadDebugModule, useDebug } from '../utils/helpers';
import { getWindowSize } from '../utils/Window';
import { IS_DEBUG_ENV } from './Config';
import { ComponentType } from './ECS/ECSCoreComponents';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { addResizer } from './MainLoop';
import { inspectEntity, lookAtPoint } from '../utils/ECSHelpers';
import { loadPersistentProps } from './PropertyLoader';
import { CameraProps } from '../schemas/cameraSchema';
import { CoreEntityOpts } from '../schemas/_helperSchemas';
import { existsOrThrow } from '../utils/assert';
import { CoreComponentType } from './ECS/ECSRegistry';
import { lerror } from '../utils/Logger';

// --- STATE ---
let activeCameraEntityId: number | null = null;
let activeCameraObject: THREE.Camera | null = null;
let debugCameraEntityId: number | null = null;

type DebugCameraModule = typeof import('./Debug/Camera/_dbg__DebugCamera');
type CameraHelpersModule = typeof import('./Debug/Camera/_dbg__CameraHelpers');
type CameraGUIModule = typeof import('./Debug/Camera/_dbg__CameraGUI');

export let cameraDebugGUI: DebugModuleRef<CameraGUIModule> | null = null;

let debugHelpers: DebugModuleRef<CameraHelpersModule> | null = null;
let debugCamera: DebugModuleRef<DebugCameraModule> | null = null;

const _m1 = new THREE.Matrix4();
const _v1 = new THREE.Vector3();

export const registerCameraManager = () => {
  addResizer('cameraAspectResizer', updateAllCameraAspectRatios);

  if (IS_DEBUG_ENV) {
    cameraDebugGUI = loadDebugModule(() => import('./Debug/Camera/_dbg__CameraGUI'));

    registerOnAllSceneEnterings('cameraDebugSync', () => {
      const sceneId = getCurrentSceneId();
      if (sceneId) {
        syncCameraHelpersFromLS(sceneId, getECSWorld());
        useDebug(cameraDebugGUI)?.initCameraDebuggerGUI();
      }
    });
  }

  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_CAMERA, {
    onAddComponent: () => useDebug(cameraDebugGUI)?.updateCamerasDebuggerGUI('LIST'),
    onDeleteEntity: (entityId, world) => disposeCamera(entityId, world),
  });
};

export const createCameraEntity = (
  camProps: CameraProps,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): number => {
  const world = ecsWorld || getECSWorld();
  const rootScene = existsOrThrow(getRootScene(), 'No Scene for Camera.');
  const { aspect } = getWindowSize();

  // Load light properties
  const appId = camProps.appId || entityOpts?.appId;
  const props = loadPersistentProps<CameraProps>({ ...camProps, appId }, 'CAMERA');

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

  if (!entityOpts?.doNotAddToScene) {
    rootScene.add(camera);
  }

  const entityId = world.createEntity(entityOpts);
  camera.userData.entityId = entityId;

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

  if (props.active) {
    setMainCamera(world, entityId);
  } else if (activeCameraEntityId === null) {
    setActiveCamera(entityId);
  }

  const pos =
    'position' in props && props.position
      ? props.position
      : { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  camera.position.set(pos.x, pos.y, pos.z);

  if ('position' in props && props.position) {
    world.setTransform(entityId, { pos });
  }

  if ('lookAtPoint' in props && props.lookAtPoint) {
    lookAtPoint(entityId, props.lookAtPoint);
  }

  useDebug(debugHelpers)?.attachCameraHelpers(entityId, camera, world, rootScene);

  return entityId;
};

export const setActiveCamera = (entityId: number) => {
  const world = getECSWorld();
  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (objComp && objComp.value instanceof THREE.Camera) {
    activeCameraEntityId = entityId;
    activeCameraObject = objComp.value; // Cache the direct pointer
    return;
  }
  const msg = `Could not find camera entity with id ${entityId} in setActiveCamera.`;
  lerror(msg);
  throw new Error(msg);
};

export const getActiveCameraId = () => activeCameraEntityId;

export const getActiveCamera = (): THREE.Camera | undefined => activeCameraObject ?? undefined;

export const disposeCamera = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();

  if (activeCameraEntityId === entityId) {
    activeCameraEntityId = null;
    activeCameraObject = null;
  }

  const camera = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  if (!camera) {
    useDebug(cameraDebugGUI)?.updateCamerasDebuggerGUI('LIST');
    return;
  }

  // Purely Three.js / Scene cleanup
  camera.removeFromParent();
  // Note: PerspectiveCamera/OrthographicCamera don't have a .dispose()
  // but if we had custom RenderTargets, we'd kill them here.

  useDebug(cameraDebugGUI)?.updateCamerasDebuggerGUI('LIST');
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

/**
 * Updates all cameras in the ECS storage to match current window dimensions.
 */
export const updateAllCameraAspectRatios = () => {
  const world = getECSWorld();
  const { aspect } = getWindowSize();
  const storage = world.getStorage(ComponentType.CAMERA_SETTINGS);

  for (const [entityId, settings] of storage) {
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (!objComp) continue;

    const cam = objComp.value;

    if (settings.type === 'PERSPECTIVE' && cam instanceof THREE.PerspectiveCamera) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
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

export const getAllCamerasAsArray = () => {
  const world = getECSWorld();
  const storage = world.getStorage(ComponentType.TAG_IS_CAMERA);
  const result: { appId: string; name: string; entityId: number }[] = [];

  for (const [entityId] of storage) {
    // Exclude the debug camera from the list
    if (world.hasComponent(entityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA)) continue;

    const appIdComp = world.getComponent(entityId, ComponentType.APP_ID);
    const debugData = world.getComponent(entityId, ComponentType.DEBUG_DATA);

    if (appIdComp) {
      // Use the Human Readable name, or fallback to the formatted appId
      const name = debugData?.name ? debugData.name : `[appId: ${appIdComp.id}]`;

      result.push({
        appId: appIdComp.id,
        name,
        entityId,
      });
    }
  }
  return result;
};

export const getMainAppCameraId = () => {
  const world = getECSWorld();
  const mainCamEntityId = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA).next().value;

  if (mainCamEntityId !== undefined) {
    return world.getComponent(mainCamEntityId, ComponentType.APP_ID)?.id || null;
  }
  return null;
};

export const getCurrentCamera = () => {
  if (activeCameraEntityId === null) return null;
  return (
    (getECSWorld().getComponent(activeCameraEntityId, ComponentType.OBJECT3D)
      ?.value as THREE.Camera) || null
  );
};

export const getCurrentCameraId = () => {
  if (activeCameraEntityId === null) return null;
  return getECSWorld().getComponent(activeCameraEntityId, ComponentType.APP_ID)?.id || null;
};

export const setMainCamera = (world: ECSWorld, newMainId: number) => {
  const mainCams = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA);
  for (const oldId of mainCams) {
    world.removeComponent(oldId, ComponentType.TAG_IS_MAIN_CAMERA);
  }
  world.addComponent(newMainId, ComponentType.TAG_IS_MAIN_CAMERA, true);
  if (!isDebugCameraActive()) {
    setActiveCamera(newMainId);
  }
};

export const setCurrentCamera = (appId: string) => {
  const world = getECSWorld();
  const ids = world.getStorage(ComponentType.APP_ID);

  for (const [entityId, data] of ids) {
    if (data.id === appId) {
      // Physically disable old cameras and enable the new one
      setMainCamera(world, entityId);
      useDebug(debugCamera)?.setLatestAppCameraId(appId);
      break;
    }
  }
};

// --- DEBUG CAMERA ---

export interface CameraEntityDebugState {
  helperVisible: boolean;
}

/** State for the Debug Orbit Camera specifically */
export interface DebugCamLSProps {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  enabled: boolean;
  latestAppCameraId: string | null;
  fov: number;
  near: number;
  far: number;
  zoom: number;
}

export interface CameraSceneDebugState {
  debugCam: DebugCamLSProps;
  /** Map of fixed appId to entity-specific debug data (replaces cameraHelpers) */
  cams: Record<string, CameraEntityDebugState>;
}

export interface CameraDebugLSData {
  [sceneId: string]: CameraSceneDebugState;
}

const LS_KEY = 'AEK_debugCams';

export const initDebugCamera = async (world: ECSWorld) => {
  if (debugHelpers) return;

  const camImporter = () => import('./Debug/Camera/_dbg__DebugCamera');
  debugHelpers = loadDebugModule(() => import('./Debug/Camera/_dbg__CameraHelpers'));
  debugCamera = loadDebugModule(camImporter);

  if (IS_DEBUG_ENV) {
    registerOnAllSceneEnterings('debugCamEnterSceneLogic', () => {
      const newSceneId = getCurrentSceneId();
      const debugCamModule = useDebug(debugCamera);
      if (!debugCamModule || !newSceneId) return;

      // If controls aren't attached yet (e.g. initial boot), attach them now.
      // This ensures the Canvas is ready and the correct Scene ID is used.
      if (
        debugCameraEntityId &&
        !world.hasComponent(debugCameraEntityId, ComponentType.ORBIT_CONTROLS)
      ) {
        debugCamModule.attachOrbitControls(debugCameraEntityId, world, newSceneId);
      }

      debugCamModule.debugCamSceneChange(newSceneId, world);
      const props = useDebug(cameraDebugGUI)?.getDebugCamProps(newSceneId);

      if (props?.latestAppCameraId) {
        setCurrentCamera(props.latestAppCameraId);
      }

      syncCameraHelpersFromLS(newSceneId, world);

      toggleDebugCamera(world, props?.enabled || false);
    });

    debugCameraEntityId = createCameraEntity(
      { type: 'PERSPECTIVE', active: false, fov: 60, near: 0.1, far: 2000 },
      { userData: { name: 'DebugOrbitCamera' }, persistent: true },
      world
    );

    world.addComponent(debugCameraEntityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA, true);
    world.addComponent(debugCameraEntityId, ComponentType.PERSISTENT, true);

    inspectEntity(debugCameraEntityId);
  }
};

export const toggleDebugCamera = (world: ECSWorld, useDebugCam: boolean) =>
  useDebug(debugCamera)?.toggleDebugCamera(world, useDebugCam, setActiveCamera);

export const isDebugCameraActive = (): boolean => {
  if (activeCameraEntityId === null) return false;
  const world = getECSWorld();
  return world.hasComponent(activeCameraEntityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA);
};

export const isAnyCameraHelperVisible = (): boolean => {
  const world = getECSWorld();
  const storage = world.getStorage(ComponentType.DEBUG_CAMERA_HELPER);
  for (const [entityId, helper] of storage) {
    if (world.hasComponent(entityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA)) continue;
    if (helper.value.visible) return true;
  }
  return false;
};

export const toggleAllCameraHelpers = (show?: boolean) => {
  const world = getECSWorld();
  const sceneId = getCurrentSceneId();
  if (!sceneId) return;

  const storage = world.getStorage(ComponentType.TAG_IS_CAMERA);

  const currentData = lsGetItem(LS_KEY, {}) as CameraDebugLSData;
  if (!currentData[sceneId]) {
    const debugProps = useDebug(cameraDebugGUI)?.getDebugCamProps(sceneId) || {
      enabled: false,
      fov: 60,
      near: 0.1,
      far: 2000,
      position: { x: 3, y: 3, z: 1.5 },
      target: { x: 0, y: 0, z: 0 },
      zoom: 1,
      latestAppCameraId: null,
    };
    if (!debugProps) return;
    currentData[sceneId] = { debugCam: debugProps, cams: {} };
  }
  if (!currentData[sceneId].cams) currentData[sceneId].cams = {};

  const targetState = show !== undefined ? show : !isAnyCameraHelperVisible();

  for (const [entityId] of storage) {
    if (world.hasComponent(entityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA)) continue;

    const helper = world.getComponent(entityId, ComponentType.DEBUG_CAMERA_HELPER);
    const appIdComp = world.getComponent(entityId, ComponentType.APP_ID);

    if (helper && appIdComp) {
      helper.value.visible = targetState;
      if (appIdComp.isFixed) {
        currentData[sceneId].cams[appIdComp.id] = {
          ...currentData[sceneId].cams[appIdComp.id],
          helperVisible: targetState,
        };
      }

      if (targetState) {
        const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
        if (objComp) objComp.value.updateMatrixWorld(true);
        helper.value.update();
      }
    }
  }

  lsSetItem('AEK_debugCams', currentData);
};

export const syncCameraHelpersFromLS = (sceneId: string, world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.DEBUG_CAMERA_HELPER);
  const currentData = lsGetItem(LS_KEY, {}) as CameraDebugLSData;

  for (const [entityId, helper] of storage) {
    if (world.hasComponent(entityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA)) continue;

    const appIdComp = world.getComponent(entityId, ComponentType.APP_ID);
    if (appIdComp && appIdComp.isFixed) {
      const isVisible = Boolean(currentData[sceneId]?.cams[appIdComp.id]?.helperVisible);
      helper.value.visible = isVisible;

      // Force an immediate matrix update so the helper isn't collapsed on the first frame
      if (isVisible) {
        const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
        const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
        if (objComp && transform) {
          objComp.value.position.copy(transform.position);
          objComp.value.quaternion.copy(transform.quaternion);
          objComp.value.updateMatrixWorld(true);
          helper.value.update();
        }
      }
    }
  }
};

export const getCameraByAppId = (appId: string, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  const entityId = getEntityIdByAppId(appId, world);
  let camera: THREE.Camera | undefined = undefined;
  if (entityId) {
    const obj = world.getComponent(entityId, CoreComponentType.OBJECT3D)?.value;
    if (obj && !(obj as THREE.Camera).isCamera) {
      const msg = `Found Object3D is not a camera (type: ${obj.type}).`;
      lerror(msg);
      throw new Error(msg);
    }
    camera = obj as THREE.Camera | undefined;
  }
  return camera;
};
