import { ComponentType, ECSWorld } from '../ECS';
import { CoreComponentType } from './ECSCoreEntities';

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
 * Update Mesh from Transform.
 * Optimized with version check (dirty flags).
 */
export const transformToMeshSystem = (world: ECSWorld) => {
  const meshes = world.getStorage(ComponentType.OBJECT3D);

  meshes.forEach((mesh, entityId) => {
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) return;

    // Optimization: Only copy if the transform has actually changed
    // We use THREE.Object3D.userData to track the last synced version
    if (mesh.userData._lastVersion !== transform.version) {
      mesh.position.copy(transform.position);
      mesh.quaternion.copy(transform.quaternion);
      mesh.scale.copy(transform.scale);

      mesh.userData._lastVersion = transform.version;
    }
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
