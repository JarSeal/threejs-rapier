import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from '../../../AppECSRegistry';
import { isAnyLightHelperVisible } from '../LightManager';
import { IS_DEBUG_ENV } from '../Config';
import { ECSWorld } from '../ECS';
import { ComponentType, OBJECT3D_TAGS } from './ECSCoreComponents';
import { CoreComponentType } from './ECSRegistry';

// --- UNIVERSAL VISIBILITY HOOKS ---

/**
 * Single source of truth for Object3D.visible, recomputed from the full
 * three-way AND (docs/plans/_DONE_p081_light-object-culling.md §3.2)
 * whenever any of DISABLED/TAG_FRUSTUM_CULLED/TAG_OBJECT_CULLED changes,
 * instead of each hook fighting over the flag pairwise.
 *
 * `overrides` lets a hook state the value of the flag IT is toggling
 * explicitly, rather than reading it live off `world` — `removeComponent`
 * fires onRemoveComponent hooks before the component is actually deleted
 * (ECS.ts), so e.g. TAG_FRUSTUM_CULLED's own onRemoveComponent would
 * otherwise see `hasComponent(TAG_FRUSTUM_CULLED)` still return `true`.
 */
export function reconcileObject3DVisibility(
  entityId: number,
  world: ECSWorld,
  overrides?: { isDisabled?: boolean; isFrustumCulled?: boolean; isObjectCulled?: boolean }
): void {
  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (!objComp) return;

  const isDisabled = overrides?.isDisabled ?? world.isDisabled(entityId);
  const isFrustumCulled =
    overrides?.isFrustumCulled ?? world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED);
  const isObjectCulled =
    overrides?.isObjectCulled ?? world.hasComponent(entityId, ComponentType.TAG_OBJECT_CULLED);

  objComp.value.visible = !isDisabled && !isFrustumCulled && !isObjectCulled;
}

ECSWorld.registerComponentHooks(ComponentType.DISABLED, {
  onAddComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isDisabled: true });

    // Hide Debug Helpers (Gizmos)
    if (IS_DEBUG_ENV) {
      const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
      if (helper) helper.value.visible = false;
    }

    // Recursively disable possible targets
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink) {
      world.addComponent(targetLink.targetId, ComponentType.DISABLED, true);
    }

    // @TODO: for physics, you need to take these into account as well
  },

  onRemoveComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isDisabled: false });

    if (IS_DEBUG_ENV) {
      const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
      if (helper) {
        helper.value.visible = isAnyLightHelperVisible();
      }
    }

    // Recursively enable possible targets
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink) {
      world.removeComponent(targetLink.targetId, ComponentType.DISABLED);
    }

    // @TODO: for physics, you need to take these into account as well
  },
});

// Register onAddComponent hook for OBJECT3D
ECSWorld.registerComponentHooks(ComponentType.OBJECT3D, {
  onAddComponent: (entityId, world) => {
    const obj3DComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (!obj3DComp) return;
    const obj = obj3DComp.value;
    if (obj) {
      for (const detector of OBJECT3D_TAGS) {
        if (detector.prop in obj) {
          world.addComponent(entityId, detector.tag, true);
        }
      }
      if (obj.userData.isPhysicsObject) {
        world.addComponent(entityId, ComponentType.TAG_IS_PHYSICS_OBJECT, true);
      }
    }
  },
});

// Register PERSISTENT onAddComponent and onRemoveComponent logic for TARGET_LINKs
ECSWorld.registerComponentHooks(ComponentType.PERSISTENT, {
  /** When an entity is marked persistent, ensure its linked target survives as well. */
  onAddComponent: (entityId, world) => {
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink && world.isAlive(targetLink.targetId)) {
      world.addComponent(targetLink.targetId, ComponentType.PERSISTENT, true);
    }
  },
  /** If persistence is removed, the linked target is no longer protected by this parent. */
  onRemoveComponent: (entityId, world) => {
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink && world.isAlive(targetLink.targetId)) {
      world.removeComponent(targetLink.targetId, ComponentType.PERSISTENT);
    }
  },
});
ECSWorld.registerComponentHooks(ComponentType.TARGET_LINK, {
  /** When the TARGET_LINK is added, and if the parent entity is PERSISTENT, ensure the target entity is also. */
  onAddComponent: (entityId, world) => {
    // If the looker is already persistent, make the new target persistent immediately
    if (world.hasComponent(entityId, ComponentType.PERSISTENT)) {
      const link = world.getComponent(entityId, ComponentType.TARGET_LINK);
      if (link) world.addComponent(link.targetId, ComponentType.PERSISTENT, true);
    }
  },
});

// --- PLUGIN REGISTRATION ---
// registerCorePlugin (not registerPlugin): these are universal engine
// plumbing every world needs to function — without object3DSyncSystem in
// particular, a world's ECS Transform updates never reach its Object3Ds.
// A world opting out via `applyGlobalPlugins: false` should only skip
// app/feature systems (e.g. light frustum culling), not this.

ECSWorld.registerCorePlugin((world) => {
  // This is the object3D (meshes, lights, cameras, groups) syncSystem
  world.addSystem(ECSSystemStage.MAIN, 'object3DSyncSystem', object3DSyncSystem);

  // Lifetime system usually runs at the end of the frame to clean up
  // entities that expired during the logic step (hence stage is LATE_MAIN).
  world.addSystem(ECSSystemStage.LATE_MAIN, 'entityLifetimeSystem', entityLifetimeSystem);

  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'lookAtSystem',
    lookAtSystem,
    APP_RENDER_SYNC_ORDER.POSE_PRODUCERS
  );

  return world;
});

// --- SYSTEMS ---

/**
 * Unified system that syncs ECS Transforms to Three.js Object3Ds.
 * Handles Meshes, Cameras, Groups, and Lights automatically.
 */
export function object3DSyncSystem(world: ECSWorld) {
  const storage = world.getStorage(ComponentType.OBJECT3D);
  const transformStore = world.getTypedTransformStore();

  if (transformStore) {
    for (const [entityId, objComp] of storage) {
      if (world.isDisabled(entityId)) continue;

      const slot = transformStore.getSlot(entityId);
      if (slot === -1) continue;

      if (transformStore.isDirty(slot)) {
        transformStore.copyToObject3D(slot, objComp.value);
        transformStore.clearDirty(slot);
      }
    }
    return;
  }

  for (const [entityId, objComp] of storage) {
    // Skip if disabled
    if (world.isDisabled(entityId)) continue;

    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) continue;

    // Only update if the Transform version has changed
    if (objComp._lastVersion !== transform.version) {
      objComp.value.position.copy(transform.position);
      objComp.value.quaternion.copy(transform.quaternion);
      objComp.value.scale.copy(transform.scale);

      // Cache the version we just synced
      objComp._lastVersion = transform.version;
    }
  }
}

/**
 * Processes all entities with a LIFETIME component.
 * Decrements timers and removes entities that expire.
 */
export const entityLifetimeSystem = (world: ECSWorld, dt: number) => {
  // We use getStorage for high-speed iteration
  const storage = world.getStorage(CoreComponentType.LIFETIME);

  // Note: We iterate over the keys to avoid issues when removing
  // entities while looping (though Map.forEach is generally safe in JS)
  for (const [entityId, data] of storage) {
    data.remaining -= dt;

    if (data.remaining <= 0) {
      // Delete the entity
      world.deleteEntity(entityId);
    }
  }
};

/**
 * Any entity with a TARGET_LINK and an OBJECT3D will
 * orient itself to face its target's current world position.
 */
export const lookAtSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.TARGET_LINK);
  const transformStore = world.getTypedTransformStore();

  for (const [entityId, link] of storage) {
    // Check if the target entity still exists
    if (!world.isAlive(link.targetId)) continue;
    // Check if the entity is disabled
    if (world.isDisabled(entityId)) continue;

    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (!objComp) continue;

    if (transformStore) {
      const slot = transformStore.getSlot(entityId);
      const targetSlot = transformStore.getSlot(link.targetId);
      if (slot === -1 || targetSlot === -1) continue;

      objComp.value.lookAt(
        transformStore.posX[targetSlot],
        transformStore.posY[targetSlot],
        transformStore.posZ[targetSlot]
      );
      transformStore.setQuaternionFromObject3D(slot, objComp.value);
      continue;
    }

    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    const targetTransform = world.getComponent(link.targetId, ComponentType.TRANSFORM);

    if (transform && targetTransform) {
      objComp.value.lookAt(targetTransform.position);
      transform.quaternion.copy(objComp.value.quaternion);
      transform.setDirty();
      objComp._lastVersion = transform.version;
    }
  }
};
