import * as THREE from 'three/webgpu';

import { ECSWorld } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { ECSSystemStage } from '../../../../AppECSRegistry';
import { existsOrThrow } from '../../../utils/helpers';
import { getRootScene } from '../../Scene';
import { isAnyLightHelperVisible } from '../../_LightManager';

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

ECSWorld.registerPlugin((world) => {
  const rootScene = existsOrThrow(getRootScene(), 'No root scene');

  const lightStorage = world.getStorage(ComponentType.TAG_IS_LIGHT);
  for (const [entityId] of lightStorage) {
    if (!world.hasComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER)) {
      const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
      if (objComp?.value instanceof THREE.Light) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attachLightHelpers(entityId, objComp.value as any, world, rootScene);
      }
    }
  }

  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_LIGHT, {
    onAddComponent: (entityId, w) => {
      if (!w.hasComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER)) {
        const objComp = w.getComponent(entityId, ComponentType.OBJECT3D);
        if (objComp?.value instanceof THREE.Light) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          attachLightHelpers(entityId, objComp.value as any, w, rootScene);
        }
      }
    },
  });

  world.addSystem(ECSSystemStage.LATE_MAIN, 'lightHelperSyncSystem', (w) => {
    const storage = w.getStorage(ComponentType.DEBUG_LIGHT_HELPER);
    for (const [entityId, helper] of storage) {
      if (helper.value.visible) {
        const objComp = w.getComponent(entityId, ComponentType.OBJECT3D);
        const transform = w.getComponent(entityId, ComponentType.TRANSFORM);

        if (objComp && transform) {
          // Bridge the disabled gap
          if (w.isDisabled(entityId)) {
            objComp.value.position.copy(transform.position);
            objComp.value.quaternion.copy(transform.quaternion);
            objComp.value.scale.copy(transform.scale);
          }
          objComp.value.updateMatrixWorld(true);
          if ('update' in helper.value) helper.value.update();
        }
      }
    }
  });
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
    const isEnabled = !ecsWorld.getComponent(entityId, ComponentType.DISABLED);
    const obj = ecsWorld.getComponent(entityId, ComponentType.OBJECT3D)?.value;
    const isVisible = !isEnabled && Boolean(obj?.visible);
    helper.visible = isVisible && isAnyLightHelperVisible();

    rootScene.add(helper);

    let camHelper: THREE.CameraHelper | undefined;
    if ('castShadow' in light) {
      camHelper = new THREE.CameraHelper(light.shadow.camera);
      rootScene.add(camHelper);
      if (!light.castShadow || !isEnabled) camHelper.visible = false;
    }

    ecsWorld.addComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER, { value: helper, camHelper });
  }
};
