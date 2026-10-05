import * as THREE from 'three/webgpu';
import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { incGeometryRef } from '../Geometry';
import { incMaterialRef } from '../Material';
import { registerLodTarget } from '../Lod/LodSystem';
import {
  DEFAULT_SPATIAL_DOMAIN,
  getConservativeGeometryRadius,
  getSpatialDomain,
  joinSpatialDomain,
  registerSpatialRadiusProvider,
} from '../Spatial/SpatialIndexSystem';
import { lwarn } from '../../utils/Logger';
import type { LodData, LodDef, LodResolvedLevel } from '../Lod/LodTypes';
import type { CoreEntityOpts } from '../../schemas/_helperSchemas';
import type { InstancePlacement, InstancedMeshSlotData } from './InstancedMeshPoolTypes';

// Instanced mesh pools: one InstancedMesh drawing many instances, each instance an ECS entity
// with a Transform and an INSTANCED_MESH_SLOT (its mesh and slot index), kept in sync onto the
// instance matrix by instancedMeshPoolSyncSystem. An instanced LOD pool has one mesh per level
// (docs/plans/p348_ecs-lod-selection.md §4.2). The sync system registers itself with the module.

export type * from './InstancedMeshPoolTypes';

// A pool instance's spatial radius (docs/plans/_DONE_p346_spatial-domains.md §3.3): the pool
// geometry's (an instanced LOD pool: level 0's), scaled by the instance's Transform.
registerSpatialRadiusProvider(ComponentType.INSTANCED_MESH_SLOT, (entityId, world) => {
  const slot = world.getComponent(entityId, ComponentType.INSTANCED_MESH_SLOT);
  if (!slot) return undefined;
  const lodPool = lodPoolsByMesh.get(slot.mesh);
  return getConservativeGeometryRadius(lodPool ? lodPool.levels[0].geometry : slot.mesh.geometry);
});

const _matrix = new THREE.Matrix4();
const _moveMatrix = new THREE.Matrix4();
const _color = new THREE.Color();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

// Slot → entity per pooled mesh (docs/plans/p348_ecs-lod-selection.md §4.2): freeing a slot moves
// the mesh's last instance into it and patches that instance's entity. Keyed by mesh, not by
// pool, so a pool with several meshes (one per LOD level) shares the same swap-remove. Entity ids
// can be negative int32s (the generation is in the high bits), which Int32Array holds exactly.
const slotEntitiesByMesh = new WeakMap<THREE.InstancedMesh, Int32Array>();

// The state of an instanced LOD pool, by each of its level meshes
type LodPoolState = {
  meshes: THREE.InstancedMesh[];
  levels: LodResolvedLevel[];
  /** Instances alive, in a level mesh or LOD culled (in none). */
  liveCount: number;
};
const lodPoolsByMesh = new WeakMap<THREE.InstancedMesh, LodPoolState>();

const getSlot = (entityId: number, world: ECSWorld) =>
  world.getComponent(entityId, ComponentType.INSTANCED_MESH_SLOT);

/** Appends an instance to `mesh` with `matrix`, returning its slot index. */
const appendInstance = (mesh: THREE.InstancedMesh, entityId: number, matrix: THREE.Matrix4) => {
  const index = mesh.count;
  mesh.setMatrixAt(index, matrix);
  slotEntitiesByMesh.get(mesh)![index] = entityId;
  mesh.count = index + 1;
  mesh.instanceMatrix.needsUpdate = true;
  return index;
};

/** Takes `entityId`'s instance out of its mesh with a swap-remove: the last instance's matrix (and
 * colour) moves into its slot, so the drawn range stays `0..count-1`, and `slot.index` becomes -1.
 * A no-op for an instance in no mesh. The mesh's bounds aren't recomputed: they only shrink, so the
 * old ones stay conservative. */
const removeInstance = (entityId: number, slot: InstancedMeshSlotData, world: ECSWorld) => {
  const { mesh, index } = slot;
  const slotEntities = slotEntitiesByMesh.get(mesh);
  if (!slotEntities || index < 0 || index >= mesh.count || slotEntities[index] !== entityId) {
    return;
  }

  const last = mesh.count - 1;
  if (index !== last) {
    const movedId = slotEntities[last];
    mesh.getMatrixAt(last, _matrix);
    mesh.setMatrixAt(index, _matrix);
    if (mesh.instanceColor) {
      mesh.getColorAt(last, _color);
      mesh.setColorAt(index, _color);
      mesh.instanceColor.needsUpdate = true;
    }
    slotEntities[index] = movedId;
    const movedSlot = getSlot(movedId, world);
    if (movedSlot) movedSlot.index = index;
  }
  mesh.count = last;
  mesh.instanceMatrix.needsUpdate = true;
  slot.index = -1;
};

/** The slot's instance is going (its entity or the slot component): frees its slot. */
const freeInstanceSlot = (entityId: number, world: ECSWorld) => {
  const slot = getSlot(entityId, world);
  if (!slot) return;
  const lodPool = lodPoolsByMesh.get(slot.mesh);
  if (lodPool) lodPool.liveCount--;
  removeInstance(entityId, slot, world);
};

// onRemoveComponent too, so removing the slot directly can't leave its matrix drawn
ECSWorld.registerComponentHooks(ComponentType.INSTANCED_MESH_SLOT, {
  onRemoveComponent: freeInstanceSlot,
  onDeleteEntity: freeInstanceSlot,
});

// A pool instance in an instanced LOD pool shows its level by moving to that level's mesh
// (docs/plans/p348_ecs-lod-selection.md §4.2). Its slot keeps pointing at the applied level's
// mesh while it's LOD culled (index -1, in no mesh), so it knows where to come back to.
registerLodTarget(ComponentType.INSTANCED_MESH_SLOT, {
  resolveLevels: (entityId, world) => {
    const slot = getSlot(entityId, world);
    return slot && lodPoolsByMesh.get(slot.mesh)?.levels;
  },
  applyLevel: (entityId, world, level) => {
    const slot = getSlot(entityId, world);
    const target = slot && lodPoolsByMesh.get(slot.mesh)?.meshes[level];
    if (!slot || !target || slot.mesh === target) return;
    if (slot.index >= 0) {
      slot.mesh.getMatrixAt(slot.index, _moveMatrix);
      removeInstance(entityId, slot, world);
      slot.index = appendInstance(target, entityId, _moveMatrix);
    }
    slot.mesh = target;
  },
  setCulled: (entityId, world, isCulled) => {
    const slot = getSlot(entityId, world);
    if (!slot) return;
    if (isCulled) {
      removeInstance(entityId, slot, world);
      return;
    }
    if (slot.index >= 0) return;
    // instancedMeshPoolSyncSystem skipped it while culled: the matrix comes from its Transform
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) return;
    _moveMatrix.compose(transform.position, transform.quaternion, transform.scale);
    slot.index = appendInstance(slot.mesh, entityId, _moveMatrix);
    slot._lastVersion = transform.version;
  },
});

/** Creates a pool's `InstancedMesh` and the entity that owns it. The mesh takes a registry ref on
 * its geometry and material(s), which `MeshManager`'s `TAG_IS_MESH` delete hook releases. */
const createPoolMesh = (
  world: ECSWorld,
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  maxInstances: number,
  castShadow: boolean,
  receiveShadow: boolean,
  entityOpts?: CoreEntityOpts
) => {
  const mesh = new THREE.InstancedMesh(geometry, material, maxInstances);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  mesh.count = 0;

  const geoId = geometry.userData.id as string | undefined;
  if (geoId) incGeometryRef(geoId);
  for (const m of Array.isArray(material) ? material : [material]) {
    if (m.userData.id) incMaterialRef(m.userData.id);
  }

  // TAG_IS_MESH: MeshManager's delete hook removes and disposes the mesh with its entity
  const meshEntityId = world.createEntity(entityOpts);
  // Marks the mesh as holding refs: setMeshGeometry / setMeshMaterial then move them
  mesh.userData.entityId = meshEntityId;
  world.addComponent(meshEntityId, ComponentType.OBJECT3D, {
    value: mesh,
    _lastVersion: -1,
  });
  world.addComponent(meshEntityId, ComponentType.TAG_IS_MESH, true);

  slotEntitiesByMesh.set(mesh, new Int32Array(maxInstances));
  return { mesh, meshEntityId };
};

/** The spatial domain `spawn()` joins its instances to, undefined (with a warning) when it isn't
 * registered. Checked once per spawn, or joinSpatialDomain would warn for every instance. */
const getSpawnSpatialDomain = (
  world: ECSWorld,
  spatialDomain: string | undefined,
  poolName: string
) => {
  if (
    spatialDomain &&
    spatialDomain !== DEFAULT_SPATIAL_DOMAIN &&
    !getSpatialDomain(world, spatialDomain)
  ) {
    lwarn(
      `${poolName}: spatial domain '${spatialDomain}' isn't registered — the instances ` +
        `aren't indexed (register it with registerSpatialDomain before spawning).`
    );
    return undefined;
  }
  return spatialDomain;
};

/** Creates an instance's entity at `placement` and leaves its matrix in `_matrix`. */
const createInstanceEntity = (
  world: ECSWorld,
  placement: InstancePlacement,
  entityOpts?: CoreEntityOpts
) => {
  const entityId = world.createEntity(entityOpts);
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM)!;
  transform.position.copy(placement.position);
  transform.quaternion.copy(placement.quaternion);
  transform.scale.setScalar(placement.scale);
  transform.setDirty();
  // Required for the mutation to persist in TYPED_ARRAY storage mode (getComponent can
  // return a disconnected, freshly materialized copy there) — see ECSWorld.commitTransform's
  // doc comment. Harmless in the default MAP mode, where it re-sets the same reference.
  world.commitTransform(entityId, transform);
  // Baked synchronously (not left to instancedMeshPoolSyncSystem's next tick) so the bounds
  // see real placement data immediately, and so nothing flashes at the pool's default
  // (identity, i.e. world-origin) matrix for one frame.
  _matrix.compose(transform.position, transform.quaternion, transform.scale);
  return { entityId, version: transform.version };
};

export interface CreateInstancedMeshPoolOptions {
  /** Used to create one dedicated ECS entity that owns `mesh` itself (distinct from the
   * per-instance slot entities `spawn()` creates) — see `InstancedMeshPool.mesh`'s doc comment. */
  world: ECSWorld;
  geometry: THREE.BufferGeometry;
  /** A material array (with a matching-length `geometry.groups`) works the same as on a plain `Mesh`. */
  material: THREE.Material | THREE.Material[];
  /** Hard cap on live instances this pool can hold at once, sized once. Despawning frees a slot for a later spawn. */
  maxInstances: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Passed to the mesh's own owning entity (e.g. to mark a long-lived pool `persistent`). */
  entityOpts?: CoreEntityOpts;
  /** A registered spatial domain `spawn()` joins every instance to (docs/plans/_DONE_p346_spatial-domains.md). Default: none. */
  spatialDomain?: string;
}

export interface InstancedMeshPool {
  /** Not added to any scene yet — add `pool.mesh` to the scene yourself. `mesh` is still owned by `meshEntityId`
   * (holding `OBJECT3D`/`TAG_IS_MESH`, like any plain mesh entity), so `MeshManager`'s existing
   * `TAG_IS_MESH` `onDeleteEntity` hook removes it from wherever it was added and disposes it once
   * that entity is deleted (e.g. by `ECSWorld.clearNonPersistent()` on scene switch) — without this,
   * the shared mesh would silently outlive every scene that created it. */
  mesh: THREE.InstancedMesh;
  /** The entity that owns `mesh` for lifecycle purposes (see `mesh`'s doc comment above). */
  meshEntityId: number;
  /**
   * Spawns one ECS entity per placement, holding a slot index into `mesh`, so every instance is
   * addressable through the ECS. Placements can come straight from the toolkit's
   * `scatterOnSurface`. Returns the created entity ids (fewer than `placements.length` if the
   * pool's `maxInstances` is reached).
   */
  spawn: (
    world: ECSWorld,
    placements: InstancePlacement[],
    entityOpts?: CoreEntityOpts
  ) => number[];
  /**
   * Deletes an instance's entity. The pool's last instance moves into its slot (swap-remove), so
   * another instance's `INSTANCED_MESH_SLOT.index` can change; read it from the component, never
   * keep it. Deleting the entity any other way, or removing its `INSTANCED_MESH_SLOT`, frees the
   * slot the same way. Returns false (and deletes nothing) when `entityId` isn't a live instance
   * of this pool.
   */
  despawn: (world: ECSWorld, entityId: number) => boolean;
}

/**
 * Creates a single `THREE.InstancedMesh` backed by an ECS-addressable pool: each spawned
 * instance is a real entity (holding a slot index) whose `Transform` can be queried/moved
 * later like any other entity, kept in sync onto the instance matrix by
 * `instancedMeshPoolSyncSystem`.
 */
export const createInstancedMeshPool = (
  opts: CreateInstancedMeshPoolOptions
): InstancedMeshPool => {
  const { world, geometry, material, maxInstances, castShadow = true, receiveShadow = true } = opts;

  const { mesh, meshEntityId } = createPoolMesh(
    world,
    geometry,
    material,
    maxInstances,
    castShadow,
    receiveShadow,
    opts.entityOpts
  );

  const spawn: InstancedMeshPool['spawn'] = (world, placements, entityOpts) => {
    const entityIds: number[] = [];
    const spatialDomain = getSpawnSpatialDomain(world, opts.spatialDomain, 'InstancedMeshPool');

    for (const placement of placements) {
      if (mesh.count >= maxInstances) {
        lwarn(
          `InstancedMeshPool: maxInstances (${maxInstances}) reached — skipping remaining placements.`
        );
        break;
      }

      const { entityId, version } = createInstanceEntity(world, placement, entityOpts);
      const index = appendInstance(mesh, entityId, _matrix);
      world.addComponent(entityId, ComponentType.INSTANCED_MESH_SLOT, {
        mesh,
        index,
        _lastVersion: version,
      });
      // After the slot, which its radius provider reads
      if (spatialDomain) joinSpatialDomain(entityId, spatialDomain, world);

      entityIds.push(entityId);
    }

    // THREE.InstancedMesh overrides computeBoundingSphere()/Box() to account for every
    // instance's matrix — without calling it, both stay null and native frustum culling falls
    // back to the base geometry's own (single-instance, near-origin) bounds, so the whole
    // InstancedMesh gets culled the moment the camera looks away from the origin even though
    // scattered instances elsewhere are still in view. Shadow rendering doesn't hit this same
    // check, which is why shadows kept showing while the meshes themselves vanished.
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();

    return entityIds;
  };

  const despawn: InstancedMeshPool['despawn'] = (world, entityId) => {
    const slot = getSlot(entityId, world);
    if (!slot || slot.mesh !== mesh) return false;
    // The slot hook frees the slot
    world.deleteEntity(entityId);
    return true;
  };

  return { mesh, meshEntityId, spawn, despawn };
};

export interface InstancedLodPoolLevel {
  geometry: THREE.BufferGeometry;
  /** A material array works like on `createInstancedMeshPool`. */
  material: THREE.Material | THREE.Material[];
  /** Smallest screen size (bounding-sphere diameter / viewport height) this level is used at,
   * like `LodLevelDef.screenSize`. Descending from level 0. */
  screenSize: number;
  /** Default true. */
  castShadow?: boolean;
}

export interface CreateInstancedLodPoolOptions {
  /** Owns one entity per level mesh, like `CreateInstancedMeshPoolOptions.world`. */
  world: ECSWorld;
  /** Level 0 (the finest) first. */
  levels: InstancedLodPoolLevel[];
  /** Hard cap on live instances, across every level (and LOD culled ones). Each level mesh is sized
   * for all of them. */
  maxInstances: number;
  /** The selection settings every instance shares (`cullScreenSize`, `hysteresis`, `bias`). */
  lod?: Omit<LodDef, 'levels'>;
  receiveShadow?: boolean;
  /** Passed to each level mesh's owning entity. */
  entityOpts?: CoreEntityOpts;
  /** A registered spatial domain `spawn()` joins every instance to. Default: none. */
  spatialDomain?: string;
}

export interface InstancedLodPool {
  /** One `InstancedMesh` per level, level 0 first. Not added to any scene: add them all yourself
   * (`rootScene.add(...pool.meshes)`), directly under the scene, since the selection reads each
   * instance's `Transform` as its world position. Each is owned by its entity in `meshEntityIds`,
   * which disposes it like `InstancedMeshPool.mesh`. */
  meshes: THREE.InstancedMesh[];
  meshEntityIds: number[];
  /** Spawns one entity per placement with `INSTANCED_MESH_SLOT` and `LOD`, starting in level 0's
   * mesh. Returns the created entity ids (fewer than `placements.length` past `maxInstances`). */
  spawn: (
    world: ECSWorld,
    placements: InstancePlacement[],
    entityOpts?: CoreEntityOpts
  ) => number[];
  /** Deletes an instance's entity, like `InstancedMeshPool.despawn`. */
  despawn: (world: ECSWorld, entityId: number) => boolean;
}

/**
 * An instanced pool with levels of detail (docs/plans/p348_ecs-lod-selection.md §4.2): one
 * `InstancedMesh` per level, and every instance in exactly one of them. Each instance entity has
 * `INSTANCED_MESH_SLOT` (pointing at its level's mesh) and `LOD`, so the engine's LOD selection
 * picks its level and moves it to that level's mesh (a swap-remove from the old one, an append to
 * the new one). A LOD-culled instance is in no mesh. One draw call per non-empty level.
 *
 * Every level mesh gets the bounds of every placement, at spawn: instances moving between levels
 * never change them, so they are never recomputed.
 */
export const createInstancedLodPool = (opts: CreateInstancedLodPoolOptions): InstancedLodPool => {
  const { world, levels: levelDefs, maxInstances, receiveShadow = true } = opts;
  if (levelDefs.length === 0) throw new Error('createInstancedLodPool: no levels.');
  for (let i = 1; i < levelDefs.length; i++) {
    if (levelDefs[i].screenSize >= levelDefs[i - 1].screenSize) {
      lwarn(
        `createInstancedLodPool: level ${i}'s screenSize (${levelDefs[i].screenSize}) isn't below level ${i - 1}'s (${levelDefs[i - 1].screenSize}). Levels go from level 0 down, screenSize descending.`
      );
    }
  }

  // Shared by every instance's LOD component, which reads it, never copies it
  const def: LodDef = {
    ...opts.lod,
    levels: levelDefs.map((level) => ({ screenSize: level.screenSize })),
  };
  const state: LodPoolState = { meshes: [], levels: [], liveCount: 0 };
  const meshEntityIds: number[] = [];
  // A level's local bounds: the union of every level's, so it covers whichever one is shown
  const localBox = new THREE.Box3();
  const localSphere = new THREE.Sphere();
  for (const level of levelDefs) {
    const castShadow = level.castShadow ?? true;
    const { mesh, meshEntityId } = createPoolMesh(
      world,
      level.geometry,
      level.material,
      maxInstances,
      castShadow,
      receiveShadow,
      opts.entityOpts
    );
    mesh.boundingBox = new THREE.Box3();
    mesh.boundingSphere = new THREE.Sphere();
    state.meshes.push(mesh);
    state.levels.push({ geometry: level.geometry, material: level.material, castShadow });
    meshEntityIds.push(meshEntityId);
    lodPoolsByMesh.set(mesh, state);

    if (!level.geometry.boundingBox) level.geometry.computeBoundingBox();
    if (!level.geometry.boundingSphere) level.geometry.computeBoundingSphere();
    localBox.union(level.geometry.boundingBox!);
    localSphere.union(level.geometry.boundingSphere!);
  }
  const level0Mesh = state.meshes[0];
  // The union of every placement's bounds so far, copied to each level mesh
  const box = new THREE.Box3();
  const sphere = new THREE.Sphere();

  const spawn: InstancedLodPool['spawn'] = (world, placements, entityOpts) => {
    const entityIds: number[] = [];
    const spatialDomain = getSpawnSpatialDomain(world, opts.spatialDomain, 'InstancedLodPool');

    for (const placement of placements) {
      if (state.liveCount >= maxInstances) {
        lwarn(
          `InstancedLodPool: maxInstances (${maxInstances}) reached — skipping remaining placements.`
        );
        break;
      }

      const { entityId, version } = createInstanceEntity(world, placement, entityOpts);
      box.union(_box.copy(localBox).applyMatrix4(_matrix));
      sphere.union(_sphere.copy(localSphere).applyMatrix4(_matrix));
      const index = appendInstance(level0Mesh, entityId, _matrix);
      world.addComponent(entityId, ComponentType.INSTANCED_MESH_SLOT, {
        mesh: level0Mesh,
        index,
        _lastVersion: version,
      });
      state.liveCount++;
      // After the slot, which the LOD target and the radius provider read
      const lod: LodData = { def, level: -1, applied: -1, radius: 0, _levels: [] };
      world.addComponent(entityId, ComponentType.LOD, lod);
      if (spatialDomain) joinSpatialDomain(entityId, spatialDomain, world);

      entityIds.push(entityId);
    }

    for (const mesh of state.meshes) {
      mesh.boundingBox!.copy(box);
      mesh.boundingSphere!.copy(sphere);
    }
    return entityIds;
  };

  const despawn: InstancedLodPool['despawn'] = (world, entityId) => {
    const slot = getSlot(entityId, world);
    if (!slot || lodPoolsByMesh.get(slot.mesh) !== state) return false;
    // The slot hook frees the slot
    world.deleteEntity(entityId);
    return true;
  };

  return { meshes: state.meshes, meshEntityIds, spawn, despawn };
};

/** Bakes each pooled entity's `Transform` into its `InstancedMesh` slot, skipping instances whose transform hasn't changed since the last bake (see `InstancedMeshSlotData._lastVersion`, mirroring `object3DSyncSystem`'s version-diff). */
export const instancedMeshPoolSyncSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.INSTANCED_MESH_SLOT);
  if (storage.size === 0) return;

  const dirtyMeshes = new Set<THREE.InstancedMesh>();

  for (const [entityId, slot] of storage) {
    // LOD culled: in no mesh (re-baked from its Transform when it comes back)
    if (slot.index < 0) continue;
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform || slot._lastVersion === transform.version) continue;

    _matrix.compose(transform.position, transform.quaternion, transform.scale);
    slot.mesh.setMatrixAt(slot.index, _matrix);
    slot._lastVersion = transform.version;
    dirtyMeshes.add(slot.mesh);
  }

  for (const dirtyMesh of dirtyMeshes) dirtyMesh.instanceMatrix.needsUpdate = true;
};

// Before LOD selection, which moves instances between level meshes with their baked matrices
ECSWorld.registerPlugin((world) => {
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'instancedMeshPoolSync',
    instancedMeshPoolSyncSystem,
    APP_RENDER_SYNC_ORDER.POSE_PRODUCERS
  );
  return world;
});
