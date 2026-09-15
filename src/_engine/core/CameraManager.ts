import * as THREE from 'three/webgpu';
import { ECSWorld, getAllECSWorlds, getECSWorld, getEntityIdByAppId } from './ECS';
import { getCurrentSceneId, getRootScene, registerOnAllSceneEnterings } from './Scene';
import { DebugModuleRef, loadDebugModule, useDebug } from '../utils/helpers';
import { getWindowSize } from '../utils/Window';
import { IS_DEBUG_ENV } from './Config';
import { ComponentType, CoreComponentData } from './ECS/ECSCoreComponents';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { addResizer } from './MainLoop';
import { inspectEntity, lookAtPoint } from '../utils/ECSHelpers';
import { loadPersistentProps } from './PropertyLoader';
import { CameraProps } from '../schemas/cameraSchema';
import { CoreEntityOpts } from '../schemas/_helperSchemas';
import { existsOrThrow } from '../utils/assert';
import { CoreComponentType } from './ECS/ECSRegistry';
import { DEBUG_CAMERA_ID } from '../debug/DebugToolsManager';
import { lerror } from '../utils/Logger';
import { updateDraggableWindow } from './UI/DraggableWindow';

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
      }
    });
  }

  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_CAMERA, {
    onAddComponent: () => useDebug(cameraDebugGUI)?.updateCamerasDebuggerGUI('LIST'),
    onDeleteEntity: (entityId, world) => disposeCamera(entityId, world),
  });
};

/** Matches the debug GUI's fov slider bounds — keeps computed FOV out of degenerate territory. */
const clampFov = (fov: number) => THREE.MathUtils.clamp(fov, 1, 170);

/**
 * "Hor+" aspect compensation: `baseFovDeg` is the vertical FOV authored for `referenceAspect`.
 * Returns the vertical FOV that keeps the *horizontal* FOV constant at `currentAspect` instead —
 * widens on narrow/portrait screens, narrows on wide/desktop screens.
 */
export const computeResponsiveFov = (
  baseFovDeg: number,
  referenceAspect: number,
  currentAspect: number
): number => {
  if (!Number.isFinite(referenceAspect) || referenceAspect <= 0) referenceAspect = 16 / 9;
  if (!Number.isFinite(currentAspect) || currentAspect <= 0) return clampFov(baseFovDeg);

  const halfVFovRef = THREE.MathUtils.degToRad(baseFovDeg) / 2;
  const halfHFovAtRef = Math.atan(Math.tan(halfVFovRef) * referenceAspect);
  const newHalfVFov = Math.atan(Math.tan(halfHFovAtRef) / currentAspect);
  return clampFov(THREE.MathUtils.radToDeg(newHalfVFov * 2));
};

/**
 * Orthographic equivalent of {@link computeResponsiveFov}: `baseFrustumSize` is the vertical
 * world-space extent authored for `referenceAspect`. Returns the vertical extent that keeps the
 * horizontal world-space width constant at `currentAspect` instead.
 */
export const computeResponsiveFrustumSize = (
  baseFrustumSize: number,
  referenceAspect: number,
  currentAspect: number
): number => {
  if (!Number.isFinite(referenceAspect) || referenceAspect <= 0) referenceAspect = 16 / 9;
  if (!Number.isFinite(currentAspect) || currentAspect <= 0) return baseFrustumSize;

  const targetWidth = baseFrustumSize * referenceAspect;
  return targetWidth / currentAspect;
};

/**
 * Applies `aspect` to a camera's projection, deriving the effective fov/frustumSize from
 * `settings.responsiveAspect` when enabled. Single source of truth shared by camera creation
 * and the window-resize system — `settings.fov`/`settings.frustumSize` are always treated as
 * the immutable authored base value; only the live THREE.js object is ever mutated here.
 */
export const applyCameraProjection = (
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  settings: CoreComponentData[CoreComponentType.CAMERA_SETTINGS],
  aspect: number
) => {
  if (settings.type === 'PERSPECTIVE' && cam instanceof THREE.PerspectiveCamera) {
    cam.aspect = aspect;
    cam.fov = settings.responsiveAspect
      ? computeResponsiveFov(settings.fov, settings.referenceAspect, aspect)
      : settings.fov;
    cam.updateProjectionMatrix();
  } else if (settings.type === 'ORTHOGRAPHIC' && cam instanceof THREE.OrthographicCamera) {
    const s = settings.responsiveAspect
      ? computeResponsiveFrustumSize(settings.frustumSize, settings.referenceAspect, aspect)
      : settings.frustumSize;
    cam.left = (-s * aspect) / 2;
    cam.right = (s * aspect) / 2;
    cam.top = s / 2;
    cam.bottom = -s / 2;
    cam.updateProjectionMatrix();
  }
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

  const settings: CoreComponentData[CoreComponentType.CAMERA_SETTINGS] = {
    type: props.type,
    fov: props.type === 'PERSPECTIVE' ? props.fov ?? 45 : 0,
    near: props.near ?? 0.1,
    far: props.far ?? 2000,
    zoom: props.zoom ?? 1,
    frustumSize: props.type === 'ORTHOGRAPHIC' ? props.frustumSize ?? 10 : 0,
    responsiveAspect: props.responsiveAspect ?? false,
    referenceAspect: props.referenceAspect ?? 16 / 9,
  };

  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  if (settings.type === 'PERSPECTIVE') {
    camera = new THREE.PerspectiveCamera(settings.fov, aspect, settings.near, settings.far);
  } else {
    // Placeholder bounds — applyCameraProjection() below sets the real ones before first render.
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, settings.near, settings.far);
  }
  applyCameraProjection(camera, settings, aspect);

  camera.zoom = settings.zoom;

  if (!entityOpts?.doNotAddToScene) {
    rootScene.add(camera);
  }

  const entityId = world.createEntity(entityOpts);
  camera.userData.entityId = entityId;

  world.addComponent(entityId, ComponentType.TAG_IS_CAMERA, true);
  world.addComponent(entityId, ComponentType.OBJECT3D, { value: camera, _lastVersion: -1 });
  world.addComponent(entityId, ComponentType.CAMERA_SETTINGS, settings);

  if (props.active) {
    setMainCamera(world, entityId);
  } else if (activeCameraEntityId === null) {
    // Route through setMainCamera (not setActiveCamera directly) so this camera is
    // also tagged TAG_IS_MAIN_CAMERA — otherwise a scene whose designated camera relies
    // on "first camera created" rather than an explicit `active: true` would never get
    // that tag, and getMainCamera() below would find nothing for it.
    setMainCamera(world, entityId);
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
    lookAtPoint(entityId, props.lookAtPoint, world);
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

/**
 * Returns the real gameplay camera's Three.js object, regardless of whether the debug
 * fly-camera is currently active. Unlike `getActiveCamera()` (which resolves to the debug
 * camera while it's toggled on — required for `renderScene()` to render through it), this
 * always resolves via `TAG_IS_MAIN_CAMERA`, which `toggleDebugCamera` never touches.
 * Use this, not `getActiveCamera()`, for any system whose behavior must track the actual
 * gameplay camera's point of view (e.g. light frustum culling).
 */
export const getMainCamera = (): THREE.Camera | undefined => {
  const world = getECSWorld();
  const mainCamId = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA).next().value;
  if (mainCamId === undefined) return undefined;
  return world.getComponent(mainCamId, ComponentType.OBJECT3D)?.value as THREE.Camera | undefined;
};

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
  world.commitTransform(entityId, transform);
};

/**
 * Updates all cameras, in every ECS world, to match current window dimensions.
 */
export const updateAllCameraAspectRatios = () => {
  const { aspect } = getWindowSize();

  for (const world of getAllECSWorlds()) {
    const storage = world.getStorage(ComponentType.CAMERA_SETTINGS);

    for (const [entityId, settings] of storage) {
      const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
      if (!objComp) continue;

      applyCameraProjection(
        objComp.value as THREE.PerspectiveCamera | THREE.OrthographicCamera,
        settings,
        aspect
      );
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
      useDebug(cameraDebugGUI)?.initCameraDebuggerGUI();

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
      { appId: DEBUG_CAMERA_ID, userData: { name: 'DebugOrbitCamera' }, persistent: true },
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

  lsSetItem(LS_KEY, currentData);

  const debugModule = useDebug(cameraDebugGUI);
  if (debugModule) updateDraggableWindow(debugModule.EDIT_CAMERA_WIN_ID);
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
