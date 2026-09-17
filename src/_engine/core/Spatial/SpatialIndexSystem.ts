import * as THREE from 'three/webgpu';
import { ECSWorld } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { IS_DEBUG_ENV } from '../Config';
import { lwarn } from '../../utils/Logger';
import { MAX_SPOT_ANGLE } from '../ECS/ObjectFrustumCullingSystem';
import { ReadonlyVec3, SpatialGrid } from './SpatialGrid';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../../utils/helpers';

// Debug
type SpatialGridDebugModule = typeof import('../Debug/_dbg__SpatialGrid');
let debugGUI: DebugModuleRef<SpatialGridDebugModule> | null = null;

export const registerSpatialIndexDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../Debug/_dbg__SpatialGrid'));
  useDebug(debugGUI)?._createSpatialGridDebugGUI();
};

/**
 * ECS wiring for SpatialGrid (docs/plans/_DONE_p050_spatial-index.md §3, §8). One
 * dynamic grid per ECS world, lazily created on first SPATIAL_INDEXED
 * member, kept current every frame. First consumer: LightObjectCullingSystem.ts.
 */

const gridsByWorld = new WeakMap<ECSWorld, SpatialGrid>();
const cellSizeByWorld = new WeakMap<ECSWorld, number>();

// Starting guess pending real tuning data — §9's occupancy histogram (see
// _dbg__SpatialGrid.ts) is what should actually decide this, not a guess
// made ahead of a consumer.
const DEFAULT_CELL_SIZE = 20;

function ensureGrid(world: ECSWorld): SpatialGrid {
  let grid = gridsByWorld.get(world);
  if (!grid) {
    grid = new SpatialGrid({
      cellSize: cellSizeByWorld.get(world) ?? DEFAULT_CELL_SIZE,
      maxMembers: world.maxEntities,
    });
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
 * Debug tooling only (§9) — replaces `world`'s grid with a freshly sized
 * one and re-inserts every current SPATIAL_INDEXED member. A live "change
 * cell size, see it rebuild" control has no cheaper path than this: cell
 * size is baked into the CSR layout at construction (§2.3).
 */
export function setSpatialGridCellSize(world: ECSWorld, cellSize: number): void {
  cellSizeByWorld.set(world, cellSize);
  const grid = new SpatialGrid({ cellSize, maxMembers: world.maxEntities });
  gridsByWorld.set(world, grid);

  const storage = world.getStorage(ComponentType.SPATIAL_INDEXED);
  for (const [entityId] of storage) {
    const pos = world.getPosition(entityId);
    grid.addMember(
      entityId,
      pos?.x ?? 0,
      pos?.y ?? 0,
      pos?.z ?? 0,
      computeSpatialRadius(entityId, world)
    );
  }
  grid.rebuild();
}

/**
 * A point/spot light's influence-sphere radius — shared with
 * LightObjectCullingSystem.ts so both consumers agree on what "this light's
 * volume" means. Kept separate from ObjectFrustumCullingSystem.ts's own
 * `computeIsVisible` (which only ever needs a boolean, not the radius
 * itself) rather than touching that already-shipped system.
 */
export function computeLightInfluenceRadius(light: THREE.PointLight | THREE.SpotLight): number {
  // distance === 0 is Three.js's own convention for "never attenuate / infinite
  // range" (see ObjectFrustumCullingSystem.ts) — Infinity forces this light into
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
            `index (docs/plans/_DONE_p050_spatial-index.md §3.1).`
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

// Debug tooling only (§9) — last rebuild's wall-clock cost, for _dbg__SpatialGrid.ts.
const lastRebuildMsByWorld = new WeakMap<ECSWorld, number>();
export function getLastRebuildDurationMs(world: ECSWorld): number {
  return lastRebuildMsByWorld.get(world) ?? 0;
}

/** Refreshes every member's position and rebuilds the grid. Registered last in APP_POST_PHYSICS (§8) so APP_LOGIC/APP_RENDER_SYNC consumers see a current snapshot. */
export const spatialIndexRebuildSystem = (world: ECSWorld) => {
  const grid = gridsByWorld.get(world);
  if (!grid) return; // nothing has opted in yet in this world

  const storage = world.getStorage(ComponentType.SPATIAL_INDEXED);
  for (const [entityId] of storage) {
    const pos = world.getPosition(entityId);
    if (pos) grid.updatePosition(entityId, pos.x, pos.y, pos.z);
  }

  const start = IS_DEBUG_ENV ? performance.now() : 0;
  grid.rebuild();
  if (IS_DEBUG_ENV) lastRebuildMsByWorld.set(world, performance.now() - start);
};

// --- BRUTE-FORCE ORACLE (§9) ---
// Debug-only cross-check that the grid's candidates for a query are a
// superset of an exact distance test — never the reverse, since the grid's
// candidates are conservative by design (§7's "candidates, not results").
// Opt-in per world via setSpatialGridOracleEnabled, surfaced in
// _dbg__SpatialGrid.ts; a no-op call in production (IS_DEBUG_ENV-gated).

const oracleEnabledByWorld = new WeakMap<ECSWorld, boolean>();
const oracleMismatchCountByWorld = new WeakMap<ECSWorld, number>();

export function setSpatialGridOracleEnabled(world: ECSWorld, enabled: boolean): void {
  oracleEnabledByWorld.set(world, enabled);
  oracleMismatchCountByWorld.set(world, 0);
}

export function isSpatialGridOracleEnabled(world: ECSWorld): boolean {
  return oracleEnabledByWorld.get(world) ?? false;
}

export function getOracleMismatchCount(world: ECSWorld): number {
  return oracleMismatchCountByWorld.get(world) ?? 0;
}

/** The true "within range" set, computed by iterating every SPATIAL_INDEXED member directly — the thing the grid is trying to approximate cheaply. */
function bruteForceQuery(world: ECSWorld, p: ReadonlyVec3, r: number): Set<number> {
  const result = new Set<number>();
  const storage = world.getStorage(ComponentType.SPATIAL_INDEXED);
  for (const [entityId] of storage) {
    const pos = world.getPosition(entityId);
    if (!pos) continue;
    const radius = computeSpatialRadius(entityId, world);
    const dx = pos.x - p.x;
    const dy = pos.y - p.y;
    const dz = pos.z - p.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= r + radius) result.add(entityId);
  }
  return result;
}

/**
 * Call after a real `queryVisit`/`queryInto` call, when `isSpatialGridOracleEnabled`
 * is true, to validate that call's result. No-op unless both `IS_DEBUG_ENV`
 * and the oracle are on for `world` — safe to call unconditionally from a
 * hot path.
 */
export function validateSpatialGridQuery(world: ECSWorld, p: ReadonlyVec3, r: number): void {
  if (!IS_DEBUG_ENV || !isSpatialGridOracleEnabled(world)) return;

  const exact = bruteForceQuery(world, p, r);
  const found = new Set<number>();
  getSpatialGrid(world).queryVisit(p, r, (id) => found.add(id));

  for (const id of exact) {
    if (!found.has(id)) {
      oracleMismatchCountByWorld.set(world, getOracleMismatchCount(world) + 1);
      lwarn(
        `SpatialGrid oracle: entity ${id} is within range of query ` +
          `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) r=${r.toFixed(2)} but the ` +
          `grid's candidates missed it — see docs/plans/_DONE_p050_spatial-index.md §9.`
      );
    }
  }
}

ECSWorld.registerPlugin((world) => {
  // order: -1, matching objectFrustumCullingSystem's precedent — runs after this
  // stage's default-order (0) systems, in particular physicsToTransformSystem,
  // so it rebuilds from this frame's final transforms, not last frame's.
  world.addSystem(
    ECSSystemStage.APP_POST_PHYSICS,
    'spatialIndexRebuildSystem',
    spatialIndexRebuildSystem,
    -1
  );
});
