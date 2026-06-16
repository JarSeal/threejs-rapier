import * as THREE from 'three/webgpu';
import {
  ComponentData,
  ComponentType,
  ECSPosition,
  ECSRotation,
  ECSTransformProp,
  Transform,
} from './ECS/ECSCoreComponents';
import { existsOrThrow } from '../utils/assert';
import { RigidBodyAPI } from './Physics/PhysicsAPITypes';
import { isDebugEnvironment } from './Config';
import { CoreComponentType } from './ECS/ECSRegistry';
import { ECSSystemStage } from '../../AppECSRegistry';
import { CoreEntityOpts } from '../schemas/_helperSchemas';

export type ECSSystem = (world: ECSWorld, dt: number) => void;

export type WorldPlugin = (world: ECSWorld) => void;
export type ComponentHook = (entityId: number, world: ECSWorld) => void;

let ecsWorld: ECSWorld;

/** Initializes the ECS World. */
export const initECSWorld = (): ECSWorld => {
  ecsWorld = new ECSWorld();
  return ecsWorld;
};

/** Returns the ECS World or throws an error. */
export const getECSWorld = () =>
  existsOrThrow(ecsWorld, 'ECS World not initialized. Could not get ECS World.');

export class ECSWorld {
  // INSTANCE TRACKING
  private static activeWorlds = new Set<ECSWorld>();
  // STATIC REGISTRIES (External core managers write to these)
  private static plugins: WorldPlugin[] = [];
  private static onAddComponentHooks: Map<ComponentType, ComponentHook[]> = new Map();
  private static onRemoveComponentHooks: Map<ComponentType, ComponentHook[]> = new Map();
  private static onDeleteEntityHooks: Map<ComponentType, ComponentHook[]> = new Map();

  /** * Global registration methods.
   * Managers call these once at app startup.
   */
  public static registerPlugin(plugin: WorldPlugin) {
    // Save for future worlds (Cold Loading, if the world has not been initiated yet)
    this.plugins.push(plugin);

    // Apply to existing worlds immediately (Hot Loading, if the world is already initiated)
    this.activeWorlds.forEach((world) => {
      plugin(world);
    });
  }

  public static registerComponentHooks(
    type: ComponentType,
    hooks: {
      onAddComponent?: ComponentHook;
      onRemoveComponent?: ComponentHook;
      onDeleteEntity?: ComponentHook;
    }
  ) {
    if (hooks.onAddComponent) {
      if (!this.onAddComponentHooks.has(type)) this.onAddComponentHooks.set(type, []);
      this.onAddComponentHooks.get(type)!.push(hooks.onAddComponent);
    }
    if (hooks.onRemoveComponent) {
      if (!this.onRemoveComponentHooks.has(type)) this.onRemoveComponentHooks.set(type, []);
      this.onRemoveComponentHooks.get(type)!.push(hooks.onRemoveComponent);
    }
    if (hooks.onDeleteEntity) {
      if (!this.onDeleteEntityHooks.has(type)) this.onDeleteEntityHooks.set(type, []);
      this.onDeleteEntityHooks.get(type)!.push(hooks.onDeleteEntity);
    }
  }

  // Bitwise constants for generation usage:
  // We use 20 bits for the index (~1 million entities)
  // and 12 bits for the generation (4096 reuses per slot)
  private readonly INDEX_MASK = 0xfffff;
  private readonly GEN_SHIFT = 20; // @CONSIDER: This could be a CONFIG value (optional, defaults to 20)
  // Tracks the current 'version' of every index ever created
  private generations = new Uint32Array(1048576);

  private nextEntityId = 1;
  private freeIds: number[] = [];
  private entities = new Set<number>();

  // Storage: Map<Type, Map<EntityID, Data>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private storages: Map<ComponentType, Map<number, any>> = new Map();

  private systems: Map<ECSSystemStage, { id: string; fn: ECSSystem }[]> = new Map();

  constructor() {
    // Pre-allocate system stages and storages
    Object.values(ECSSystemStage).forEach((s) => this.systems.set(s, []));
    Object.values(ComponentType).forEach((type) => {
      this.storages.set(type, new Map());
    });

    // REGISTER THIS INSTANCE
    ECSWorld.activeWorlds.add(this);

    // BOOTSTRAP: Run all globally registered plugins (systems and other initiation logic)
    ECSWorld.plugins.forEach((plugin) => plugin(this));
  }

  public addSystem(stage: ECSSystemStage, id: string, fn: ECSSystem) {
    const stageSystems = this.systems.get(stage);
    // Prevent duplicate systems if a plugin is re-run
    if (stageSystems?.some((s) => s.id === id)) return;
    stageSystems?.push({ id, fn });
  }

  public removeSystem(id: string) {
    this.systems.forEach((list, stage) => {
      this.systems.set(
        stage,
        list.filter((s) => s.id !== id)
      );
    });
  }

  /** Extracts the storage index from a packed ID */
  private _getIndex(id: number): number {
    return id & this.INDEX_MASK;
  }

  /** Extracts the generation version from a packed ID */
  private _getGeneration(id: number): number {
    return id >>> this.GEN_SHIFT;
  }

  /** Combines an index and a generation into a single number */
  private _pack(index: number, gen: number): number {
    // Mask gen to 12 bits (0xfff) before shifting to ensure it never
    // interferes with bits outside the 32-bit signed integer range.
    return ((gen & 0xfff) << this.GEN_SHIFT) | (index & this.INDEX_MASK);
  }

  /**
   * Prevents "Ghost ID" bugs where a system tries to act on a deleted entity
   * that has been replaced by a new one in the same storage slot.
   */
  public isAlive(entityId: number): boolean {
    const index = this._getIndex(entityId);
    const gen = this._getGeneration(entityId);
    return this.generations[index] === gen && this.entities.has(entityId);
  }

  private _getNewEntityId() {
    const index = this.freeIds.length > 0 ? this.freeIds.pop()! : this.nextEntityId++;
    // Use the current generation for this specific slot
    const gen = this.generations[index];
    return this._pack(index, gen);
  }

  createRawEntity() {
    const id = this._getNewEntityId();
    this.entities.add(id);
    return id;
  }

  createEntity(opts?: CoreEntityOpts): number {
    const id = this._getNewEntityId();
    this.entities.add(id);
    this.addComponent(id, CoreComponentType.APP_ID, {
      id: opts?.appId || THREE.MathUtils.generateUUID(),
      isFixed: Boolean(opts?.appId),
    });
    this.addComponent(id, CoreComponentType.TRANSFORM, new Transform());
    this.addComponent(id, CoreComponentType.USER_DATA, opts?.userData || {});
    this.addComponent(id, CoreComponentType.DEBUG_DATA, opts?.debugData || {});
    this.setDisabled(id, Boolean(opts?.disabled));
    return id;
  }

  /**
   * Removes an entity and cleans up all associated resources.
   */
  deleteEntity(entityId: number): void {
    // Safety: Ignore if entity is already dead
    if (!this.isAlive(entityId)) return;

    // Trigger Destruction Hooks (onDeleteEntity)
    // We check every storage to see if this entity has it
    this.storages.forEach((storage, type) => {
      if (storage.has(entityId)) {
        const hooks = ECSWorld.onDeleteEntityHooks.get(type);
        hooks?.forEach((hook) => hook(entityId, this));
      }
    });

    const index = this._getIndex(entityId);

    // Incrementing the generation at this index means any OLD IDs
    // floating around will fail the isAlive() check immediately.
    this.generations[index]++;

    // Clear ECS data using the packed ID as the key for Map consistency
    this.storages.forEach((storage) => storage.delete(entityId));
    this.entities.delete(entityId);

    // Recycle the index for future use
    this.freeIds.push(index);
  }

  addComponent<K extends ComponentType>(entityId: number, type: K, data: ComponentData[K]): void {
    if (type === ComponentType.DEBUG_DATA && !isDebugEnvironment) return;

    let storage = this.storages.get(type);
    if (!storage) {
      storage = new Map();
      this.storages.set(type, storage);
    }

    storage.set(entityId, data);

    // Trigger Initialization Hooks (onAddComponent)
    const hooks = ECSWorld.onAddComponentHooks.get(type);
    hooks?.forEach((hook) => hook(entityId, this));
  }

  /**
   * Removes a component from an entity.
   * @param entityId The ID of the entity.
   * @param type The type of component to remove.
   */
  public removeComponent(entityId: number, type: ComponentType): void {
    const storage = this.storages.get(type);
    if (storage) storage.delete(entityId);
    const hooks = ECSWorld.onRemoveComponentHooks.get(type);

    // Fire hooks BEFORE the data is actually gone from storage
    // so the hook can still read the component values if needed.
    hooks?.forEach((hook) => hook(entityId, this));
    this.storages.get(type)?.delete(entityId);
  }

  public getComponent<K extends ComponentType>(
    entityId: number,
    type: K
  ): ComponentData[K] | undefined {
    return this.storages.get(type)?.get(entityId);
  }

  /** Checks if an entity has a specific component. */
  public hasComponent(entityId: number, type: ComponentType): boolean {
    return this.storages.get(type)?.has(entityId) ?? false;
  }

  /** Direct access to a storage map for high-speed iteration */
  public getStorage<K extends ComponentType>(type: K): Map<number, ComponentData[K]> {
    let storage = this.storages.get(type);

    // --- PREVENT ITERABLE ERROR ---
    if (!storage) {
      // If it doesn't exist, create an empty one so systems don't crash
      storage = new Map();
      this.storages.set(type, storage);
    }

    return storage;
  }

  /** * Hard reset of the entire engine state.
   * Everything is wiped, and ID counters start over.
   */
  public clearWorld(): void {
    // 1. Clear all component data
    this.storages.forEach((storage) => storage.clear());

    // 2. Clear entity tracking
    this.entities.clear();

    // 3. Reset ID pool and counter
    this.freeIds = [];
    this.nextEntityId = 0;
  }

  /**
   * Wipes all entities EXCEPT those marked as persistent (PERSISTENT).
   * Used for switching scenes while keeping loaders/global state alive
   * and any other entity needed to be shared between scenes.
   */
  public clearNonPersistent(): void {
    const persistentEntities = new Set<number>();
    const persistentStorage = this.getStorage(ComponentType.PERSISTENT);
    if (persistentStorage) {
      for (const [entityId] of persistentStorage) {
        persistentEntities.add(entityId);
      }
    }
    const allEntities = Array.from(this.entities);
    for (const entityId of allEntities) {
      if (persistentEntities.has(entityId)) continue;
      this.deleteEntity(entityId);
    }
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
  public teleport(entityId: number, tra: ECSTransformProp): void {
    // @CHORE: We probably need to take interpolation into consideration (set the prev transform to the new position)
    this.setTransform(entityId, { ...tra, resetVelocity: true, resetForces: true });
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

export const getEntityIdByAppId = (appId: string, ecsWorld?: ECSWorld): number | undefined => {
  const world = ecsWorld || getECSWorld();
  const appIdStorage = world.getStorage(ComponentType.APP_ID);
  for (const [entityId, data] of appIdStorage) {
    if (data.id === appId) {
      return entityId;
    }
  }
  return undefined;
};
