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
import { getConfig, IS_DEBUG_ENV, isDebugEnvironment } from './Config';
import { CoreComponentType } from './ECS/ECSRegistry';
import {
  getECSStorageLSOverride,
  ECSStorageMode,
  IComponentStorage,
} from './ECS/ECSComponentStorage';
import { TypedArrayTransformStore } from './ECS/TypedArrayTransformStore';
import { ECSSystemStage } from '../../AppECSRegistry';
import { CoreEntityOpts } from '../schemas/_helperSchemas';
import { loadDebugModuleAsync, useDebug, type DebugModuleRef } from '../utils/helpers';
import { lerror } from '../utils/Logger';

export type ECSSystem = (world: ECSWorld, dt: number) => void;

type SystemEntry = { id: string; fn: ECSSystem; order: number; seq: number };

export type WorldPlugin = (world: ECSWorld) => void;
export type ComponentHook = (entityId: number, world: ECSWorld) => void;

export const DEFAULT_ECS_WORLD_ID = '[default]';

export type ECSWorldOptions = {
  /** Defaults to DEFAULT_ECS_WORLD_ID. Must be unique among live worlds — the identity/lookup key. */
  id?: string;
  /** Debug-only display name. Defaults to `id` if omitted. Not required to be unique. */
  name?: string;
  /** Debug-only free-text description, shown in the ECS debug tab's Worlds listing. */
  description?: string;
  storageMode?: ECSStorageMode;
  maxEntities?: number;
  /** Whether globally registered plugins (ECSWorld.registerPlugin) run on this world. Default true. */
  applyGlobalPlugins?: boolean;
};

let ecsWorld: ECSWorld;

/** Initializes the default ECS World. */
export const initECSWorld = (): ECSWorld => {
  const ecsConfig = getConfig().ecs;
  let storageMode: ECSStorageMode = ecsConfig?.storageMode ?? 'MAP';
  let maxEntities = ecsConfig?.maxEntities ?? 100_000;
  if (IS_DEBUG_ENV) {
    const lsOverride = getECSStorageLSOverride(DEFAULT_ECS_WORLD_ID);
    if (lsOverride?.storageMode) storageMode = lsOverride.storageMode;
    if (lsOverride?.maxEntities) maxEntities = lsOverride.maxEntities;
  }
  ecsWorld = new ECSWorld({ storageMode, maxEntities });
  return ecsWorld;
};

/** Returns the ECS World for `id` (defaults to the default world) or throws an error. */
export const getECSWorld = (id: string = DEFAULT_ECS_WORLD_ID): ECSWorld =>
  existsOrThrow(
    ECSWorld.getWorld(id),
    `ECS World '${id}' not initialized. Could not get ECS World.`
  );

/** Returns every currently registered ECS World. */
export const getAllECSWorlds = (): ECSWorld[] => ECSWorld.getAllWorlds();

/**
 * Deletes an ECS World by id. Routes every live entity through deleteEntity
 * so onDeleteEntity hooks still run (mesh/light/camera disposal, physics
 * body cleanup, etc.) instead of a bulk wipe that would skip them.
 * Returns false if no world with that id exists.
 */
export const deleteECSWorld = (id: string): boolean => ECSWorld.deleteWorld(id);

/**
 * Subscribes to world creation/deletion (not entity or component changes —
 * see `onECSEntityCountChange` and `ECSWorld.registerComponentHooks` for
 * those). Used by debug tooling (the ECS debug tab's live world list) to
 * know when to refresh; nothing else in the engine needs this today.
 */
export const onECSWorldRegistryChange = (listener: () => void): void =>
  ECSWorld.onWorldRegistryChange(listener);

/**
 * Subscribes to entity creation/deletion in ANY world (the listener
 * receives which one). Fires from `createRawEntity`/`createEntity`/
 * `deleteEntity` — note `createRawEntity` adds no components, so this is
 * the only reliable way to observe "this world's entity count changed",
 * `registerComponentHooks` would silently miss raw entities entirely.
 * Debug-tooling-only today (the ECS debug tab's live entity counts); fires
 * unconditionally regardless of `IS_DEBUG_ENV` (an empty listener array in
 * production, so the cost is one no-op `.forEach()` per entity op) rather
 * than adding a branch to every entity-creation/deletion call site.
 */
export const onECSEntityCountChange = (listener: (world: ECSWorld) => void): void =>
  ECSWorld.onEntityCountChange(listener);

export class ECSWorld {
  // INSTANCE TRACKING (keyed by world id — also the identity/lookup registry)
  private static worldsById: Map<string, ECSWorld> = new Map();
  private static worldRegistryListeners: (() => void)[] = [];
  private static entityCountListeners: ((world: ECSWorld) => void)[] = [];
  // STATIC REGISTRIES (External core managers write to these)
  // `corePlugins` are universal engine plumbing (e.g. the ECSCoreSystems.ts
  // object3D/physics/lookAt sync) that every world needs regardless of
  // `applyGlobalPlugins` — without them a world's entities never visually
  // update. `plugins` are app/feature systems (light culling, hover/follow
  // tool effects, etc.) that a bare world can legitimately opt out of.
  private static corePlugins: WorldPlugin[] = [];
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

    // Apply to existing worlds immediately (Hot Loading, if the world is already initiated),
    // skipping worlds that opted out via applyGlobalPlugins: false.
    this.worldsById.forEach((world) => {
      if (world.applyGlobalPlugins) plugin(world);
    });
  }

  /**
   * Like `registerPlugin`, but always applies to every world — current and
   * future — regardless of `applyGlobalPlugins`. Reserved for universal
   * engine plumbing (see ECSCoreSystems.ts) that every world needs to
   * function correctly; app/feature systems should use `registerPlugin`.
   */
  public static registerCorePlugin(plugin: WorldPlugin) {
    this.corePlugins.push(plugin);
    this.worldsById.forEach((world) => {
      plugin(world);
    });
  }

  /** Returns the ECS World registered under `id`, or undefined if none exists. */
  public static getWorld(id: string): ECSWorld | undefined {
    return this.worldsById.get(id);
  }

  /** Returns every currently registered ECS World. */
  public static getAllWorlds(): ECSWorld[] {
    return Array.from(this.worldsById.values());
  }

  /**
   * Deletes an ECS World by id. Routes every live entity through deleteEntity
   * so onDeleteEntity hooks run (mesh/light/camera disposal, physics body
   * cleanup, etc.) — a bulk clearWorld()-style wipe would skip them.
   * Returns false if no world with that id exists.
   */
  public static deleteWorld(id: string): boolean {
    const world = this.worldsById.get(id);
    if (!world) return false;
    for (const entityId of Array.from(world.entities)) {
      world.deleteEntity(entityId);
    }
    this.worldsById.delete(id);
    this.notifyWorldRegistryChange();
    return true;
  }

  /** See the module-level `onECSWorldRegistryChange` export. */
  public static onWorldRegistryChange(listener: () => void): void {
    this.worldRegistryListeners.push(listener);
  }

  private static notifyWorldRegistryChange(): void {
    this.worldRegistryListeners.forEach((listener) => listener());
  }

  /** See the module-level `onECSEntityCountChange` export. */
  public static onEntityCountChange(listener: (world: ECSWorld) => void): void {
    this.entityCountListeners.push(listener);
  }

  private static notifyEntityCountChange(world: ECSWorld): void {
    this.entityCountListeners.forEach((listener) => listener(world));
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
  // Tracks the current 'version' of every index ever created. Sized to
  // `maxEntities` (capped at the full 20-bit index space), not the full
  // 1,048,576-slot address space the packed-id scheme could support — a
  // world with a small maxEntities (e.g. a bare secondary world) shouldn't
  // pay for the ~4 MiB a full-size array would cost regardless of how many
  // entities it actually ever holds (see docs/plans/ecs-multiple-worlds.md
  // §5.3). Allocated in the constructor, after `maxEntities` is known.
  private generations: Uint32Array;

  private nextEntityId = 1;
  private freeIds: number[] = [];
  private entities = new Set<number>();

  // Storage: Map<Type, IComponentStorage<Data>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private storages: Map<ComponentType, IComponentStorage<any>> = new Map();

  private systems: Map<ECSSystemStage, SystemEntry[]> = new Map();
  private systemSeq = 0;

  // Build-time-selectable storage backend (see docs/plans/ecs-typed-arrays-feature.md).
  // TYPED_ARRAY currently only applies to TRANSFORM; every other component
  // type stays Map-backed regardless of this setting.
  public readonly storageMode: ECSStorageMode;
  public readonly maxEntities: number;

  public readonly id: string;
  /** Debug-only — never used for lookup/equality, purely a nicer label in the debug tab. */
  public readonly name: string;
  /** Debug-only — shown alongside `name` in the debug tab, omitted if not given. */
  public readonly description?: string;
  private readonly applyGlobalPlugins: boolean;

  constructor(opts?: ECSWorldOptions) {
    const id = opts?.id ?? DEFAULT_ECS_WORLD_ID;
    if (ECSWorld.worldsById.has(id)) {
      const msg =
        id === DEFAULT_ECS_WORLD_ID
          ? 'Default ECS World already exists. Pass an explicit `id` to create an additional world.'
          : `ECS World with id '${id}' already exists.`;
      lerror(msg);
      throw new Error(msg);
    }

    this.id = id;
    this.name = opts?.name ?? id;
    this.description = opts?.description;
    this.applyGlobalPlugins = opts?.applyGlobalPlugins ?? true;

    // Debug-tab storage overrides (per world id, see ECSComponentStorage.ts)
    // only fill in a field the caller left unset — they never clobber an
    // explicit opts.storageMode/opts.maxEntities. initECSWorld() already
    // resolves its own Config+LS-override precedence for the default world
    // before ever calling this constructor, so this only matters for
    // secondary worlds that leave these fields unset.
    const lsOverride = IS_DEBUG_ENV ? getECSStorageLSOverride(id) : undefined;
    this.storageMode = opts?.storageMode ?? lsOverride?.storageMode ?? 'MAP';
    this.maxEntities = opts?.maxEntities ?? lsOverride?.maxEntities ?? 100_000;
    this.generations = new Uint32Array(Math.min(this.maxEntities, this.INDEX_MASK + 1));

    // Pre-allocate system stages and storages
    Object.values(ECSSystemStage).forEach((s) => this.systems.set(s, []));
    Object.values(ComponentType).forEach((type) => {
      if (type === ComponentType.TRANSFORM && this.storageMode === 'TYPED_ARRAY') {
        this.storages.set(
          type,
          new TypedArrayTransformStore(this.maxEntities, (id) => this.getEntityIndex(id))
        );
      } else {
        this.storages.set(type, new Map());
      }
    });

    // REGISTER THIS INSTANCE
    ECSWorld.worldsById.set(id, this);

    // BOOTSTRAP: core plugins (universal engine plumbing) always run, first,
    // regardless of applyGlobalPlugins — see the corePlugins field comment.
    ECSWorld.corePlugins.forEach((plugin) => plugin(this));

    // Then run app/feature plugins, unless this world opted out via
    // applyGlobalPlugins: false.
    if (this.applyGlobalPlugins) {
      ECSWorld.plugins.forEach((plugin) => plugin(this));
    }

    ECSWorld.notifyWorldRegistryChange();
  }

  /**
   * Registers a system function to run every frame during `stage`.
   *
   * Ordering contract:
   * - Within a stage, systems run in descending `order` — higher runs earlier.
   * - Equal `order` (the default, 0) runs in registration order: the order
   *   `addSystem` was actually called, not source-file position. A system
   *   removed via `removeSystem` and re-registered later is treated as a new
   *   registration and moves to the back of its `order` tier.
   * - Resolved once, here, at registration time. `_runStage` never sorts.
   *
   * `order` is a plain number, not a fixed tier set — pick a value relative
   * to the specific systems you need to run before/after, not as a point on
   * some global priority scale.
   */
  public addSystem(stage: ECSSystemStage, id: string, fn: ECSSystem, order: number = 0) {
    const stageSystems = this.systems.get(stage);
    // Prevent duplicate systems if a plugin is re-run
    if (stageSystems?.some((s) => s.id === id)) return;
    stageSystems?.push({ id, fn, order, seq: this.systemSeq++ });
    stageSystems?.sort((a, b) => b.order - a.order || a.seq - b.seq);
  }

  /**
   * Removes a system by `id` from every stage.
   *
   * `.filter()` never reorders, so a stage's already-sorted array stays
   * correctly sorted after removal. If a removed `id` is later re-registered
   * via `addSystem`, it gets a fresh `seq` (the counter never rewinds) and
   * lands at the back of its `order` tier, not back in its original tie
   * position — a new registration, not a resumed one.
   */
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
   * Extracts the stable, dense entity-slot index from a packed entity id.
   * Exposed (narrowly, alongside the still-private `_pack`/`_getGeneration`)
   * for storage backends — e.g. the TypedArray-backed sparse set proposed in
   * docs/plans/ecs-typed-arrays-feature.md — that need a numeric array
   * offset; the packed id itself is not usable as one.
   */
  public getEntityIndex(entityId: number): number {
    return this._getIndex(entityId);
  }

  /** Returns the number of currently live entities in this world. */
  public getEntityCount(): number {
    return this.entities.size;
  }

  /**
   * Returns the TypedArray-backed Transform store when TRANSFORM storage is
   * in `TYPED_ARRAY` mode, or `undefined` in the default `MAP` mode.
   * Hot-path systems use this to branch once per call instead of paying the
   * cold-path `getComponent()` materialization cost per entity.
   */
  public getTypedTransformStore(): TypedArrayTransformStore | undefined {
    return this.storageMode === 'TYPED_ARRAY'
      ? (this.storages.get(ComponentType.TRANSFORM) as TypedArrayTransformStore)
      : undefined;
  }

  /**
   * Writes a `Transform` object back into TRANSFORM storage after in-place
   * mutation. Cold-path `getComponent(TRANSFORM)` may return a
   * disconnected, freshly materialized copy (`TYPED_ARRAY` mode) rather
   * than a live reference (`MAP` mode) — callers that fetch a Transform,
   * mutate its position/quaternion/scale in place, and call `setDirty()`
   * must call this afterward for the change to persist in both modes.
   */
  public commitTransform(entityId: number, transform: Transform): void {
    this.storages.get(ComponentType.TRANSFORM)?.set(entityId, transform);
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
    // Recycled slots were validly allocated before, so only a fresh
    // (never-recycled) index needs the maxEntities bounds check — without
    // it, index >= generations.length would silently no-op on write and
    // always read back 0/undefined instead of throwing (Uint32Array access
    // out of bounds doesn't throw), corrupting isAlive() for that slot.
    if (this.freeIds.length === 0 && this.nextEntityId >= this.maxEntities) {
      const msg = `ECS World '${this.id}' has reached its maxEntities cap (${this.maxEntities}). Increase maxEntities or free existing entities before creating more.`;
      lerror(msg);
      throw new Error(msg);
    }

    const index = this.freeIds.length > 0 ? this.freeIds.pop()! : this.nextEntityId++;
    // Use the current generation for this specific slot
    const gen = this.generations[index];
    return this._pack(index, gen);
  }

  createRawEntity() {
    const id = this._getNewEntityId();
    this.entities.add(id);
    ECSWorld.notifyEntityCountChange(this);
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
    ECSWorld.notifyEntityCountChange(this);
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

    ECSWorld.notifyEntityCountChange(this);
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
    // Fire hooks BEFORE the data is actually gone from storage so the hook
    // can still read the component's last value (including via
    // `hasComponent`/`getComponent` for `type` itself) if needed.
    const hooks = ECSWorld.onRemoveComponentHooks.get(type);
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

  /** Returns the resolved (already-sorted) system order for `stage`, for debugging/inspection. */
  public getSystemOrder(stage: ECSSystemStage): { id: string; order: number; seq: number }[] {
    return (this.systems.get(stage) ?? []).map(({ id, order, seq }) => ({ id, order, seq }));
  }

  /**
   * Direct access to a storage map for high-speed iteration.
   *
   * Iteration order happens to match `Map` insertion order (the order
   * entities first received this component) as a side effect of using `Map`
   * internally. This is an implementation detail, not a guarantee — systems
   * must not depend on it. It's expected to change for any component type
   * that moves to a different storage backing (e.g. the TypedArray-backed
   * sparse-set storage proposed in docs/plans/ecs-typed-arrays-feature.md,
   * which reorders on removal by design).
   */
  public getStorage<K extends ComponentType>(type: K): IComponentStorage<ComponentData[K]> {
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
      this.commitTransform(entityId, transform);
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
   * Same iteration-order caveat as `getStorage` applies: insertion-order
   * today, not guaranteed.
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

  /**
   * Runs every system registered for `stage`, in the order resolved once at
   * registration time by `addSystem` — this function does no sorting and
   * never reorders anything itself, so it has no ordering-related per-frame
   * cost.
   *
   * Stage execution order itself is decided elsewhere: it's the fixed call
   * sequence in `updateMainLoop` / `updateAppLoop` / `updateLateMainLoop`.
   */
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

// Debug stuff

type ECSGUIModule = typeof import('../core/Debug/_dbg__ECS');
let debugGUI: DebugModuleRef<ECSGUIModule> | null = null;

export const registerECSModule = async () => {
  if (!IS_DEBUG_ENV) return;
  debugGUI = await loadDebugModuleAsync(() => import('./Debug/_dbg__ECS'));
  useDebug(debugGUI)?._initECSDebugGUI();
};
