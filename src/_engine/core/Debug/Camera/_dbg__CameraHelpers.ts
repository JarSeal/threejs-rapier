import * as THREE from 'three/webgpu';
import { ECSWorld } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { ECSSystemStage } from '../../../../AppECSRegistry';

// Register hook to clean up the helper when the camera entity dies
ECSWorld.registerComponentHooks(ComponentType.DEBUG_CAMERA_HELPER, {
  onDeleteEntity: (entityId, world) => {
    const helper = world.getComponent(entityId, ComponentType.DEBUG_CAMERA_HELPER);
    if (helper) {
      helper.value.removeFromParent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((helper.value as any).dispose) (helper.value as any).dispose();
    }
  },
});

ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.LATE_MAIN, 'cameraHelperSyncSystem', (w) => {
    const storage = w.getStorage(ComponentType.DEBUG_CAMERA_HELPER);

    for (const [entityId, helper] of storage) {
      // Only sync if the helper is actually visible
      if (helper.value.visible) {
        const objComp = w.getComponent(entityId, ComponentType.OBJECT3D);
        const transform = w.getComponent(entityId, ComponentType.TRANSFORM);

        if (objComp && transform) {
          /**
           * If the camera is disabled, object3DSyncSystem ignored it.
           * We must manually sync the Three.js object position here
           * so the helper lines are drawn at the correct world coordinates.
           */
          if (w.isDisabled(entityId)) {
            objComp.value.position.copy(transform.position);
            objComp.value.quaternion.copy(transform.quaternion);
            objComp.value.scale.copy(transform.scale);
          }

          // Force matrix update and redraw the helper
          objComp.value.updateMatrixWorld(true);
          helper.value.update();
        }
      }
    }
  });
});

export const attachCameraHelpers = (
  entityId: number,
  camera: THREE.Camera,
  ecsWorld: ECSWorld,
  rootScene: THREE.Scene
) => {
  const helper = new THREE.CameraHelper(camera);

  // Default to false. The _CameraManager's Scene Enter hook will sync the true state.
  helper.visible = false;
  rootScene.add(helper);

  ecsWorld.addComponent(entityId, ComponentType.DEBUG_CAMERA_HELPER, { value: helper });
};
