import * as THREE from 'three/webgpu';
import { CoreEntityOpts, ECSWorld, getECSWorld } from './ECS';
import { getCurrentSceneId, getRootScene, registerOnAllSceneEnterings } from './Scene';
import { DebugModuleRef, existsOrThrow, loadDebugModule, useDebug } from '../utils/helpers';
import { getWindowSize } from '../utils/Window';
import { IS_DEBUG_ENV } from './Config';
import { ComponentType } from './ECS/ECSCoreComponents';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { addResizer } from './MainLoop';
import { inspectEntity } from '../utils/ECSHelpers';
import { createNewCameraSymbol } from '../debug/3DSymbols';

// --- STATE ---
let activeCameraEntityId: number | null = null;
let activeCameraObject: THREE.Camera | null = null;
let debugCameraEntityId: number | null = null;

const CAMERA_SYMBOL_NAME = 'CAMERA_3D_SYMBOL';

type DebugCameraModule = typeof import('./Debug/Camera/_dbg__DebugCamera');
type CameraHelpersModule = typeof import('./Debug/Camera/_dbg__CameraHelpers');

// We load these at initDebugCamera, because loading them would break the app (these load before loadConfig() in InitApp)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let debugHelpers: DebugModuleRef<CameraHelpersModule> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let debugCamera: DebugModuleRef<DebugCameraModule> | null = null;

const _m1 = new THREE.Matrix4();
const _v1 = new THREE.Vector3();

export const registerCameraManager = () => {
  addResizer('cameraAspectResizer', updateAllCameraAspectRatios);

  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_CAMERA, {
    onDeleteEntity: (entityId, world) => {
      if (activeCameraEntityId === entityId) {
        activeCameraEntityId = null;
        activeCameraObject = null;
      }
      const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
      if (objComp) disposeCamera(objComp.value as THREE.Camera);
    },
  });
};

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

  const isDebugCam = world.hasComponent(entityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA);
  if (!isDebugCam) {
    const symbol = createNewCameraSymbol();
    if (symbol) {
      symbol.name = CAMERA_SYMBOL_NAME;
      // Hide initially if this camera is set to active immediately
      symbol.visible = !(props.active || activeCameraEntityId === null);
      camera.add(symbol);
    }
  }

  if (props.active || activeCameraEntityId === null) {
    setActiveCamera(entityId);
  }

  useDebug(debugHelpers)?.attachCameraHelpers(entityId, camera, world, rootScene);

  return entityId;
};

export const setActiveCamera = (entityId: number) => {
  const world = existsOrThrow(getECSWorld(), 'No ECS World for setActiveCamera.');
  if (activeCameraEntityId !== null && activeCameraEntityId !== entityId) {
    const prevObjComp = world.getComponent(activeCameraEntityId, ComponentType.OBJECT3D);
    // If the previous camera was an app camera (not debug), show its symbol again
    if (
      prevObjComp &&
      !world.hasComponent(activeCameraEntityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA)
    ) {
      const prevSymbol = prevObjComp.value.getObjectByName(CAMERA_SYMBOL_NAME);
      if (prevSymbol) prevSymbol.visible = true;
    }
  }
  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (objComp && objComp.value instanceof THREE.Camera) {
    activeCameraEntityId = entityId;
    activeCameraObject = objComp.value; // Cache the direct pointer

    const allCams = world.getStorage(ComponentType.TAG_IS_CAMERA);
    for (const [camId] of allCams) {
      const camObjComp = world.getComponent(camId, ComponentType.OBJECT3D);
      if (!camObjComp) continue;

      const symbol = camObjComp.value.getObjectByName(CAMERA_SYMBOL_NAME);
      if (!symbol) continue;

      // RULE 1: Hide if this is the currently active camera
      // RULE 2: Hide if it's the Debug Camera (handled in creation, but safe to check here)
      const isRenderingNow = camId === entityId;
      const isDebugCam = world.hasComponent(camId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA);

      symbol.visible = !isRenderingNow && !isDebugCam;
    }
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
      // world.setDisabled(oldId, true);
    }
  }
  world.addComponent(newMainId, ComponentType.TAG_IS_MAIN_CAMERA, true);
  if (!isDebugCameraActive()) {
    // world.setDisabled(newMainId, false);
    setActiveCamera(newMainId);
  }
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

export const setCurrentCamera = (appId: string) => {
  const world = getECSWorld();
  const ids = world.getStorage(ComponentType.APP_ID);

  for (const [entityId, data] of ids) {
    if (data.id === appId) {
      // Physically disable old cameras and enable the new one
      setMainCamera(world, entityId);

      if (IS_DEBUG_ENV) {
        const sceneId = getCurrentSceneId();
        if (sceneId) {
          useDebug(debugCamera)?.setLatestAppCameraId(sceneId, appId);
        }
      }

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

      if (props.latestAppCameraId) {
        setCurrentCamera(props.latestAppCameraId);
      }

      syncCameraHelpersFromLS(newSceneId, world);

      toggleDebugCamera(world, props.enabled);
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
    const debugProps = useDebug(debugCamera)?.getDebugCamProps(sceneId) || {
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
