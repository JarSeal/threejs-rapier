import * as THREE from 'three/webgpu';
import { AppComponentData, AppComponentType } from '../../CONFIG';
import {
  CoreComponentData,
  CoreComponentType,
  DebugComponentData,
  DebugComponentType,
  ECSPosition,
  ECSRotation,
  EntityDebugData,
  Transform,
} from './ECS/ECSCoreEntities';
import { existsOrThrow } from '../utils/helpers';
import { RigidBodyAPI } from './Physics/PhysicsAPITypes';
import { entityLifetimeSystem, physicsToTransformSystem } from './ECS/ECSCoreSystems';
import { isDebugEnvironment } from './Config';
import { initMeshSystem } from './_Mesh';

/** Stages of ECS system invocation */
export enum ECSSystemStage {
  // --- Runs in updateMainLoop (Always runs if MasterPlay is true) ---
  MAIN = 'MAIN',

  // --- Runs in updateAppLoop (Only if AppPlay is true) ---
  APP_PRE_PHYSICS = 'APP_PRE_PHYSICS', // Input handling, logic before physics
  APP_POST_PHYSICS = 'APP_POST_PHYSICS', // physicsToTransform (Syncing SAB to ECS)
  APP_LOGIC = 'APP_LOGIC', // Standard gameplay systems
  APP_RENDER_SYNC = 'APP_RENDER_SYNC', // transformToMesh (Syncing ECS to Three.js)

  // --- Runs in updateLateMainLoop (After rendering) ---
  LATE_MAIN = 'LATE_MAIN',
}

export type ECSSystem = (world: ECSWorld, dt: number) => void;

// --- Union Types of the core components and app components for the World ---
export type ComponentType = CoreComponentType | DebugComponentType | AppComponentType;
export const ComponentType = {
  ...CoreComponentType,
  ...DebugComponentType,
  ...AppComponentType,
};
export type ComponentData = CoreComponentData & DebugComponentData & AppComponentData;

export type CoreEntityOpts = {
  appId?: string;
  disabled?: boolean;
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

  private systems: Map<ECSSystemStage, { id: string; fn: ECSSystem }[]> = new Map();

  constructor() {
    // Pre-allocate system stage orders
    Object.values(ECSSystemStage).forEach((s) => this.systems.set(s, []));

    // Add core systems
    initMeshSystem(this);
    this.addSystem(ECSSystemStage.LATE_MAIN, 'entityLifetimeSystem', entityLifetimeSystem);
    // @CHORE: follow mesh system pattern
    this.addSystem(
      ECSSystemStage.APP_POST_PHYSICS,
      'physicsToTransformSystem',
      physicsToTransformSystem
    );

    // Pre-allocate maps for all defined components
    Object.values(ComponentType).forEach((type) => {
      this.storages.set(type, new Map());
    });
  }

  public addSystem(stage: ECSSystemStage, id: string, fn: ECSSystem) {
    this.systems.get(stage)?.push({ id, fn });
  }

  public removeSystem(id: string) {
    this.systems.forEach((list, stage) => {
      this.systems.set(
        stage,
        list.filter((s) => s.id !== id)
      );
    });
  }

  createRawEntity() {
    const id = this.nextEntityId++;
    this.entities.add(id);
    return id;
  }

  createEntity(opts?: CoreEntityOpts): number {
    const id = this.nextEntityId++;
    this.entities.add(id);
    this.addComponent(id, CoreComponentType.APP_ID, {
      id: opts?.appId || THREE.MathUtils.generateUUID(),
      isFixed: Boolean(opts?.appId),
    });
    this.addComponent(id, CoreComponentType.TRANSFORM, new Transform());
    this.addComponent(id, CoreComponentType.USER_DATA, opts?.userData || {});
    this.addComponent(id, DebugComponentType.DEBUG_DATA, opts?.debugData || {});
    this.setDisabled(id, Boolean(opts?.disabled));
    return id;
  }

  /** Delete an entity. */
  deleteEntity(entityId: number): void {
    // @CHORE: Add option to NOT delete physics object, mesh, geometry, material, textures, and maps
    this.storages.forEach((s) => s.delete(entityId));
    this.entities.delete(entityId);

    // Reset nextEntityId if entities set is empty
    if (this.entities.size === 0) this.nextEntityId = 0;
  }

  addComponent<K extends ComponentType>(entityId: number, type: K, data: ComponentData[K]): void {
    if (type === ComponentType.DEBUG_DATA && !isDebugEnvironment) return;

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
      // @QUESTION: What other type of Three.js Object3Ds should we tag? Points/Particles?
    }
  }

  /**
   * Removes a component from an entity.
   * @param entityId The ID of the entity.
   * @param type The type of component to remove.
   */
  public removeComponent(entityId: number, type: ComponentType): void {
    const storage = this.storages.get(type);
    if (storage) storage.delete(entityId);
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
   * Unlike setTransform, this resets velocities to ensure
   * the object doesn't carry old momentum to the new spot.
   */
  public teleport(
    entityId: number,
    tra: { pos: ECSPosition; rot?: ECSRotation } | { pos?: ECSPosition; rot: ECSRotation }
  ): void {
    // @CHORE: We probably need to take interpolation into consideration (set the prev transform to the new position)
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
   * Returns true if the entity is disabled.
   * If the DISABLED component is missing, we assume it's enabled by default.
   */
  public isDisabled(entityId: number): boolean {
    return this.hasComponent(entityId, ComponentType.DISABLED);
  }

  /**
   * Master Disabled Switch for an Entity.
   * Coordinates visibility, physics disabling, etc.
   */
  public setDisabled(
    entityId: number,
    disabled: boolean,
    opts?: {
      /** Default is true */
      resetVelocity?: boolean;
      /** Default is true */
      resetForces?: boolean;
      /** Default is true */
      wakeUp?: boolean;
    }
  ): void {
    // Handle Physics
    const rb = this.getRigidBody(entityId);
    if (rb) {
      const resetVelocity = opts?.resetVelocity === undefined ? true : opts.resetVelocity;
      const resetForces = opts?.resetForces === undefined ? true : opts.resetForces;
      const wakeUp = opts?.wakeUp === undefined ? true : opts.wakeUp;

      rb.setEnabled(!disabled);

      if (this.isEntityDynamic(entityId)) {
        this._resetBodyState(rb, Boolean(resetVelocity), Boolean(resetForces), wakeUp);
      }
    }

    // Handle Object3D Visibility
    const object3D = this.getComponent(entityId, ComponentType.OBJECT3D);
    if (object3D) {
      object3D.value.visible = !disabled;
    }

    // Handle Future Components (e.g., Sounds)
    // const sound = this.getComponent(entityId, ComponentType.SOUND_EMITTER);
    // if (sound) { sound.stop(); }

    // Update the state component
    if (disabled) {
      // Disabled
      this.addComponent(entityId, CoreComponentType.DISABLED, disabled);
      return;
    }
    // Enabled
    this.removeComponent(entityId, CoreComponentType.DISABLED);
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

  /** Runs in the "Main" part of the loop (UI, Engine maintenance, Pre-Physics) */
  public updateMainLoop(dt: number) {
    this._runStage(ECSSystemStage.MAIN, dt);
    this._runStage(ECSSystemStage.APP_PRE_PHYSICS, dt);
  }

  /** Runs the Simulation/App logic (Physics, Gameplay, Render Sync) */
  public updateAppLoop(dt: number) {
    this._runStage(ECSSystemStage.APP_POST_PHYSICS, dt);
    this._runStage(ECSSystemStage.APP_LOGIC, dt);
    this._runStage(ECSSystemStage.APP_RENDER_SYNC, dt);
  }

  /** Runs after the Three.js renderer.render() call */
  public updateLateMainLoop(dt: number) {
    this._runStage(ECSSystemStage.LATE_MAIN, dt);
  }

  private _runStage(stage: ECSSystemStage, dt: number) {
    const list = this.systems.get(stage)!;
    for (let i = 0; i < list.length; i++) {
      list[i].fn(this, dt);
    }
  }
}
