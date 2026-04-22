import * as THREE from 'three/webgpu';
import { ECSWorld } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';

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

export const attachCameraHelpers = (
  entityId: number,
  camera: THREE.Camera,
  ecsWorld: ECSWorld,
  rootScene: THREE.Scene
) => {
  const helper = new THREE.CameraHelper(camera);
  rootScene.add(helper);

  ecsWorld.addComponent(entityId, ComponentType.DEBUG_CAMERA_HELPER, { value: helper });
};
