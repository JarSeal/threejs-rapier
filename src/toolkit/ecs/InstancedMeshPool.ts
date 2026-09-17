/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import type { ECSWorld } from '../../_engine/core/ECS';
import { CoreComponentType } from '../../_engine/core/ECS/ECSRegistry';
import { ECSSystemStage } from '../../AppECSRegistry';
import { lwarn } from '../../_engine/utils/Logger';
import type { CoreEntityOpts } from '../../_engine/schemas/_helperSchemas';
import type { ScatterPlacement } from '../geometry/scatterOnSurface';

// --- src/toolkit/ecs/InstancedMeshPool.ts ---
//
// Only type-only imports from `_engine/core/ECS` here (never `getECSWorld`/`getRootScene` as
// values) — this file is imported by `AppECSRegistry.ts` (to register `InstancedMeshPoolComponentType`,
// same seam `HoverEffect.ts` uses for `HoverToolComponentType`), which is itself imported by
// `ECS/ECSCoreComponents.ts`, which `ECS.ts`/`Scene.ts` import — a value import of either here
// would close that loop. `world`/`scene` are always passed in by the caller instead of resolved
// internally, and the app-specific component type is accessed via its own local enum (cast
// `as any` at the ECS-world call sites) rather than the merged `ComponentType`, exactly like
// `HoverEffect.ts` does for the same reason.

/** Internal Key (Values) */
export enum InstancedMeshPoolComponentType {
  INSTANCED_MESH_SLOT = 'TOOLKIT_INSTANCED_MESH_SLOT',
}

/** Internal Data Shape (Types) */
export interface InstancedMeshSlotData {
  mesh: THREE.InstancedMesh;
  index: number;
  /** Last `Transform.version` baked into `mesh`'s instance matrix — skips the write once a
   * (typically static, e.g. foliage) instance's transform stops changing. */
  _lastVersion: number;
}

export interface InstancedMeshPoolComponentData {
  [InstancedMeshPoolComponentType.INSTANCED_MESH_SLOT]: InstancedMeshSlotData;
}

export interface CreateInstancedMeshPoolOptions {
  geometry: THREE.BufferGeometry;
  /** A material array (with a matching-length `geometry.groups`) works the same as on a plain `Mesh` — see `generateTreeGeometry`'s `materialGroups`. */
  material: THREE.Material | THREE.Material[];
  /** Hard cap on live instances this pool can ever hold — sized once, like `ECSStressTest.ts`'s `MAX_INSTANCES`. */
  maxInstances: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export interface InstancedMeshPool {
  /** Not added to any scene yet — add `pool.mesh` to the scene yourself (mirrors `bakeScatterToInstancedMesh`, which likewise never touches the scene graph). */
  mesh: THREE.InstancedMesh;
  /**
   * Spawns one ECS entity per placement, holding a slot index into `mesh` (the pattern used by
   * `src/_engine/utils/ECSStressTest.ts`'s instanced mode) — per-instance-addressable via ECS,
   * rather than `bakeScatterToInstancedMesh`'s fire-and-forget matrix writes. Returns the
   * created entity ids (fewer than `placements.length` if the pool's `maxInstances` is reached).
   */
  spawn: (world: ECSWorld, placements: ScatterPlacement[], entityOpts?: CoreEntityOpts) => number[];
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
const _matrix = new THREE.Matrix4();

export const createInstancedMeshPool = (
  opts: CreateInstancedMeshPoolOptions
): InstancedMeshPool => {
  const { geometry, material, maxInstances, castShadow = true, receiveShadow = true } = opts;

  const mesh = new THREE.InstancedMesh(geometry, material, maxInstances);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  mesh.count = 0;

  let nextIndex = 0;

  const spawn: InstancedMeshPool['spawn'] = (world, placements, entityOpts) => {
    const entityIds: number[] = [];

    for (const placement of placements) {
      if (nextIndex >= maxInstances) {
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

      const index = nextIndex++;
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
      mesh.count = nextIndex;

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

  return { mesh, spawn };
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
