import * as THREE from 'three/webgpu';
import { ECSWorld } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { IS_DEBUG_ENV } from '../Config';
import { lwarn } from '../../utils/Logger';
import { MAX_SPOT_ANGLE } from '../ECS/LightFrustumCullingSystem';
import { SpatialGrid } from './SpatialGrid';

/**
 * ECS wiring for SpatialGrid (docs/plans/p050_spatial-index.md §3, §8). One
 * dynamic grid per ECS world, lazily created on first SPATIAL_INDEXED
 * member, kept current every frame. First consumer: LightObjectCullingSystem.ts.
 */

const gridsByWorld = new WeakMap<ECSWorld, SpatialGrid>();

// Placeholder pending real tuning data — §9's occupancy histogram (Phase 3)
// is what should actually decide this, not a guess made ahead of a consumer.
const DEFAULT_CELL_SIZE = 20;

function ensureGrid(world: ECSWorld): SpatialGrid {
  let grid = gridsByWorld.get(world);
  if (!grid) {
    grid = new SpatialGrid({ cellSize: DEFAULT_CELL_SIZE, maxMembers: world.maxEntities });
    gridsByWorld.set(world, grid);
  }
  return grid;
}

/**
 * The dynamic spatial index for `world`. Lazily created on first use so a
 * world that never opts anything in never pays for one.
 */
export function getSpatialGrid(world: ECSWorld): SpatialGrid {
  return ensureGrid(world);
}

/**
 * A point/spot light's influence-sphere radius — shared with
 * LightObjectCullingSystem.ts so both consumers agree on what "this light's
 * volume" means. Kept separate from LightFrustumCullingSystem.ts's own
 * `computeIsVisible` (which only ever needs a boolean, not the radius
 * itself) rather than touching that already-shipped system.
 */
export function computeLightInfluenceRadius(light: THREE.PointLight | THREE.SpotLight): number {
  // distance === 0 is Three.js's own convention for "never attenuate / infinite
  // range" (see LightFrustumCullingSystem.ts) — Infinity forces this light into
  // the grid's oversized tier, where it's always a candidate everywhere.
  if (light.distance === 0) return Infinity;
  if (light instanceof THREE.SpotLight) {
    if (light.angle > MAX_SPOT_ANGLE) return Infinity;
    return light.distance / Math.cos(light.angle);
  }
  return light.distance;
}

function computeSpatialRadius(entityId: number, world: ECSWorld): number {
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;

  if (obj instanceof THREE.Mesh) {
    const geometry = obj.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const localRadius = geometry.boundingSphere?.radius ?? 0;
    const maxScale = Math.max(Math.abs(obj.scale.x), Math.abs(obj.scale.y), Math.abs(obj.scale.z));
    return localRadius * maxScale;
  }

  if (obj instanceof THREE.PointLight || obj instanceof THREE.SpotLight) {
    return computeLightInfluenceRadius(obj);
  }

  return 0;
}

ECSWorld.registerComponentHooks(ComponentType.SPATIAL_INDEXED, {
  onAddComponent: (entityId, world) => {
    if (IS_DEBUG_ENV) {
      const isAmbient = world.hasComponent(entityId, ComponentType.TAG_IS_AMBIENT_LIGHT);
      const isHemisphere = world.hasComponent(entityId, ComponentType.TAG_IS_HEMISPHERE_LIGHT);
      if (isAmbient || isHemisphere) {
        lwarn(
          `SpatialIndex: entity ${entityId} opted in but is an ` +
            `${isAmbient ? 'ambient' : 'hemisphere'} light — it has no meaningful position to ` +
            `index (docs/plans/p050_spatial-index.md §3.1).`
        );
      }
    }
    const pos = world.getPosition(entityId);
    const radius = computeSpatialRadius(entityId, world);
    ensureGrid(world).addMember(entityId, pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0, radius);
  },
  onRemoveComponent: (entityId, world) => {
    gridsByWorld.get(world)?.removeMember(entityId);
  },
  onDeleteEntity: (entityId, world) => {
    gridsByWorld.get(world)?.removeMember(entityId);
  },
});

/** Refreshes every member's position and rebuilds the grid. Registered last in APP_POST_PHYSICS (§8) so APP_LOGIC/APP_RENDER_SYNC consumers see a current snapshot. */
export const spatialIndexRebuildSystem = (world: ECSWorld) => {
  const grid = gridsByWorld.get(world);
  if (!grid) return; // nothing has opted in yet in this world

  const storage = world.getStorage(ComponentType.SPATIAL_INDEXED);
  for (const [entityId] of storage) {
    const pos = world.getPosition(entityId);
    if (pos) grid.updatePosition(entityId, pos.x, pos.y, pos.z);
  }
  grid.rebuild();
};

ECSWorld.registerPlugin((world) => {
  // order: -1, matching lightFrustumCullingSystem's precedent — runs after this
  // stage's default-order (0) systems, in particular physicsToTransformSystem,
  // so it rebuilds from this frame's final transforms, not last frame's.
  world.addSystem(
    ECSSystemStage.APP_POST_PHYSICS,
    'spatialIndexRebuildSystem',
    spatialIndexRebuildSystem,
    -1
  );
});
