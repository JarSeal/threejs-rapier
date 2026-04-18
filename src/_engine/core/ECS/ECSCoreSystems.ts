import { ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld } from '../ECS';
import { ComponentType } from './ECSCoreEntities';
import { CoreComponentType } from './ECSRegistry';

// --- UNIVERSAL VISIBILITY HOOKS ---

ECSWorld.registerComponentHooks(ComponentType.DISABLED, {
  onAddComponent: (entityId, world) => {
    // Hide Object3Ds
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (objComp) objComp.value.visible = false;

    // Recursively disable possible targets
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink) {
      world.addComponent(targetLink.targetId, ComponentType.DISABLED, true);
    }

    // @TODO: for physics, you need to take these into account as well
  },

  onRemoveComponent: (entityId, world) => {
    // Show Object3Ds
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (objComp) objComp.value.visible = true;

    // Recursively enable possible targets
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink) {
      world.removeComponent(targetLink.targetId, ComponentType.DISABLED);
    }

    // @TODO: for physics, you need to take these into account as well
  },
});

// --- PLUGIN REGISTRATION ---

ECSWorld.registerPlugin((world) => {
  // Lifetime system usually runs at the end of the frame to clean up
  // entities that expired during the logic step (hence stage is LATE_MAIN).
  world.addSystem(ECSSystemStage.LATE_MAIN, 'entityLifetimeSystem', entityLifetimeSystem);

  world.addSystem(ECSSystemStage.APP_RENDER_SYNC, 'lookAtSystem', lookAtSystem);

  // @CHORE: register this system in the PhysicsAPI
  world.addSystem(
    ECSSystemStage.APP_POST_PHYSICS,
    'physicsToTransformSystem',
    physicsToTransformSystem
  );

  return world;
});

// --- SYSTEMS ---

// @CHORE: Move this to PhysicsAPI and create initPhysicsToTransformSystem (follow mesh system pattern)
/**
 * Update transform from physics
 */
export const physicsToTransformSystem = (world: ECSWorld) => {
  // We ONLY iterate over entities that are dynamic and have visuals
  const dynamicVisuals = world.getStorage(ComponentType.BODY_DYNAMIC_VISUAL);

  dynamicVisuals.forEach((rb, entityId) => {
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) return;

    // Direct SAB access from your Physics Proxy
    transform.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
    transform.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);

    // Mark as changed so the Render System knows to update the Mesh
    transform.setDirty();
  });
};

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
 * Global Law: Any entity with a TARGET_LINK and an OBJECT3D will
 * orient itself to face its target's current world position.
 */
export const lookAtSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.TARGET_LINK);

  for (const [entityId, link] of storage) {
    if (world.isDisabled(entityId)) continue;

    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    const targetTransform = world.getComponent(link.targetId, ComponentType.TRANSFORM);

    if (objComp && targetTransform) {
      // Three.js Objects (Meshes, Cameras, Groups)
      // We use the raw .lookAt method.
      // Note: DirectionalLights usually use their internal .target property,
      // but calling .lookAt on the light source itself doesn't hurt.
      objComp.value.lookAt(targetTransform.position);
    }
  }
};
