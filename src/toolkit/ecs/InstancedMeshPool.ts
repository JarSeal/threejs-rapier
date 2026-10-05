/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import { ECSWorld } from '../../_engine/core/ECS';
import { CoreComponentType } from '../../_engine/core/ECS/ECSRegistry';
import { ECSSystemStage } from '../../AppECSRegistry';
import { lwarn } from '../../_engine/utils/Logger';
import type { CoreEntityOpts } from '../../_engine/schemas/_helperSchemas';
import type { ScatterPlacement } from '../geometry/scatterOnSurface';
import {
  DEFAULT_SPATIAL_DOMAIN,
  getConservativeGeometryRadius,
  getSpatialDomain,
  joinSpatialDomain,
  registerSpatialRadiusProvider,
} from '../../_engine/core/Spatial/SpatialIndexSystem';
import {
  InstancedMeshPoolComponentType,
  type InstancedMeshSlotData,
} from './InstancedMeshPoolTypes';

// --- src/toolkit/ecs/InstancedMeshPool.ts ---
//
// The component keys and data live in InstancedMeshPoolTypes.ts, which `AppECSRegistry.ts`
// imports, so this file stays out of the ECSCoreComponents ↔ AppECSRegistry import cycle. The
// component type is accessed via its own local enum (cast `as any` at the ECS-world call sites)
// rather than the merged `ComponentType`, like `HoverEffect.ts` does.

export * from './InstancedMeshPoolTypes';

// A pool instance's spatial radius (docs/plans/_DONE_p346_spatial-domains.md §3.3): the pool
// geometry's, scaled by the instance's Transform. Registered here so the engine never imports
// the toolkit.
registerSpatialRadiusProvider(
  InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT as any,
  (entityId, world) => {
    const slot = world.getComponent(
      entityId,
      InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT as any
    ) as InstancedMeshSlotData | undefined;
    return slot ? getConservativeGeometryRadius(slot.mesh.geometry) : undefined;
  }
);

const _matrix = new THREE.Matrix4();
const _color = new THREE.Color();

// Slot → entity per pooled mesh (docs/plans/p348_ecs-lod-selection.md §4.2): freeing a slot moves
// the mesh's last instance into it and patches that instance's entity. Keyed by mesh, not by
// pool, so a pool with several meshes (one per LOD level) shares the same swap-remove. Entity ids
// can be negative int32s (the generation is in the high bits), which Int32Array holds exactly.
const slotEntitiesByMesh = new WeakMap<THREE.InstancedMesh, Int32Array>();

/** Frees `entityId`'s slot with a swap-remove: the last instance's matrix (and colour) moves into
 * it, so the drawn range stays `0..count-1`. A no-op for a slot already freed. The mesh's bounds
 * aren't recomputed: they only shrink, so the old ones stay conservative. */
const freeInstanceSlot = (entityId: number, world: ECSWorld) => {
  const slot = world.getComponent(
    entityId,
    InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT as any
  ) as InstancedMeshSlotData | undefined;
  if (!slot) return;
  const { mesh, index } = slot;
  const slotEntities = slotEntitiesByMesh.get(mesh);
  if (!slotEntities || index >= mesh.count || slotEntities[index] !== entityId) return;

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
    const movedSlot = world.getComponent(
      movedId,
      InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT as any
    ) as InstancedMeshSlotData | undefined;
    if (movedSlot) movedSlot.index = index;
  }
  mesh.count = last;
  mesh.instanceMatrix.needsUpdate = true;
};

// onRemoveComponent too, so removing the slot directly can't leave its matrix drawn
ECSWorld.registerComponentHooks(InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT as any, {
  onRemoveComponent: freeInstanceSlot,
  onDeleteEntity: freeInstanceSlot,
});

export interface CreateInstancedMeshPoolOptions {
  /** Used to create one dedicated ECS entity that owns `mesh` itself (distinct from the
   * per-instance slot entities `spawn()` creates) — see `InstancedMeshPool.mesh`'s doc comment. */
  world: ECSWorld;
  geometry: THREE.BufferGeometry;
  /** A material array (with a matching-length `geometry.groups`) works the same as on a plain `Mesh` — see `generateTreeGeometry`'s `materialGroups`. */
  material: THREE.Material | THREE.Material[];
  /** Hard cap on live instances this pool can hold at once — sized once, like `ECSStressTest.ts`'s `MAX_INSTANCES`. Despawning frees a slot for a later spawn. */
  maxInstances: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Passed to the mesh's own owning entity (e.g. to mark a long-lived pool `persistent`). */
  entityOpts?: CoreEntityOpts;
  /** A registered spatial domain `spawn()` joins every instance to (docs/plans/_DONE_p346_spatial-domains.md). Default: none. */
  spatialDomain?: string;
}

export interface InstancedMeshPool {
  /** Not added to any scene yet — add `pool.mesh` to the scene yourself (mirrors `bakeScatterToInstancedMesh`, which likewise never touches the scene graph). `mesh` is still owned by `meshEntityId`
   * (holding `OBJECT3D`/`TAG_IS_MESH`, like any plain mesh entity), so `MeshManager`'s existing
   * `TAG_IS_MESH` `onDeleteEntity` hook removes it from wherever it was added and disposes it once
   * that entity is deleted (e.g. by `ECSWorld.clearNonPersistent()` on scene switch) — without this,
   * the shared mesh would silently outlive every scene that created it. */
  mesh: THREE.InstancedMesh;
  /** The entity that owns `mesh` for lifecycle purposes (see `mesh`'s doc comment above). */
  meshEntityId: number;
  /**
   * Spawns one ECS entity per placement, holding a slot index into `mesh` (the pattern used by
   * `src/_engine/utils/ECSStressTest.ts`'s instanced mode) — per-instance-addressable via ECS,
   * rather than `bakeScatterToInstancedMesh`'s fire-and-forget matrix writes. Returns the
   * created entity ids (fewer than `placements.length` if the pool's `maxInstances` is reached).
   */
  spawn: (world: ECSWorld, placements: ScatterPlacement[], entityOpts?: CoreEntityOpts) => number[];
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
 * `instancedMeshPoolSyncSystem`. Modeled on `ECSStressTest.ts`'s instanced mode, generalized
 * for reuse (e.g. the foliage/tree instancing in
 * docs/plans/p090_large-ecs-test-world-scene.md §3 Phase 3) rather than tied to one debug
 * stress-test scene.
 */
export const createInstancedMeshPool = (
  opts: CreateInstancedMeshPoolOptions
): InstancedMeshPool => {
  const { world, geometry, material, maxInstances, castShadow = true, receiveShadow = true } = opts;

  const mesh = new THREE.InstancedMesh(geometry, material, maxInstances);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  mesh.count = 0;

  // Only `CoreComponentType` (never `ComponentType` from `ECSCoreComponents.ts`) per this file's
  // top-of-file import note — same string keys ('CORE_OBJECT3D'/'CORE_TAG_IS_MESH'), so
  // `MeshManager`'s globally-registered `TAG_IS_MESH` hook still fires for this entity.
  const meshEntityId = world.createEntity(opts.entityOpts);
  world.addComponent(meshEntityId, CoreComponentType.OBJECT3D as any, {
    value: mesh,
    _lastVersion: -1,
  });
  world.addComponent(meshEntityId, CoreComponentType.TAG_IS_MESH as any, true);

  const slotEntities = new Int32Array(maxInstances);
  slotEntitiesByMesh.set(mesh, slotEntities);

  const spawn: InstancedMeshPool['spawn'] = (world, placements, entityOpts) => {
    const entityIds: number[] = [];

    let spatialDomain = opts.spatialDomain;
    if (
      spatialDomain &&
      spatialDomain !== DEFAULT_SPATIAL_DOMAIN &&
      !getSpatialDomain(world, spatialDomain)
    ) {
      // Checked once here, or joinSpatialDomain would warn for every instance
      lwarn(
        `InstancedMeshPool: spatial domain '${spatialDomain}' isn't registered — the instances ` +
          `aren't indexed (register it with registerSpatialDomain before spawning).`
      );
      spatialDomain = undefined;
    }

    for (const placement of placements) {
      if (mesh.count >= maxInstances) {
        lwarn(
          `InstancedMeshPool: maxInstances (${maxInstances}) reached — skipping remaining placements.`
        );
        break;
      }

      const entityId = world.createEntity(entityOpts);
      const transform = world.getComponent(entityId, CoreComponentType.TRANSFORM)!;
      transform.position.copy(placement.position);
      transform.quaternion.copy(placement.quaternion);
      transform.scale.setScalar(placement.scale);
      transform.setDirty();
      // Required for the mutation to persist in TYPED_ARRAY storage mode (getComponent can
      // return a disconnected, freshly materialized copy there) — see ECSWorld.commitTransform's
      // doc comment. Harmless in the default MAP mode, where it re-sets the same reference.
      world.commitTransform(entityId, transform);

      const index = mesh.count;
      // Baked synchronously (not left to instancedMeshPoolSyncSystem's next tick) so
      // computeBoundingSphere() below sees real placement data immediately, and so nothing
      // flashes at the pool's default (identity, i.e. world-origin) matrix for one frame.
      _matrix.compose(transform.position, transform.quaternion, transform.scale);
      mesh.setMatrixAt(index, _matrix);

      world.addComponent(entityId, InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT as any, {
        mesh,
        index,
        _lastVersion: transform.version,
      });
      slotEntities[index] = entityId;
      mesh.count = index + 1;
      // After the slot, which its radius provider reads
      if (spatialDomain) joinSpatialDomain(entityId, spatialDomain, world);

      entityIds.push(entityId);
    }

    mesh.instanceMatrix.needsUpdate = true;
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
    const slot = world.getComponent(
      entityId,
      InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT as any
    ) as InstancedMeshSlotData | undefined;
    if (!slot || slot.mesh !== mesh) return false;
    // The slot hook frees the slot
    world.deleteEntity(entityId);
    return true;
  };

  return { mesh, meshEntityId, spawn, despawn };
};

/** Bakes each pooled entity's `Transform` into its `InstancedMesh` slot, skipping instances whose transform hasn't changed since the last bake (see `InstancedMeshSlotData._lastVersion`, mirroring `object3DSyncSystem`'s version-diff). */
export const instancedMeshPoolSyncSystem = (world: ECSWorld) => {
  const storage = world.getStorage(InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT as any);
  if (storage.size === 0) return;

  const dirtyMeshes = new Set<THREE.InstancedMesh>();

  for (const [entityId, slot] of storage) {
    const transform = world.getComponent(entityId, CoreComponentType.TRANSFORM);
    if (!transform || slot._lastVersion === transform.version) continue;

    _matrix.compose(transform.position, transform.quaternion, transform.scale);
    slot.mesh.setMatrixAt(slot.index, _matrix);
    slot._lastVersion = transform.version;
    dirtyMeshes.add(slot.mesh);
  }

  for (const dirtyMesh of dirtyMeshes) dirtyMesh.instanceMatrix.needsUpdate = true;
};

/** The Registration Helper */
export const registerInstancedMeshPoolEffect = (world: ECSWorld) => {
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'instancedMeshPoolSync',
    instancedMeshPoolSyncSystem
  );
  return world;
};
