import * as THREE from 'three/webgpu';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import { createMeshEntity, type MeshProps } from '../../_engine/core/MeshManager';
import { ComponentType } from '../../_engine/core/ECS/ECSCoreComponents';
import { getECSWorld } from '../../_engine/core/ECS';
import type { CoreEntityOpts } from '../../_engine/schemas/_helperSchemas';
import { createSeededRandom } from './seededRandom';

/**
 * `MeshSurfaceSampler.setRandomGenerator` exists at runtime (three@0.183.2's
 * examples/jsm) but is missing from the `@types/three` declarations bundled here —
 * this narrows the cast to just the one extra method instead of reaching for `any`.
 */
interface SeedableMeshSurfaceSampler extends MeshSurfaceSampler {
  setRandomGenerator(randomFunction: () => number): this;
}

export interface ScatterPlacement {
  position: THREE.Vector3;
  /** World-space surface normal at the sampled point (mesh-local normal transformed by the surface's world matrix). */
  normal: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
}

export interface ScatterOptions {
  /**
   * The mesh whose surface to scatter across. This is the same primitive for "scatter
   * across a terrain" and "scatter on the surface of another object" (a rock, a roof, a
   * wall) — both are just a `THREE.Mesh` surface to sample, so one function covers both
   * cases the request asked for.
   */
  surface: THREE.Mesh;
  count: number;
  seed?: number;
  /**
   * Minimum spacing between accepted points, in world units. Enforced by rejection-sampling
   * against previously accepted points (bounded by `maxAttemptsPerPoint`) — a cheap
   * approximation of blue-noise/Poisson-disc spacing, not exact, and O(n^2) in the number of
   * accepted points. Fine for a first pass at scene-build-time entity counts; if scatter
   * counts grow large enough for this to matter, bucket accepted points into a grid (the
   * same idea as `docs/plans/p050_spatial-index.md`'s `SpatialGrid`) instead of scanning all
   * of them. 0 (default) disables spacing entirely (pure random, may cluster/overlap).
   */
  minSpacing?: number;
  /** Max resample attempts per point when `minSpacing` is set, before giving up on that slot. */
  maxAttemptsPerPoint?: number;
  /** Uniform scale range; one random value is picked per placement. Defaults to no scale variance. */
  scaleRange?: [number, number];
  /**
   * Align the placement's up axis to the sampled surface normal (e.g. moss/debris on a
   * sloped rock) instead of always facing world-up (the common case for trees/foliage that
   * should stand upright even on sloped terrain). Defaults to false (world-up).
   */
  alignToNormal?: boolean;
  /** Randomize rotation around the up axis. Defaults to true. */
  randomYRotation?: boolean;
}

const _worldPosition = new THREE.Vector3();
const _worldNormal = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _yRotation = new THREE.Quaternion();
const _normalMatrix = new THREE.Matrix3();

/**
 * Scatters `count` points across a mesh's surface using area-weighted random sampling
 * (`MeshSurfaceSampler`, shipped with three's examples/jsm — no new dependency, same import
 * style already used for `mergeGeometries` elsewhere in this repo). Returns placement data
 * only; use `bakeScatterToInstancedMesh` (bulk, e.g. foliage) or `spawnScatterAsMeshEntities`
 * (individual ECS entities, e.g. a handful of static props) to actually place something.
 *
 * Physics is intentionally out of scope here (see docs/plans/p090_large-ecs-test-world-scene.md
 * §1.3) — this only computes where things go, not what collides with them. Once
 * `PhysicsAPI.ts` lands, a caller can use each placement's `position`/`normal` to add a
 * collider without this function needing to change.
 */
export const scatterOnSurface = (opts: ScatterOptions): ScatterPlacement[] => {
  const {
    surface,
    count,
    seed = 1,
    minSpacing = 0,
    maxAttemptsPerPoint = 30,
    scaleRange = [1, 1],
    alignToNormal = false,
    randomYRotation = true,
  } = opts;

  const random = createSeededRandom(seed);
  const sampler = new MeshSurfaceSampler(surface) as SeedableMeshSurfaceSampler;
  sampler.setRandomGenerator(random);
  sampler.build();

  surface.updateWorldMatrix(true, false);
  _normalMatrix.getNormalMatrix(surface.matrixWorld);

  const placements: ScatterPlacement[] = [];
  const minSpacingSq = minSpacing * minSpacing;
  const attemptsPerPoint = minSpacing > 0 ? maxAttemptsPerPoint : 1;

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < attemptsPerPoint; attempt++) {
      sampler.sample(_worldPosition, _worldNormal);
      _worldPosition.applyMatrix4(surface.matrixWorld);
      _worldNormal.applyMatrix3(_normalMatrix).normalize();

      if (minSpacing > 0) {
        let tooClose = false;
        for (const existing of placements) {
          if (existing.position.distanceToSquared(_worldPosition) < minSpacingSq) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
      }

      const upAxis = alignToNormal ? _worldNormal : _up;
      const quaternion = new THREE.Quaternion().setFromUnitVectors(_up, upAxis);
      if (randomYRotation) {
        _yRotation.setFromAxisAngle(_up, random() * Math.PI * 2);
        quaternion.multiply(_yRotation);
      }

      const scale = THREE.MathUtils.lerp(scaleRange[0], scaleRange[1], random());

      placements.push({
        position: _worldPosition.clone(),
        normal: _worldNormal.clone(),
        quaternion,
        scale,
      });
      break;
      // If every attempt fails, this slot is simply skipped — a first-pass scatterer may
      // return fewer than `count` placements under tight `minSpacing`, which is an
      // acceptable outcome to refine later rather than a bug to fix now.
    }
  }

  return placements;
};

/**
 * Bakes placements into an existing `InstancedMesh`'s matrices, starting at `startIndex`.
 * The bulk/foliage path: an instance matrix already encodes position + rotation + scale, so
 * this sidesteps the fact that neither `MeshProps`/mesh JSON nor the ECS `Transform` helpers
 * expose a per-entity scale today (see docs/plans/p090_large-ecs-test-world-scene.md §1.1).
 * Does not create any ECS entities — pair with the instancing pattern in
 * `src/_engine/utils/ECSStressTest.ts` if per-instance ECS state is needed later.
 * Returns the next free index.
 */
export const bakeScatterToInstancedMesh = (
  mesh: THREE.InstancedMesh,
  placements: ScatterPlacement[],
  startIndex = 0
): number => {
  const matrix = new THREE.Matrix4();
  const scaleVector = new THREE.Vector3();
  let index = startIndex;

  for (const placement of placements) {
    scaleVector.setScalar(placement.scale);
    matrix.compose(placement.position, placement.quaternion, scaleVector);
    mesh.setMatrixAt(index, matrix);
    index++;
  }

  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return index;
};

export interface SpawnScatterMeshOptions {
  geo: MeshProps['geo'];
  mat: MeshProps['mat'];
  castShadow?: boolean;
  receiveShadow?: boolean;
  entityOpts?: CoreEntityOpts;
}

/**
 * Spawns one individual mesh entity per placement via `createMeshEntity` — simple and
 * individually ECS-addressable, but does not scale to thousands of instances; prefer
 * `bakeScatterToInstancedMesh` for large foliage/tree counts. Good fit for a handful of
 * scattered static props. Scale is applied directly to the created `Object3D` after
 * creation (see `bakeScatterToInstancedMesh`'s doc comment for why).
 */
export const spawnScatterAsMeshEntities = (
  placements: ScatterPlacement[],
  opts: SpawnScatterMeshOptions
): number[] => {
  const world = getECSWorld();
  const entityIds: number[] = [];

  for (const placement of placements) {
    const entityId = createMeshEntity(
      {
        geo: opts.geo,
        mat: opts.mat,
        castShadow: opts.castShadow,
        receiveShadow: opts.receiveShadow,
        position: { x: placement.position.x, y: placement.position.y, z: placement.position.z },
        quaternion: placement.quaternion,
      },
      opts.entityOpts,
      world
    );

    if (placement.scale !== 1) {
      const object3D = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
      object3D?.scale.setScalar(placement.scale);
    }

    entityIds.push(entityId);
  }

  return entityIds;
};
