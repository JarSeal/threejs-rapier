import * as THREE from 'three/webgpu';
import { AppComponentData, AppComponentType } from '../../CONFIG';
import {
  CoreComponentData,
  CoreComponentType,
  createPhysicsEntity,
  DebugComponentData,
  DebugComponentType,
  ECSPosition,
  ECSRotation,
  EntityDebugData,
  Transform,
} from './ECS/ECSCoreEntities';
import { existsOrThrow } from '../utils/helpers';
import { ColliderParams, RigidBodyAPI, RigidBodyParams } from './Physics/PhysicsAPITypes';

// --- Union Types of the core components and app components for the World ---
export type ComponentType = CoreComponentType | DebugComponentType | AppComponentType;
export const ComponentType = {
  ...CoreComponentType,
  ...DebugComponentType,
  ...AppComponentType,
};
export type ComponentData = CoreComponentData & DebugComponentData & AppComponentData;

export type CreateEntityOpts = {
  appId?: string;
  enabled?: boolean;
  userData?: Record<string, unknown>;
  debugData?: EntityDebugData;
};

let ecsWorld: ECSWorld;

/** Initializes the ECS World. */
export const initECSWorld = (): ECSWorld => {
  ecsWorld = new ECSWorld();
  return ecsWorld;
};

/** Returns the ECS World or throws an error. */
export const getECSWorld = () =>
  existsOrThrow(ecsWorld, 'ECS World not initialized. Could not get ESC.');

export class ECSWorld {
  private nextEntityId = 0;
  private entities = new Set<number>();

  // Storage: Map<Type, Map<EntityID, Data>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private storages: Map<ComponentType, Map<number, any>> = new Map();

  constructor() {
    // Pre-allocate maps for all defined components
    Object.values(ComponentType).forEach((type) => {
      this.storages.set(type as ComponentType, new Map());
    });
  }

  createRawEntity() {
    const id = this.nextEntityId++;
    this.entities.add(id);
    return id;
  }

  createEntity(opts?: CreateEntityOpts): number {
    const id = this.nextEntityId++;
    this.entities.add(id);
    this.addComponent(id, CoreComponentType.APP_ID, opts?.appId || THREE.MathUtils.generateUUID());
    this.addComponent(id, CoreComponentType.TRANSFORM, new Transform());
    this.addComponent(
      id,
      CoreComponentType.ENABLED,
      opts?.enabled !== undefined ? opts.enabled : true
    );
    this.addComponent(id, CoreComponentType.USER_DATA, opts?.userData || {});
    this.addComponent(id, DebugComponentType.DEBUG_DATA, opts?.debugData || {});
    return id;
  }

  createPhysicsEntity(
    colliderParams: ColliderParams | ColliderParams[],
    rigidBodyParams?: RigidBodyParams,
    mesh?: THREE.Object3D,
    entityOpts?: CreateEntityOpts
  ) {
    return createPhysicsEntity(this, colliderParams, rigidBodyParams, mesh, entityOpts);
  }

  /** Delete an entity. */
  deleteEntity(entityId: number): void {
    // @CHORE: Add option to NOT delete physics object, mesh, geometry, material, textures, and maps
    this.storages.forEach((s) => s.delete(entityId));
    this.entities.delete(entityId);
  }

  addComponent<K extends ComponentType>(entityId: number, type: K, data: ComponentData[K]): void {
    this.storages.get(type)?.set(entityId, data);
    if (type === ComponentType.OBJECT3D) {
      // Add tags for Object3D sub type (mesh, group, light, camera)
      if ('isMesh' in (data as THREE.Object3D)) {
        this.addComponent(entityId, ComponentType.TAG_IS_MESH, true);
      }
      if ('isGroup' in (data as THREE.Object3D)) {
        this.addComponent(entityId, ComponentType.TAG_IS_GROUP, true);
      }
      if ('isLight' in (data as THREE.Object3D)) {
        this.addComponent(entityId, ComponentType.TAG_IS_LIGHT, true);
      }
      if ('isCamera' in (data as THREE.Object3D)) {
        this.addComponent(entityId, ComponentType.TAG_IS_CAMERA, true);
      }
    }
  }

  getComponent<K extends ComponentType>(entityId: number, type: K): ComponentData[K] | undefined {
    return this.storages.get(type)?.get(entityId);
  }

  /** Checks if an entity has a specific component. */
  public hasComponent(entityId: number, type: ComponentType): boolean {
    return this.storages.get(type)?.has(entityId) ?? false;
  }

  /** Direct access to a storage map for high-speed iteration */
  getStorage<K extends ComponentType>(type: K): Map<number, ComponentData[K]> {
    return this.storages.get(type)!;
  }

  /**
   * Internal helper to wipe physical state.
   * Shared by setTransform (teleport) and setEnabled (respawn).
   */
  private _resetBodyState(
    rb: RigidBodyAPI,
    resetVelocity: boolean,
    resetForces: boolean,
    wakeUp: boolean
  ): void {
    if (resetVelocity) {
      rb.setLinvel({ x: 0, y: 0, z: 0 }, wakeUp);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, wakeUp);
    }

    if (resetForces) {
      rb.resetForces(wakeUp);
      rb.resetTorques(wakeUp);
    }
  }

  setTransform(
    entityId: number,
    tra:
      | {
          pos: ECSPosition;
          rot?: ECSRotation;
          resetVelocity?: boolean;
          resetForces?: boolean;
          doNotWakeUp?: boolean;
        }
      | {
          pos?: ECSPosition;
          rot: ECSRotation;
          resetVelocity?: boolean;
          resetForces?: boolean;
          doNotWakeUp?: boolean;
        }
  ): void {
    const { pos, rot, resetVelocity, resetForces, doNotWakeUp } = tra;

    const transform = this.getComponent(entityId, ComponentType.TRANSFORM);
    const rb = this.getRigidBody(entityId);

    // Update Physics (Worker or Main thread)
    if (rb) {
      const wakeUp = !Boolean(doNotWakeUp);

      // Standard move
      if (pos) rb.setTranslation(pos, wakeUp);
      if (rot) rb.setRotation(rot, wakeUp);

      if (this.isEntityDynamic(entityId)) {
        this._resetBodyState(rb, Boolean(resetVelocity), Boolean(resetForces), wakeUp);
      }
    }

    // Update Visuals (Main Thread Cache)
    if (transform) {
      if (pos) transform.position.set(pos.x, pos.y, pos.z);
      if (rot) transform.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      transform.setDirty();
    }
  }

  /**
   * Teleports an entity to a specific location and rotation.
   * Unlike setTransform, this optionally resets velocities to ensure
   * the object doesn't carry old momentum to the new spot.
   */
  public teleport(
    entityId: number,
    tra: { pos: ECSPosition; rot?: ECSRotation } | { pos?: ECSPosition; rot: ECSRotation }
  ): void {
    this.setTransform(entityId, { ...tra, resetVelocity: true, resetForces: true });
  }

  /**
   * Sets the scale of the entity (Visual/mesh only).
   */
  setScale(entityId: number, scale: { x: number; y: number; z: number }): void {
    const transform = this.getComponent(entityId, ComponentType.TRANSFORM);
    if (transform) {
      transform.scale.set(scale.x, scale.y, scale.z);
      transform.setDirty();
    }
  }

  /**
   * Sets Linear and/or Angular velocity.
   * Only affects dynamic/kinematic rigid bodies.
   */
  setVelocity(
    entityId: number,
    linvel?: { x: number; y: number; z: number },
    angvel?: { x: number; y: number; z: number }
  ): void {
    const rb = this.getRigidBody(entityId);

    // Static bodies cannot have velocity; we only act if it's dynamic
    if (rb && this.isEntityDynamic(entityId)) {
      if (linvel) rb.setLinvel(linvel, true);
      if (angvel) rb.setAngvel(angvel, true);
    }
  }

  getPosition(entityId: number): THREE.Vector3 | undefined {
    return this.getComponent(entityId, ComponentType.TRANSFORM)?.position;
  }

  getRotation(entityId: number): THREE.Quaternion | undefined {
    return this.getComponent(entityId, ComponentType.TRANSFORM)?.quaternion;
  }

  getScale(entityId: number): THREE.Vector3 | undefined {
    return this.getComponent(entityId, ComponentType.TRANSFORM)?.scale;
  }

  getTransform(entityId: number): {
    position: THREE.Vector3;
    rotation: THREE.Quaternion;
    scale: THREE.Vector3;
  } {
    const tra = existsOrThrow(
      this.getComponent(entityId, ComponentType.TRANSFORM),
      'TRANSFORM ECS component not found.'
    );
    return { position: tra.position, rotation: tra.quaternion, scale: tra.scale };
  }

  /**
   * Master Switch for an Entity.
   * Coordinates visibility, physics simulation, and future components.
   */
  public setEnabled(
    entityId: number,
    enabled: boolean,
    opts?: {
      onlyPhysics?: boolean;
      onlyMesh?: boolean;
      doNotResetVelocity?: boolean;
      doNotResetForces?: boolean;
      doNotWakeUp?: boolean;
    }
  ): void {
    const onlyPhysics = opts?.onlyPhysics;
    const onlyMesh = opts?.onlyMesh;

    // Update the state component
    this.addComponent(entityId, CoreComponentType.ENABLED, enabled);

    // Handle Physics
    const rb = this.getRigidBody(entityId);
    if (rb && !onlyMesh) {
      const resetVelocity = !Boolean(opts?.doNotResetVelocity);
      const resetForces = !Boolean(opts?.doNotResetForces);
      const wakeUp = !Boolean(opts?.doNotWakeUp);

      rb.setEnabled(enabled);

      if (this.isEntityDynamic(entityId)) {
        this._resetBodyState(rb, Boolean(resetVelocity), Boolean(resetForces), wakeUp);
      }
    }

    // Handle Object3D Visibility
    const mesh = this.getComponent(entityId, ComponentType.OBJECT3D);
    if (mesh && !onlyPhysics) {
      mesh.visible = enabled;
    }

    // Handle Future Components (e.g., Sounds)
    // const sound = this.getComponent(entityId, ComponentType.SOUND_EMITTER);
    // if (sound) { sound.stop(); }
  }

  getRigidBody(entityId: number): RigidBodyAPI | undefined {
    return (
      this.getComponent(entityId, ComponentType.BODY_DYNAMIC_VISUAL) ||
      this.getComponent(entityId, ComponentType.BODY_DYNAMIC_HEADLESS) ||
      this.getComponent(entityId, ComponentType.BODY_STATIC)
    );
  }

  isEntityDynamic(entityId: number): boolean {
    return (
      this.hasComponent(entityId, ComponentType.BODY_DYNAMIC_VISUAL) ||
      this.hasComponent(entityId, ComponentType.BODY_DYNAMIC_HEADLESS)
    );
  }

  /**
   * Returns an iterator for entity IDs. Usage:
   * ```
   * for (const entityId of world.getEntitiesWith(ComponentType.TAG_IS_PLAYER)) {
   *   // Do stuff with entityId
   * }
   * ```
   */
  public getEntitiesWith(type: ComponentType): IterableIterator<number> {
    return this.storages.get(type)!.keys();
  }
}

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
