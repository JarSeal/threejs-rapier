/**
 * The camera the view-following debug viewports (the axes gizmo, the environment ball) follow,
 * and the rig they can drive (docs/plans/_DONE_p083_editor-creator-view.md DD7). One resolver for
 * every view:
 * - Runtime view: the active camera; the scene debug camera's rig while it is active.
 * - Editor view: the view's rig camera (`getCameraRig`), or its plain camera (`getCamera`)
 *   when it has no rig, like the main camera in the Runtime view.
 */
import type * as THREE from 'three/webgpu';
import { getECSWorld, getEntityIdByAppId } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { getActiveCamera, isDebugCameraActive } from '../../CameraManager';
import {
  getActiveView,
  getActiveViewCamera,
  isRuntimeViewActive,
  type ViewCameraRig,
} from '../../ViewManager';
import { DEBUG_CAMERA_ID } from '../../../debug/DebugToolsManager';
import { saveDebugCameraToLS } from './_dbg__CameraGUI';
import { setDebugCameraControlsSuspended } from './_dbg__DebugCamera';

/** The scene debug camera's rig, rebuilt only when its OrbitControls change. */
let debugCameraRig: ViewCameraRig | null = null;

const getDebugCameraRig = () => {
  const entityId = getEntityIdByAppId(DEBUG_CAMERA_ID);
  if (entityId === undefined) return null;
  const world = getECSWorld();
  const camera = world.getComponent(entityId, ComponentType.OBJECT3D)?.value as
    | THREE.Camera
    | undefined;
  const controls = world.getComponent(entityId, ComponentType.ORBIT_CONTROLS)?.controls;
  if (!camera || !controls) return null;
  if (debugCameraRig?.controls !== controls || debugCameraRig.camera !== camera) {
    debugCameraRig = {
      camera,
      controls,
      setControlsSuspended: setDebugCameraControlsSuspended,
      // The debug camera's pose is saved per scene (AEK_debugCams)
      onMoveEnd: () =>
        saveDebugCameraToLS({
          position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        }),
    };
  }
  return debugCameraRig;
};

/** Whether the shown camera is a drivable orbit camera: the debug camera in the Runtime view, a
 * view with a rig in an editor view. Cheap enough per frame (no ECS lookups). */
export const isCameraRigActive = () => {
  if (isRuntimeViewActive()) return isDebugCameraActive();
  return Boolean(getActiveView()?.getCameraRig?.());
};

/** The rig debug tools can drive (see {@link isCameraRigActive}), or null. */
export const getActiveCameraRig = (): ViewCameraRig | null => {
  if (isRuntimeViewActive()) return isDebugCameraActive() ? getDebugCameraRig() : null;
  return getActiveView()?.getCameraRig?.() ?? null;
};

/** The camera the view-following viewports follow, or null (eg. during a switch between two
 * editor views, when nothing is rendered). */
export const getViewSourceCamera = (): THREE.Camera | null =>
  isRuntimeViewActive() ? getActiveCamera() ?? null : getActiveViewCamera();
