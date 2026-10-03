import * as THREE from 'three/webgpu';
import { ECSWorld, getECSWorld } from '../ECS';
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
 * ECS wiring for SpatialGrid (docs/plans/_DONE_p050_spatial-index.md §3, §8). Each ECS world
 * holds named spatial domains (docs/plans/p346_spatial-domains.md §3.1): separate grids, each
 * with its own cell size, capacity and update policy. `DEFAULT` is created lazily on its first
 * SPATIAL_INDEXED member and is the one LightObjectCullingSystem.ts queries.
 *
 * A domain's grid instance is replaced when the domain is re-registered with other settings, so
 * read it with `getSpatialDomain`/`getSpatialGrid` where it's used instead of keeping it.
 */

/** How a domain's grid is kept current. `DYNAMIC`: positions refreshed and the grid rebuilt every frame. */
export type SpatialUpdatePolicy = 'DYNAMIC';

export interface SpatialDomainOptions {
  id: string;
  /** World-space edge length of one grid cell. */
  cellSize: number;
  /** How many members the domain can hold at once. */
  maxMembers: number;
  /** Default `DYNAMIC`. */
  update?: SpatialUpdatePolicy;
  /** See SpatialGridOptions (default 2). */
  oversizedRadiusMultiplier?: number;
}

/** The domain SPATIAL_INDEXED entities are members of. */
export const DEFAULT_SPATIAL_DOMAIN = 'DEFAULT';

// Starting guess pending real tuning data — §9's occupancy histogram (see
// _dbg__SpatialGrid.ts) is what should actually decide this, not a guess
// made ahead of a consumer.
const DEFAULT_CELL_SIZE = 20;

/** Bits 0-30 of SPATIAL_DOMAINS' mask, so the mask stays a small positive integer. */
const MAX_NON_DEFAULT_DOMAINS = 31;

type SpatialDomain = {
  readonly id: string;
  /** This domain's bit in SPATIAL_DOMAINS' mask; -1 for DEFAULT, whose membership is SPATIAL_INDEXED. */
  readonly bit: number;
  opts: Required<SpatialDomainOptions>;
  grid: SpatialGrid;
  hasWarnedFull: boolean;
  /** Debug env only — the last rebuild's wall-clock cost, for _dbg__SpatialGrid.ts. */
  lastRebuildMs: number;
};

type WorldDomains = {
  /** Registration order, which is also the rebuild order. */
  list: SpatialDomain[];
  byId: Map<string, SpatialDomain>;
  /** The non-default domains, by mask bit. */
  byBit: SpatialDomain[];
};

const domainsByWorld = new WeakMap<ECSWorld, WorldDomains>();

const resolveDomainOptions = (opts: SpatialDomainOptions): Required<SpatialDomainOptions> => {
  if (!(opts.cellSize > 0) || !Number.isFinite(opts.cellSize)) {
    throw new Error(`Spatial domain '${opts.id}': cellSize must be a positive number.`);
  }
  if (!(opts.maxMembers >= 1)) {
    throw new Error(`Spatial domain '${opts.id}': maxMembers must be at least 1.`);
  }
  return {
    id: opts.id,
    cellSize: opts.cellSize,
    maxMembers: Math.floor(opts.maxMembers),
    update: opts.update ?? 'DYNAMIC',
    oversizedRadiusMultiplier: opts.oversizedRadiusMultiplier ?? 2,
  };
};

const isSameDomainOptions = (
  a: Required<SpatialDomainOptions>,
  b: Required<SpatialDomainOptions>
) =>
  a.cellSize === b.cellSize &&
  a.maxMembers === b.maxMembers &&
  a.update === b.update &&
  a.oversizedRadiusMultiplier === b.oversizedRadiusMultiplier;

const createDomainGrid = (opts: Required<SpatialDomainOptions>) =>
  new SpatialGrid({
    cellSize: opts.cellSize,
    maxMembers: opts.maxMembers,
    oversizedRadiusMultiplier: opts.oversizedRadiusMultiplier,
  });

const defaultDomainOptions = (world: ECSWorld): SpatialDomainOptions => ({
  id: DEFAULT_SPATIAL_DOMAIN,
  cellSize: DEFAULT_CELL_SIZE,
  maxMembers: world.maxEntities,
});

/** Adds (or refreshes) a member with its current position and radius. */
const insertMember = (world: ECSWorld, domain: SpatialDomain, entityId: number) => {
  const pos = world.getPosition(entityId);
  const radius = computeSpatialRadius(entityId, world);
  domain.grid.addMember(entityId, pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0, radius);
};

/**
 * The one path every member takes into a domain. A full non-default domain refuses the member
 * (false) with one dev warning per domain; a full `DEFAULT` throws the grid's capacity error, as
 * it did before domains.
 */
const addToDomain = (world: ECSWorld, domain: SpatialDomain, entityId: number): boolean => {
  const grid = domain.grid;
  if (domain.bit >= 0 && !grid.has(entityId) && grid.memberCount >= domain.opts.maxMembers) {
    if (IS_DEBUG_ENV && !domain.hasWarnedFull) {
      domain.hasWarnedFull = true;
      lwarn(
        `SpatialIndex: domain '${domain.id}' is full (maxMembers ${domain.opts.maxMembers}), ` +
          `entity ${entityId} was refused. Further refusals in this domain aren't logged (p346 §3.1).`
      );
    }
    return false;
  }
  insertMember(world, domain, entityId);
  return true;
};

const setMaskBit = (world: ECSWorld, domain: SpatialDomain, entityId: number) => {
  const membership = world.getComponent(entityId, ComponentType.SPATIAL_DOMAINS);
  if (membership) membership.mask |= 1 << domain.bit;
  else world.addComponent(entityId, ComponentType.SPATIAL_DOMAINS, { mask: 1 << domain.bit });
};

/** Removes SPATIAL_DOMAINS with the last bit (its onRemoveComponent hook then has nothing left to leave). */
const clearMaskBit = (world: ECSWorld, domain: SpatialDomain, entityId: number) => {
  const membership = world.getComponent(entityId, ComponentType.SPATIAL_DOMAINS);
  if (!membership) return;
  membership.mask &= ~(1 << domain.bit);
  if (membership.mask === 0) world.removeComponent(entityId, ComponentType.SPATIAL_DOMAINS);
};

/**
 * Registers a spatial domain in `world`. Registering an existing id with the same settings is a
 * no-op; with different settings it replaces the domain's grid and re-inserts its members (the
 * cell size is baked into the grid's layout, so there is no cheaper path). Members past a
 * smaller `maxMembers` leave the domain. Registering `DEFAULT` before its first member sets its
 * settings (cell size 20 and `world.maxEntities` members otherwise). A world holds at most 31
 * domains besides `DEFAULT`.
 */
export function registerSpatialDomain(world: ECSWorld, opts: SpatialDomainOptions): void {
  const resolved = resolveDomainOptions(opts);
  let domains = domainsByWorld.get(world);
  if (!domains) {
    domains = { list: [], byId: new Map(), byBit: [] };
    domainsByWorld.set(world, domains);
  }

  const existing = domains.byId.get(resolved.id);
  if (!existing) {
    const isDefault = resolved.id === DEFAULT_SPATIAL_DOMAIN;
    if (!isDefault && domains.byBit.length >= MAX_NON_DEFAULT_DOMAINS) {
      throw new Error(
        `Spatial domain '${resolved.id}': world '${world.id}' already has the maximum of ` +
          `${MAX_NON_DEFAULT_DOMAINS} domains besides ${DEFAULT_SPATIAL_DOMAIN}.`
      );
    }
    const domain: SpatialDomain = {
      id: resolved.id,
      bit: isDefault ? -1 : domains.byBit.length,
      opts: resolved,
      grid: createDomainGrid(resolved),
      hasWarnedFull: false,
      lastRebuildMs: 0,
    };
    domains.list.push(domain);
    domains.byId.set(domain.id, domain);
    if (!isDefault) domains.byBit.push(domain);
    return;
  }
  if (isSameDomainOptions(existing.opts, resolved)) return;

  const oldGrid = existing.grid;
  if (existing.bit < 0 && oldGrid.memberCount > resolved.maxMembers) {
    // DEFAULT's membership is SPATIAL_INDEXED, which a refusal can't take away
    throw new Error(
      `Spatial domain '${DEFAULT_SPATIAL_DOMAIN}': maxMembers ${resolved.maxMembers} is below ` +
        `its current ${oldGrid.memberCount} members.`
    );
  }
  existing.opts = resolved;
  existing.grid = createDomainGrid(resolved);
  existing.hasWarnedFull = false;
  for (let i = 0; i < oldGrid.memberCount; i++) {
    const entityId = oldGrid.memberAt(i);
    if (!addToDomain(world, existing, entityId)) clearMaskBit(world, existing, entityId);
  }
  existing.grid.rebuild();
}

/** The grid of `world`'s domain `id`, or undefined if it isn't registered. Never creates one. */
export function getSpatialDomain(world: ECSWorld, id: string): SpatialGrid | undefined {
  return domainsByWorld.get(world)?.byId.get(id)?.grid;
}

/** The ids of `world`'s registered domains, in registration order. */
export function getSpatialDomainIds(world: ECSWorld): string[] {
  return domainsByWorld.get(world)?.list.map((domain) => domain.id) ?? [];
}

/** The resolved settings of `world`'s domain `id`, or undefined if it isn't registered. */
export function getSpatialDomainOptions(
  world: ECSWorld,
  id: string
): Readonly<Required<SpatialDomainOptions>> | undefined {
  return domainsByWorld.get(world)?.byId.get(id)?.opts;
}

const getDefaultDomain = (world: ECSWorld): SpatialDomain => {
  const domain = domainsByWorld.get(world)?.byId.get(DEFAULT_SPATIAL_DOMAIN);
  if (domain) return domain;
  registerSpatialDomain(world, defaultDomainOptions(world));
  return domainsByWorld.get(world)!.byId.get(DEFAULT_SPATIAL_DOMAIN)!;
};

/**
 * The `DEFAULT` domain's grid for `world`. Created on first use, so a world that never opts
 * anything in never pays for one.
 */
export function getSpatialGrid(world: ECSWorld): SpatialGrid {
  return getDefaultDomain(world).grid;
}

/** Re-registers `DEFAULT` with a new cell size and its other settings unchanged (the debug tab's cell size control). */
export function setSpatialGridCellSize(world: ECSWorld, cellSize: number): void {
  const current = domainsByWorld.get(world)?.byId.get(DEFAULT_SPATIAL_DOMAIN)?.opts;
  registerSpatialDomain(world, { ...(current ?? defaultDomainOptions(world)), cellSize });
}

// --- MEMBERSHIP (p346 §3.2) ---
// DEFAULT's membership is the SPATIAL_INDEXED component (also its JSON flag, `spatialIndex`);
// the other domains' is one SPATIAL_DOMAINS bit mask per entity, since domains are runtime
// configuration and components are declared statically. An entity can be in several domains.

/**
 * Adds `entityId` to `world`'s domain `domainId` with its current position and radius. Returns
 * false if the domain isn't registered, the entity isn't alive, or the domain is full; true if
 * the entity is (or already was) a member. Joining `DEFAULT` adds SPATIAL_INDEXED.
 */
export function joinSpatialDomain(
  entityId: number,
  domainId: string,
  world: ECSWorld = getECSWorld()
): boolean {
  if (!world.isAlive(entityId)) return false;
  if (domainId === DEFAULT_SPATIAL_DOMAIN) {
    if (!world.hasComponent(entityId, ComponentType.SPATIAL_INDEXED)) {
      world.addComponent(entityId, ComponentType.SPATIAL_INDEXED, true);
    }
    return true;
  }

  const domain = domainsByWorld.get(world)?.byId.get(domainId);
  if (!domain) {
    if (IS_DEBUG_ENV) {
      lwarn(
        `SpatialIndex: can't join entity ${entityId} to domain '${domainId}', it isn't ` +
          `registered in world '${world.id}' (registerSpatialDomain).`
      );
    }
    return false;
  }
  if (domain.grid.has(entityId)) return true;
  if (!addToDomain(world, domain, entityId)) return false;
  setMaskBit(world, domain, entityId);
  return true;
}

/** Removes `entityId` from `world`'s domain `domainId` (a no-op for a non-member). Leaving `DEFAULT` removes SPATIAL_INDEXED. */
export function leaveSpatialDomain(
  entityId: number,
  domainId: string,
  world: ECSWorld = getECSWorld()
): void {
  if (domainId === DEFAULT_SPATIAL_DOMAIN) {
    if (world.hasComponent(entityId, ComponentType.SPATIAL_INDEXED)) {
      world.removeComponent(entityId, ComponentType.SPATIAL_INDEXED);
    }
    return;
  }

  const domain = domainsByWorld.get(world)?.byId.get(domainId);
  if (!domain || !domain.grid.has(entityId)) return;
  domain.grid.removeMember(entityId);
  clearMaskBit(world, domain, entityId);
}

export function isInSpatialDomain(
  entityId: number,
  domainId: string,
  world: ECSWorld = getECSWorld()
): boolean {
  if (domainId === DEFAULT_SPATIAL_DOMAIN) {
    return world.hasComponent(entityId, ComponentType.SPATIAL_INDEXED);
  }
  const domain = domainsByWorld.get(world)?.byId.get(domainId);
  if (!domain) return false;
  const mask = world.getComponent(entityId, ComponentType.SPATIAL_DOMAINS)?.mask ?? 0;
  return (mask & (1 << domain.bit)) !== 0;
}

/** Takes the entity out of every domain in its SPATIAL_DOMAINS mask. */
const leaveMaskedDomains = (entityId: number, world: ECSWorld) => {
  const mask = world.getComponent(entityId, ComponentType.SPATIAL_DOMAINS)?.mask ?? 0;
  const byBit = domainsByWorld.get(world)?.byBit;
  if (!mask || !byBit) return;
  for (let bit = 0; bit < byBit.length; bit++) {
    if (mask & (1 << bit)) byBit[bit].grid.removeMember(entityId);
  }
};

// onRemoveComponent too, so removing the component directly can't leave stale grid members
ECSWorld.registerComponentHooks(ComponentType.SPATIAL_DOMAINS, {
  onRemoveComponent: leaveMaskedDomains,
  onDeleteEntity: leaveMaskedDomains,
});

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
    addToDomain(world, getDefaultDomain(world), entityId);
  },
  onRemoveComponent: (entityId, world) => {
    getSpatialDomain(world, DEFAULT_SPATIAL_DOMAIN)?.removeMember(entityId);
  },
  onDeleteEntity: (entityId, world) => {
    getSpatialDomain(world, DEFAULT_SPATIAL_DOMAIN)?.removeMember(entityId);
  },
});

/** Debug env only (§9) — the last rebuild's wall-clock cost of `world`'s domain `domainId`. */
export function getLastRebuildDurationMs(
  world: ECSWorld,
  domainId: string = DEFAULT_SPATIAL_DOMAIN
): number {
  return domainsByWorld.get(world)?.byId.get(domainId)?.lastRebuildMs ?? 0;
}

const refreshAndRebuildDomain = (world: ECSWorld, domain: SpatialDomain) => {
  const grid = domain.grid;
  for (let i = 0; i < grid.memberCount; i++) {
    const entityId = grid.memberAt(i);
    const pos = world.getPosition(entityId);
    if (pos) grid.updatePosition(entityId, pos.x, pos.y, pos.z);
  }

  const start = IS_DEBUG_ENV ? performance.now() : 0;
  grid.rebuild();
  if (IS_DEBUG_ENV) domain.lastRebuildMs = performance.now() - start;
};

/** Refreshes the members' positions and rebuilds the grid of every `DYNAMIC` domain, in registration order. Registered last in APP_POST_PHYSICS (§8) so APP_LOGIC/APP_RENDER_SYNC consumers see a current snapshot. */
export const spatialIndexRebuildSystem = (world: ECSWorld) => {
  const domains = domainsByWorld.get(world);
  if (!domains) return; // no domain registered in this world yet

  const list = domains.list;
  for (let i = 0; i < list.length; i++) {
    if (list[i].opts.update === 'DYNAMIC') refreshAndRebuildDomain(world, list[i]);
  }
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
