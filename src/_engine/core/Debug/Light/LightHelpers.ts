import * as THREE from 'three/webgpu';

import { ECSWorld } from '../../ECS';
import { ComponentType } from '../../ECS/ECSRegistry';

ECSWorld.registerComponentHooks(ComponentType.DEBUG_LIGHT_HELPER, {
  onDeleteEntity: (entityId, world) => {
    const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
    if (helper) {
      helper.value.removeFromParent();
      // Helpers often have internal geometries/materials to dispose
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((helper.value as any).dispose) (helper.value as any).dispose();
    }
  },
});

/**
 * Creates and attaches visual gizmos to light entities.
 * This file is dynamically imported only in Debug mode.
 */
export const attachLightHelpers = (
  entityId: number,
  light:
    | THREE.AmbientLight
    | THREE.HemisphereLight
    | THREE.PointLight
    | THREE.DirectionalLight
    | THREE.SpotLight,
  ecsWorld: ECSWorld,
  rootScene: THREE.Scene
) => {
  // These light types don't have helpers
  if (light instanceof THREE.AmbientLight || light instanceof THREE.HemisphereLight) return;

  let helper:
    | THREE.PointLightHelper
    | THREE.DirectionalLightHelper
    | THREE.SpotLightHelper
    | undefined;

  if (light instanceof THREE.DirectionalLight) {
    helper = new THREE.DirectionalLightHelper(light, 5);
  } else if (light instanceof THREE.PointLight) {
    helper = new THREE.PointLightHelper(light, 1);
  } else if (light instanceof THREE.SpotLight) {
    helper = new THREE.SpotLightHelper(light);
  }

  if (helper) {
    rootScene.add(helper);
    // Store the helper so we can toggle or dispose it later
    ecsWorld.addComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER, { value: helper });

    // Optional: If it's a shadow-casting light, add the CameraHelper too
    if (light.castShadow) {
      const camHelper = new THREE.CameraHelper(light.shadow.camera);
      rootScene.add(camHelper);
      // We can store multiple helpers in an array or a child of the main helper
      helper.add(camHelper);
    }
  }
};
