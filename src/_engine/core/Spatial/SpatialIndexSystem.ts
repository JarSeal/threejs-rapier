import * as THREE from 'three/webgpu';
import { ECSWorld, getECSWorld } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { IS_DEBUG_ENV } from '../Config';
import { lwarn } from '../../utils/Logger';
import { MAX_SPOT_ANGLE } from '../ECS/ObjectFrustumCullingSystem';
import { ReadonlyVec3, SpatialGrid } from './SpatialGrid';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../../utils/helpers';
import { getCurrentSceneId } from '../Scene';
import { getNextSceneId, isCurrentlyLoading } from '../SceneLoader';
import type { SceneSpatialDomainEntry } from '../../schemas/spatialDomainSchema';

// Debug
type SpatialGridDebugModule = typeof import('../Debug/_dbg__SpatialGrid');
let debugGUI: DebugModuleRef<SpatialGridDebugModule> | null = null;

export const registerSpatialIndexDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../Debug/_dbg__SpatialGrid'));
  useDebug(debugGUI)?._createSpatialGridDebugGUI();
};

/**
 * ECS wiring for SpatialGrid (docs/plans/_DONE_p050_spatial-index.md §3, §8). Each ECS world
 * holds named spatial domains (docs/plans/_DONE_p346_spatial-domains.md §3.1): separate grids, each
 * with its own cell size, capacity and update policy. `DEFAULT` is the one
 * LightObjectCullingSystem.ts queries. Its grid is built per scene on demand (by its first
 * SPATIAL_INDEXED member or a `getSpatialGrid` call) and freed on every scene change; its
 * settings outlive the grid (docs/plans/_DONE_p349_scene-scoped-spatial-domains.md §3.6).
 *
 * A domain (or `DEFAULT`'s settings) can belong to a scene and is released on its exit
 * (docs/plans/_DONE_p349_scene-scoped-spatial-domains.md, `sceneId` in SpatialDomainOptions).
 *
 * A domain's grid instance is replaced when the domain is re-registered with other settings, and
 * dropped when it's unregistered, so read it with `getSpatialDomain`/`getSpatialGrid` where it's
 * used instead of keeping it.
 */

/**
 * How a domain's grid is kept current (p346 §3.1):
 * - `DYNAMIC`: positions and scaled radii refreshed and the grid rebuilt every frame.
 * - `STATIC`: positions and radii are read when a member joins. The grid is rebuilt only in a
 *   frame where a member joined or left, and refreshed from every member's Transform first when
 *   `invalidateSpatialDomain` was called.
 * - `MANUAL`: rebuilt only by `rebuildSpatialDomain` (or at the next frame after
 *   `invalidateSpatialDomain`). Queries see the last rebuild: a member that joined since is
 *   missing, and one that left can make another member show up at its old cell, so rebuild
 *   before querying.
 */
export type SpatialUpdatePolicy = 'DYNAMIC' | 'STATIC' | 'MANUAL';

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
  /**
   * The scene these settings belong to (docs/plans/_DONE_p349_scene-scoped-spatial-domains.md §3.1).
   * While they exist they replace the domain's world settings (the last ones registered without
   * a scene). On that scene's exit the domain goes back to its world settings, or is
   * unregistered if it has none. A scope, not a setting: registering the same settings for
   * another scene doesn't re-create the grid.
   */
  sceneId?: string;
}

/** A domain's settings in use: every default filled in, without the scope. */
export type ResolvedSpatialDomainOptions = Required<Omit<SpatialDomainOptions, 'sceneId'>>;

/** The domain SPATIAL_INDEXED entities are members of. */
export const DEFAULT_SPATIAL_DOMAIN = 'DEFAULT';

// Starting guess pending real tuning data — §9's occupancy histogram (see
// _dbg__SpatialGrid.ts) is what should actually decide this, not a guess
// made ahead of a consumer.
const DEFAULT_CELL_SIZE = 20;

/** Bits 0-30 of SPATIAL_DOMAINS' mask, so the mask stays a small positive integer. */
const MAX_NON_DEFAULT_DOMAINS = 31;

/** A domain's settings layers (p349 §3.1), as the app registered them (before the debug override). */
type DomainSettingsLayers = {
  /** The last registration without a scene. Always set for DEFAULT. */
  worldRequested?: SpatialDomainOptions;
  /** The last registration with a scene. Wins while it's set. */
  sceneRequested?: SpatialDomainOptions & { sceneId: string };
};

type SpatialDomain = {
  readonly id: string;
  /** This domain's bit in SPATIAL_DOMAINS' mask; -1 for DEFAULT, whose membership is SPATIAL_INDEXED. */
  readonly bit: number;
  /** DEFAULT's are its world's `defaultLayers`, which outlive its grid. */
  readonly layers: DomainSettingsLayers;
  /** The settings in use. */
  opts: ResolvedSpatialDomainOptions;
  grid: SpatialGrid;
  /**
   * The local (unscaled) radius of every member whose radius follows its Transform scale, read
   * from its provider when it joined. The grid holds the scaled radius, refreshed on every
   * rebuild. Members with a scale-independent or zero radius aren't in here.
   */
  localRadius: Map<number, number>;
  /** A member joined, left or got a new radius since the last rebuild (`STATIC` rebuilds on it). */
  needsRebuild: boolean;
  /** `invalidateSpatialDomain` was called: refresh every member and rebuild at the next frame. */
  needsRefresh: boolean;
  hasWarnedFull: boolean;
  /** Debug env only, for _dbg__SpatialGrid.ts: see {@link SpatialDomainRebuildStats}. */
  lastRebuildMs: number;
  rebuildCount: number;
  /** The world's `frame` at the last rebuild; -1 before the first. */
  lastRebuildFrame: number;
  /** The world's `frame` at registration. */
  registeredFrame: number;
};

type WorldDomains = {
  /** Registration order, which is also the rebuild order. DEFAULT is in it only while it has a grid. */
  list: SpatialDomain[];
  byId: Map<string, SpatialDomain>;
  /** The non-default domains, by mask bit. An unregistered domain leaves a hole, reused lowest first. */
  byBit: (SpatialDomain | undefined)[];
  /** Debug env only: how many times the rebuild system has run in this world. */
  frame: number;
  /** DEFAULT's settings, kept for the session while its grid comes and goes (p349 §3.6). */
  defaultLayers: DomainSettingsLayers;
};

const domainsByWorld = new WeakMap<ECSWorld, WorldDomains>();

const resolveDomainOptions = (opts: SpatialDomainOptions): ResolvedSpatialDomainOptions => {
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

/** The settings the app asked for in effect: the scene's while it has some, else the world's. */
const getRequested = (layers: DomainSettingsLayers): SpatialDomainOptions =>
  layers.sceneRequested ?? layers.worldRequested!;

/** `requested` through the debug override (debug env only; it can't change the id), resolved. */
const resolveRequested = (world: ECSWorld, requested: SpatialDomainOptions) => {
  if (!IS_DEBUG_ENV || !debugOptionsOverride) return resolveDomainOptions(requested);
  const { sceneId, ...settings } = requested;
  return resolveDomainOptions({
    ...debugOptionsOverride(world, settings, sceneId),
    id: requested.id,
  });
};

const isSameDomainOptions = (a: ResolvedSpatialDomainOptions, b: ResolvedSpatialDomainOptions) =>
  a.cellSize === b.cellSize &&
  a.maxMembers === b.maxMembers &&
  a.update === b.update &&
  a.oversizedRadiusMultiplier === b.oversizedRadiusMultiplier;

const createDomainGrid = (opts: ResolvedSpatialDomainOptions) =>
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

/** `world`'s domain registry, created on first use (it allocates no grid). */
const getWorldDomains = (world: ECSWorld): WorldDomains => {
  let domains = domainsByWorld.get(world);
  if (!domains) {
    domains = {
      list: [],
      byId: new Map(),
      byBit: [],
      frame: 0,
      defaultLayers: { worldRequested: defaultDomainOptions(world) },
    };
    domainsByWorld.set(world, domains);
  }
  return domains;
};

/** Creates a domain with its grid and adds it to the registries (no members yet). */
const addDomain = (
  domains: WorldDomains,
  id: string,
  bit: number,
  layers: DomainSettingsLayers,
  opts: ResolvedSpatialDomainOptions
): SpatialDomain => {
  const domain: SpatialDomain = {
    id,
    bit,
    layers,
    opts,
    grid: createDomainGrid(opts),
    localRadius: new Map(),
    needsRebuild: false,
    needsRefresh: false,
    hasWarnedFull: false,
    lastRebuildMs: 0,
    rebuildCount: 0,
    lastRebuildFrame: -1,
    registeredFrame: domains.frame,
  };
  domains.list.push(domain);
  domains.byId.set(id, domain);
  if (bit >= 0) domains.byBit[bit] = domain;
  return domain;
};

/** Adds (or refreshes) a member with its current position and radius. */
const insertMember = (world: ECSWorld, domain: SpatialDomain, entityId: number) => {
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  const pos = transform?.position;
  const entry = findRadiusProvider(entityId, world);
  const local = entry?.provider(entityId, world) ?? 0;

  let radius = local;
  // Infinity stays Infinity (and a zero scale must not make it NaN)
  if (entry && !entry.isScaleIndependent && local > 0 && Number.isFinite(local)) {
    domain.localRadius.set(entityId, local);
    radius = local * maxAbsScale(transform?.scale);
  } else {
    domain.localRadius.delete(entityId);
  }
  domain.grid.addMember(entityId, pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0, radius);
  domain.needsRebuild = true;
};

const removeFromDomain = (domain: SpatialDomain, entityId: number) => {
  if (!domain.grid.has(entityId)) return;
  domain.grid.removeMember(entityId);
  domain.localRadius.delete(entityId);
  domain.needsRebuild = true;
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

/** The lowest bit no registered domain holds, or -1 when all of them are taken. */
const findFreeBit = (byBit: WorldDomains['byBit']) => {
  for (let bit = 0; bit < MAX_NON_DEFAULT_DOMAINS; bit++) {
    if (!byBit[bit]) return bit;
  }
  return -1;
};

/** Removes SPATIAL_DOMAINS with the last bit (its onRemoveComponent hook then has nothing left to leave). */
const clearMaskBit = (world: ECSWorld, domain: SpatialDomain, entityId: number) => {
  const membership = world.getComponent(entityId, ComponentType.SPATIAL_DOMAINS);
  if (!membership) return;
  membership.mask &= ~(1 << domain.bit);
  if (membership.mask === 0) world.removeComponent(entityId, ComponentType.SPATIAL_DOMAINS);
};

/** Debug env only: a scene's settings that no current or loading scene will release soon. */
const warnIfNotActiveScene = (id: string, sceneId: string) => {
  const activeSceneId = isCurrentlyLoading() ? getNextSceneId() : getCurrentSceneId();
  if (sceneId === activeSceneId) return;
  lwarn(
    `SpatialIndex: domain '${id}' was registered for scene '${sceneId}', which isn't the ` +
      `${isCurrentlyLoading() ? 'loading' : 'current'} scene ('${activeSceneId}'). Its settings ` +
      `stay until '${sceneId}' exits (docs/plans/_DONE_p349_scene-scoped-spatial-domains.md §3.1).`
  );
};

/**
 * Registers a spatial domain in `world`, or new settings for one. Registering an existing id
 * with the same settings is a no-op; with different settings it replaces the domain's grid and
 * re-inserts its members (the cell size is baked into the grid's layout, so there is no cheaper
 * path). Members past a smaller `maxMembers` leave the domain. Registering `DEFAULT` while it
 * has no grid only stores its settings, which its next grid is built with (cell size 20 and
 * `world.maxEntities` members otherwise). A world holds at most 31 domains besides `DEFAULT` at
 * once ({@link unregisterSpatialDomain} frees one).
 *
 * With `sceneId` the settings belong to that scene: they win until it exits, and then the domain
 * goes back to its world settings (registered without `sceneId`), or is unregistered if it has
 * none. A registration without `sceneId` while a scene's settings are in effect only updates the
 * world settings.
 */
export function registerSpatialDomain(world: ECSWorld, opts: SpatialDomainOptions): void {
  const { sceneId, ...settings } = opts;
  // Also validates world settings that a scene's settings keep from taking effect yet
  const resolved = resolveRequested(world, opts);
  if (IS_DEBUG_ENV && sceneId !== undefined) warnIfNotActiveScene(opts.id, sceneId);
  const domains = getWorldDomains(world);

  const existing = domains.byId.get(resolved.id);
  // DEFAULT's layers exist without its grid, another domain's only with it
  const layers = resolved.id === DEFAULT_SPATIAL_DOMAIN ? domains.defaultLayers : existing?.layers;
  if (layers) {
    if (sceneId === undefined) {
      layers.worldRequested = settings;
      if (layers.sceneRequested) return;
    } else {
      layers.sceneRequested = { ...settings, sceneId };
    }
    if (existing) applyDomainOptions(world, domains, existing, resolved);
    return;
  }

  const bit = findFreeBit(domains.byBit);
  if (bit < 0) {
    throw new Error(
      `Spatial domain '${resolved.id}': world '${world.id}' already has the maximum of ` +
        `${MAX_NON_DEFAULT_DOMAINS} domains besides ${DEFAULT_SPATIAL_DOMAIN}.`
    );
  }
  addDomain(
    domains,
    resolved.id,
    bit,
    {
      worldRequested: sceneId === undefined ? settings : undefined,
      sceneRequested: sceneId === undefined ? undefined : { ...settings, sceneId },
    },
    resolved
  );
}

/**
 * Builds `DEFAULT`'s grid with the settings in effect, holding every current SPATIAL_INDEXED
 * entity (persistent ones from earlier scenes included), rebuilt so it can be queried at once
 * (p349 §3.6).
 */
function buildDefaultDomain(world: ECSWorld, domains: WorldDomains): SpatialDomain {
  const layers = domains.defaultLayers;
  const resolved = resolveRequested(world, getRequested(layers));
  const domain = addDomain(domains, DEFAULT_SPATIAL_DOMAIN, -1, layers, resolved);
  for (const [entityId] of world.getStorage(ComponentType.SPATIAL_INDEXED)) {
    addToDomain(world, domain, entityId);
  }
  rebuildDomain(domain, domains.frame);
  return domain;
}

/** Drops `DEFAULT`'s grid (its members keep SPATIAL_INDEXED, and its settings stay). */
function freeDefaultGrid(domains: WorldDomains): void {
  const domain = domains.byId.get(DEFAULT_SPATIAL_DOMAIN);
  if (!domain) return;
  domains.list.splice(domains.list.indexOf(domain), 1);
  domains.byId.delete(DEFAULT_SPATIAL_DOMAIN);
}

/**
 * Puts `domain`'s settings in effect: those it was asked for (see `getRequested`) unless
 * `resolved` is given. A changed setting re-creates the grid and re-inserts the members.
 */
function applyDomainOptions(
  world: ECSWorld,
  domains: WorldDomains,
  domain: SpatialDomain,
  resolved: ResolvedSpatialDomainOptions = resolveRequested(world, getRequested(domain.layers))
): void {
  if (isSameDomainOptions(domain.opts, resolved)) return;

  const oldGrid = domain.grid;
  if (domain.bit < 0 && oldGrid.memberCount > resolved.maxMembers) {
    // DEFAULT's membership is SPATIAL_INDEXED, which a refusal can't take away
    throw new Error(
      `Spatial domain '${DEFAULT_SPATIAL_DOMAIN}': maxMembers ${resolved.maxMembers} is below ` +
        `its current ${oldGrid.memberCount} members.`
    );
  }
  domain.opts = resolved;
  domain.grid = createDomainGrid(resolved);
  domain.localRadius.clear(); // re-read below, from the providers
  domain.hasWarnedFull = false;
  for (let i = 0; i < oldGrid.memberCount; i++) {
    const entityId = oldGrid.memberAt(i);
    if (!addToDomain(world, domain, entityId)) clearMaskBit(world, domain, entityId);
  }
  // The re-insert read every member's current position and radius
  rebuildDomain(domain, domains.frame);
}

/**
 * Drops the settings `sceneId` registered (§3.2): each domain they belong to goes back to its
 * world settings, or is unregistered if it has none (its persistent members leave it too). Then
 * frees `DEFAULT`'s grid, also without a `sceneId` (the first load), so the next scene builds
 * its own when it needs one (§3.6). The scene loader calls it for the default world right after
 * the previous scene's entities are deleted, so a reverted grid re-inserts only the persistent
 * ones.
 */
export function releaseSceneSpatialDomains(
  world: ECSWorld,
  sceneId: string | null | undefined
): void {
  const domains = domainsByWorld.get(world);
  if (!domains) return;
  if (sceneId) {
    const defaultLayers = domains.defaultLayers;
    if (defaultLayers.sceneRequested?.sceneId === sceneId) defaultLayers.sceneRequested = undefined;
    // A copy: unregistering takes the domain out of the list
    for (const domain of [...domains.list]) {
      const layers = domain.layers;
      // DEFAULT's grid is freed below, no need to revert it first
      if (domain.bit < 0 || layers.sceneRequested?.sceneId !== sceneId) continue;
      layers.sceneRequested = undefined;
      if (layers.worldRequested) applyDomainOptions(world, domains, domain);
      else unregisterSpatialDomain(world, domain.id);
    }
  }
  freeDefaultGrid(domains);
}

/**
 * Registers a scene's `spatialDomains` (its scene JSON, §3.4) with `sceneId` as their scope.
 * `DEFAULT`'s entry is partial, merged over its world settings, and only stores them (its grid is
 * built by the scene's first join, at those settings); every other domain is created here. The
 * scene loader calls it for the default world right after `releaseSceneSpatialDomains`, before
 * anything of the scene joins a domain, so each grid is created once at its final size.
 */
export function registerSceneSpatialDomains(
  world: ECSWorld,
  sceneId: string,
  entries: readonly SceneSpatialDomainEntry[]
): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const base =
      entry.id === DEFAULT_SPATIAL_DOMAIN
        ? getWorldDomains(world).defaultLayers.worldRequested
        : {};
    // A non-default entry without cellSize or maxMembers fails resolveDomainOptions' checks
    registerSpatialDomain(world, { ...base, ...entry, sceneId } as SpatialDomainOptions);
  }
}

/**
 * Removes `world`'s domain `id`, whichever settings (world or scene) it has: every member leaves
 * it (losing its SPATIAL_DOMAINS bit, and the component with its last one), and its grid and
 * oracle state are dropped. Its bit is free for
 * the next registration. A no-op if it isn't registered. `DEFAULT` can't be unregistered: its
 * membership is SPATIAL_INDEXED, which other code adds.
 */
export function unregisterSpatialDomain(world: ECSWorld, id: string): void {
  if (id === DEFAULT_SPATIAL_DOMAIN) {
    if (IS_DEBUG_ENV) {
      lwarn(
        `SpatialIndex: domain '${DEFAULT_SPATIAL_DOMAIN}' can't be unregistered (its ` +
          `membership is SPATIAL_INDEXED); register it with other settings instead.`
      );
    }
    return;
  }
  const domains = domainsByWorld.get(world);
  const domain = domains?.byId.get(id);
  if (!domains || !domain) return;

  // Out of the registries first, so the hooks of the removals below have nothing to leave
  domains.list.splice(domains.list.indexOf(domain), 1);
  domains.byId.delete(id);
  domains.byBit[domain.bit] = undefined;
  oracleByWorld.get(world)?.delete(id);

  // Every holder loses the bit, so a domain that reuses it can't inherit a stale membership
  const bit = 1 << domain.bit;
  const emptied: number[] = [];
  for (const [entityId, membership] of world.getStorage(ComponentType.SPATIAL_DOMAINS)) {
    if (!(membership.mask & bit)) continue;
    membership.mask &= ~bit;
    if (membership.mask === 0) emptied.push(entityId);
  }
  for (let i = 0; i < emptied.length; i++) {
    world.removeComponent(emptied[i], ComponentType.SPATIAL_DOMAINS);
  }
}

/**
 * The grid of `world`'s domain `id`, or undefined if it isn't registered (`DEFAULT`: if it has
 * no grid in this scene yet, see {@link getSpatialGrid}). Never creates one.
 */
export function getSpatialDomain(world: ECSWorld, id: string): SpatialGrid | undefined {
  return domainsByWorld.get(world)?.byId.get(id)?.grid;
}

/** The ids of `world`'s registered domains, in registration order (`DEFAULT` only while it has a grid). */
export function getSpatialDomainIds(world: ECSWorld): string[] {
  return domainsByWorld.get(world)?.list.map((domain) => domain.id) ?? [];
}

/**
 * The resolved settings of `world`'s domain `id`, or undefined if it isn't registered. For
 * `DEFAULT` without a grid: the settings its next grid would be built with.
 */
export function getSpatialDomainOptions(
  world: ECSWorld,
  id: string
): Readonly<ResolvedSpatialDomainOptions> | undefined {
  if (id !== DEFAULT_SPATIAL_DOMAIN) return domainsByWorld.get(world)?.byId.get(id)?.opts;
  const domains = getWorldDomains(world);
  return domains.byId.get(id)?.opts ?? resolveRequested(world, getRequested(domains.defaultLayers));
}

/**
 * The scene whose settings `world`'s domain `id` uses, or undefined when it uses its world
 * settings (or isn't registered). Known for `DEFAULT` without a grid too.
 */
export function getSpatialDomainSceneId(world: ECSWorld, id: string): string | undefined {
  const domains = domainsByWorld.get(world);
  const layers =
    id === DEFAULT_SPATIAL_DOMAIN ? domains?.defaultLayers : domains?.byId.get(id)?.layers;
  return layers?.sceneRequested?.sceneId;
}

/**
 * The `DEFAULT` domain's grid for `world`, built if this scene has none yet (it's freed on every
 * scene change). A reader that shouldn't allocate it uses `getSpatialDomain` instead.
 */
export function getSpatialGrid(world: ECSWorld): SpatialGrid {
  const domains = getWorldDomains(world);
  return (domains.byId.get(DEFAULT_SPATIAL_DOMAIN) ?? buildDefaultDomain(world, domains)).grid;
}

/**
 * Re-registers `DEFAULT` with a new cell size and its other settings unchanged: its world
 * settings, or with `sceneId` that scene's settings (its world settings when the scene has none
 * yet), which revert on the scene's exit. Without a grid it only stores them (see
 * {@link registerSpatialDomain}). In the debug env, a cell size set in the "Spatial index" tab
 * wins.
 */
export function setSpatialGridCellSize(world: ECSWorld, cellSize: number, sceneId?: string): void {
  const layers = getWorldDomains(world).defaultLayers;
  const scene = layers.sceneRequested;
  const base = sceneId !== undefined && scene?.sceneId === sceneId ? scene : layers.worldRequested!;
  registerSpatialDomain(world, { ...base, cellSize, sceneId });
}

// --- DEBUG OVERRIDES ---
// The "Spatial index" tab's per-domain settings (_dbg__SpatialGrid.ts). Applied on every
// registration, so they hold when the app registers a domain again on its next scene visit.

/**
 * Gets the settings of a registration without its scope, and the scope separately: `sceneId`
 * for a scene's settings, undefined for the world settings (p349 §3.5).
 */
type SpatialDomainOptionsOverride = (
  world: ECSWorld,
  requested: Omit<SpatialDomainOptions, 'sceneId'>,
  sceneId: string | undefined
) => Omit<SpatialDomainOptions, 'sceneId'>;

let debugOptionsOverride: SpatialDomainOptionsOverride | null = null;

/** Debug env only: sets (or clears) the function that adjusts every domain's settings when they take effect (the id and scope can't be changed). Call {@link reapplySpatialDomainOptions} for the domains it now treats differently. */
export function setSpatialDomainOptionsOverride(fn: SpatialDomainOptionsOverride | null): void {
  debugOptionsOverride = fn;
}

/** Debug env only: registers `world`'s domain `id` again with the settings the app asked for, through the current override. A no-op for `DEFAULT` without a grid, whose next build reads the override. */
export function reapplySpatialDomainOptions(world: ECSWorld, id: string): void {
  const domains = domainsByWorld.get(world);
  const domain = domains?.byId.get(id);
  if (domains && domain) applyDomainOptions(world, domains, domain);
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
  removeFromDomain(domain, entityId);
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

/**
 * Re-reads `entityId`'s radius from its provider in every domain it's a member of. Call it after
 * changing what the provider measures (a light's distance or angle, a mesh's geometry); a
 * Transform scale change needs no call.
 */
export function refreshSpatialRadius(entityId: number, world: ECSWorld = getECSWorld()): void {
  const list = domainsByWorld.get(world)?.list;
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    if (list[i].grid.has(entityId)) insertMember(world, list[i], entityId);
  }
}

/** Takes the entity out of every domain in its SPATIAL_DOMAINS mask. */
const leaveMaskedDomains = (entityId: number, world: ECSWorld) => {
  const mask = world.getComponent(entityId, ComponentType.SPATIAL_DOMAINS)?.mask ?? 0;
  const byBit = domainsByWorld.get(world)?.byBit;
  if (!mask || !byBit) return;
  for (let bit = 0; bit < byBit.length; bit++) {
    const domain = byBit[bit];
    if (domain && mask & (1 << bit)) removeFromDomain(domain, entityId);
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

// --- RADIUS PROVIDERS (p346 §3.3) ---
// Like ObjectFrustumCullingSystem.ts's bounding-volume providers: the first registered component
// type an entity has picks the provider that measures it. A member none of them measures gets
// radius 0 (a point).

/** A member's radius in its local space (before its Transform scale), or undefined if it can't be measured. */
export type SpatialRadiusProvider = (entityId: number, world: ECSWorld) => number | undefined;

type RadiusProviderEntry = {
  componentType: ComponentType;
  provider: SpatialRadiusProvider;
  isScaleIndependent: boolean;
};

const radiusProviders: RadiusProviderEntry[] = [];

/**
 * Measures the members that have `componentType`. The radius is read when an entity joins a
 * domain, and multiplied by the largest axis of its Transform scale on every rebuild, unless
 * `scaleIndependent` (eg. a light's range). Registering a type again replaces its provider.
 */
export function registerSpatialRadiusProvider(
  componentType: ComponentType,
  provider: SpatialRadiusProvider,
  opts?: { scaleIndependent?: boolean }
): void {
  const entry: RadiusProviderEntry = {
    componentType,
    provider,
    isScaleIndependent: opts?.scaleIndependent ?? false,
  };
  const index = radiusProviders.findIndex((e) => e.componentType === componentType);
  if (index >= 0) radiusProviders[index] = entry;
  else radiusProviders.push(entry);
}

function findRadiusProvider(entityId: number, world: ECSWorld): RadiusProviderEntry | undefined {
  for (let i = 0; i < radiusProviders.length; i++) {
    if (world.hasComponent(entityId, radiusProviders[i].componentType)) return radiusProviders[i];
  }
  return undefined;
}

const maxAbsScale = (scale: THREE.Vector3 | undefined) =>
  scale ? Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) : 1;

/**
 * A sphere around the geometry's local origin (where its entity's position is) that holds its
 * whole bounding sphere: `|center| + radius`. Conservative for geometry that isn't centred on its
 * origin, where the bounding sphere's radius alone would miss part of it.
 */
export function getConservativeGeometryRadius(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  return sphere ? sphere.center.length() + sphere.radius : 0;
}

/** The radius `entityId` has as a member right now: its provider's, scaled by its Transform. */
function computeSpatialRadius(entityId: number, world: ECSWorld): number {
  const entry = findRadiusProvider(entityId, world);
  const local = entry?.provider(entityId, world) ?? 0;
  if (!entry || entry.isScaleIndependent || !(local > 0) || !Number.isFinite(local)) return local;
  return local * maxAbsScale(world.getScale(entityId));
}

const getLightRadius: SpatialRadiusProvider = (entityId, world) => {
  const light = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  return light instanceof THREE.PointLight || light instanceof THREE.SpotLight
    ? computeLightInfluenceRadius(light)
    : undefined;
};

registerSpatialRadiusProvider(ComponentType.TAG_IS_POINT_LIGHT, getLightRadius, {
  scaleIndependent: true,
});
registerSpatialRadiusProvider(ComponentType.TAG_IS_SPOT_LIGHT, getLightRadius, {
  scaleIndependent: true,
});
registerSpatialRadiusProvider(ComponentType.TAG_IS_MESH, (entityId, world) => {
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  return obj instanceof THREE.Mesh ? getConservativeGeometryRadius(obj.geometry) : undefined;
});

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
    const domains = getWorldDomains(world);
    const domain = domains.byId.get(DEFAULT_SPATIAL_DOMAIN);
    if (domain) addToDomain(world, domain, entityId);
    // The build inserts every SPATIAL_INDEXED holder, this entity included (it's stored before
    // its hooks run)
    else buildDefaultDomain(world, domains);
  },
  onRemoveComponent: (entityId, world) => leaveDefaultDomain(entityId, world),
  onDeleteEntity: (entityId, world) => leaveDefaultDomain(entityId, world),
});

function leaveDefaultDomain(entityId: number, world: ECSWorld) {
  const domain = domainsByWorld.get(world)?.byId.get(DEFAULT_SPATIAL_DOMAIN);
  if (domain) removeFromDomain(domain, entityId);
}

/** Debug env only (§9) — the last rebuild's wall-clock cost of `world`'s domain `domainId`. */
export function getLastRebuildDurationMs(
  world: ECSWorld,
  domainId: string = DEFAULT_SPATIAL_DOMAIN
): number {
  return domainsByWorld.get(world)?.byId.get(domainId)?.lastRebuildMs ?? 0;
}

/** Debug env only (p346 Phase 3): how often a domain actually rebuilds, and what it costs. */
export type SpatialDomainRebuildStats = {
  /** Wall-clock cost of the last rebuild (the grid's `rebuild()`, not the position refresh). */
  lastRebuildMs: number;
  /** Rebuilds since the domain was registered, from any source (the system, `rebuildSpatialDomain`, a re-registration). */
  rebuildCount: number;
  /** Frames (rebuild system runs) since the domain was registered. */
  frameCount: number;
  /** Frames since the last rebuild; -1 if it never rebuilt. */
  framesSinceRebuild: number;
};

/** Debug env only — the rebuild counts of `world`'s domain `domainId`, or undefined if it isn't registered. */
export function getSpatialDomainRebuildStats(
  world: ECSWorld,
  domainId: string
): SpatialDomainRebuildStats | undefined {
  const domains = domainsByWorld.get(world);
  const domain = domains?.byId.get(domainId);
  if (!domains || !domain) return undefined;
  return {
    lastRebuildMs: domain.lastRebuildMs,
    rebuildCount: domain.rebuildCount,
    frameCount: domains.frame - domain.registeredFrame,
    framesSinceRebuild: domain.lastRebuildFrame < 0 ? -1 : domains.frame - domain.lastRebuildFrame,
  };
}

/** Re-reads every member's position and scaled radius from its Transform. */
function refreshDomainMembers(world: ECSWorld, domain: SpatialDomain): void {
  const grid = domain.grid;
  const localRadius = domain.localRadius;
  for (let i = 0; i < grid.memberCount; i++) {
    const entityId = grid.memberAt(i);
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) continue;
    const pos = transform.position;
    grid.updatePosition(entityId, pos.x, pos.y, pos.z);
    const local = localRadius.get(entityId);
    if (local !== undefined) grid.updateRadius(entityId, local * maxAbsScale(transform.scale));
  }
}

/** `frame`: the world's rebuild-system frame, for the debug stats. */
function rebuildDomain(domain: SpatialDomain, frame: number): void {
  const start = IS_DEBUG_ENV ? performance.now() : 0;
  domain.grid.rebuild();
  domain.needsRebuild = false;
  domain.needsRefresh = false;
  if (IS_DEBUG_ENV) {
    domain.lastRebuildMs = performance.now() - start;
    domain.rebuildCount++;
    domain.lastRebuildFrame = frame;
  }
}

const getDomainOrWarn = (world: ECSWorld, domainId: string, action: string) => {
  const domain = domainsByWorld.get(world)?.byId.get(domainId);
  if (!domain && IS_DEBUG_ENV) {
    lwarn(
      `SpatialIndex: can't ${action} domain '${domainId}', it isn't registered in world ` +
        `'${world.id}' (registerSpatialDomain).`
    );
  }
  return domain;
};

/**
 * Refreshes every member of `world`'s domain `domainId` from its Transform and rebuilds the grid
 * at the next frame's rebuild (APP_POST_PHYSICS), for any update policy. For a `STATIC` domain
 * whose members moved, or a `MANUAL` one whose owner doesn't need the result before then. A
 * no-op change for `DYNAMIC`, which does this every frame.
 */
export function invalidateSpatialDomain(world: ECSWorld, domainId: string): void {
  const domain = getDomainOrWarn(world, domainId, 'invalidate');
  if (domain) domain.needsRefresh = true;
}

/**
 * Refreshes every member of `world`'s domain `domainId` from its Transform and rebuilds the grid
 * now, for any update policy. The way a `MANUAL` domain is kept current: call it before
 * querying when members joined, left or moved since the last rebuild.
 */
export function rebuildSpatialDomain(world: ECSWorld, domainId: string): void {
  const domain = getDomainOrWarn(world, domainId, 'rebuild');
  if (!domain) return;
  refreshDomainMembers(world, domain);
  rebuildDomain(domain, domainsByWorld.get(world)!.frame);
}

/**
 * Keeps every domain current by its update policy, in registration order: `DYNAMIC` is refreshed
 * and rebuilt, `STATIC` is rebuilt when a member joined or left, and any domain is refreshed and
 * rebuilt when invalidated. Registered last in APP_POST_PHYSICS (§8) so APP_LOGIC/APP_RENDER_SYNC
 * consumers see a current snapshot.
 */
export const spatialIndexRebuildSystem = (world: ECSWorld) => {
  const domains = domainsByWorld.get(world);
  if (!domains) return; // no domain registered in this world yet

  // A scene change freed DEFAULT's grid, but persistent entities kept SPATIAL_INDEXED: build it
  // back before anything queries it (every other holder builds it by joining, p349 §3.6)
  if (
    !domains.byId.has(DEFAULT_SPATIAL_DOMAIN) &&
    world.getStorage(ComponentType.SPATIAL_INDEXED).size > 0
  ) {
    buildDefaultDomain(world, domains);
  }

  const frame = IS_DEBUG_ENV ? ++domains.frame : 0;
  const list = domains.list;
  for (let i = 0; i < list.length; i++) {
    const domain = list[i];
    const policy = domain.opts.update;
    if (policy === 'DYNAMIC' || domain.needsRefresh) {
      refreshDomainMembers(world, domain);
      rebuildDomain(domain, frame);
    } else if (policy === 'STATIC' && domain.needsRebuild) {
      // The members that joined were read on joining; the others haven't moved
      rebuildDomain(domain, frame);
    }
    if (IS_DEBUG_ENV) runOracleProbes(world, domain);
  }
};

// --- BRUTE-FORCE ORACLE (§9) ---
// Debug-only cross-check that the grid's candidates for a query are a
// superset of an exact distance test — never the reverse, since the grid's
// candidates are conservative by design (§7's "candidates, not results").
// Opt-in per world and domain via setSpatialGridOracleEnabled, surfaced in
// _dbg__SpatialGrid.ts; a no-op call in production (IS_DEBUG_ENV-gated).
// While on, it checks the queries consumers pass to validateSpatialGridQuery,
// plus a few probe queries near random members every frame, so a domain that
// no consumer queries yet is checked too. It compares against live positions,
// so in a STATIC or MANUAL domain it also flags members that moved without an
// invalidateSpatialDomain/rebuildSpatialDomain call.

type OracleState = { enabled: boolean; checked: number; mismatches: number; warned: number };

const oracleByWorld = new WeakMap<ECSWorld, Map<string, OracleState>>();
const ORACLE_PROBES_PER_FRAME = 8;
/** Mismatches past this many (per enable) are only counted, not logged. */
const ORACLE_MAX_WARNINGS = 10;

function getOracle(world: ECSWorld, domainId: string): OracleState | undefined {
  return oracleByWorld.get(world)?.get(domainId);
}

/** Turns the oracle on or off for one domain, and resets its counts. */
export function setSpatialGridOracleEnabled(
  world: ECSWorld,
  enabled: boolean,
  domainId: string = DEFAULT_SPATIAL_DOMAIN
): void {
  let byDomain = oracleByWorld.get(world);
  if (!byDomain) {
    byDomain = new Map();
    oracleByWorld.set(world, byDomain);
  }
  byDomain.set(domainId, { enabled, checked: 0, mismatches: 0, warned: 0 });
}

export function isSpatialGridOracleEnabled(
  world: ECSWorld,
  domainId: string = DEFAULT_SPATIAL_DOMAIN
): boolean {
  return getOracle(world, domainId)?.enabled ?? false;
}

export function getOracleMismatchCount(
  world: ECSWorld,
  domainId: string = DEFAULT_SPATIAL_DOMAIN
): number {
  return getOracle(world, domainId)?.mismatches ?? 0;
}

/** How many queries the oracle has checked in the domain since it was turned on. */
export function getOracleCheckedQueryCount(
  world: ECSWorld,
  domainId: string = DEFAULT_SPATIAL_DOMAIN
): number {
  return getOracle(world, domainId)?.checked ?? 0;
}

/** The true "within range" set, computed by iterating the domain's members as the ECS records them (SPATIAL_INDEXED, or the domain's SPATIAL_DOMAINS bit) — the thing the grid is trying to approximate cheaply. */
function bruteForceQuery(
  world: ECSWorld,
  domain: SpatialDomain,
  p: ReadonlyVec3,
  r: number
): Set<number> {
  const result = new Set<number>();
  const test = (entityId: number) => {
    const pos = world.getPosition(entityId);
    if (!pos) return;
    const radius = computeSpatialRadius(entityId, world);
    const dx = pos.x - p.x;
    const dy = pos.y - p.y;
    const dz = pos.z - p.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= r + radius) result.add(entityId);
  };

  if (domain.bit < 0) {
    for (const [entityId] of world.getStorage(ComponentType.SPATIAL_INDEXED)) test(entityId);
  } else {
    const bit = 1 << domain.bit;
    for (const [entityId, membership] of world.getStorage(ComponentType.SPATIAL_DOMAINS)) {
      if (membership.mask & bit) test(entityId);
    }
  }
  return result;
}

function checkQuery(
  world: ECSWorld,
  domain: SpatialDomain,
  oracle: OracleState,
  p: ReadonlyVec3,
  r: number
): void {
  const exact = bruteForceQuery(world, domain, p, r);
  const found = new Set<number>();
  domain.grid.queryVisit(p, r, (id) => found.add(id));
  oracle.checked++;

  for (const id of exact) {
    if (found.has(id)) continue;
    oracle.mismatches++;
    if (oracle.warned >= ORACLE_MAX_WARNINGS) continue;
    oracle.warned++;
    lwarn(
      `SpatialGrid oracle: entity ${id} is within range of query ` +
        `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) r=${r.toFixed(2)} in domain ` +
        `'${domain.id}' but the grid's candidates missed it — see docs/plans/_DONE_p050_spatial-index.md §9.` +
        (oracle.warned === ORACLE_MAX_WARNINGS ? ' Further mismatches are only counted.' : '')
    );
  }
}

const _probe = { x: 0, y: 0, z: 0 };

/** Probe queries near random members, within a cell of them, with radii up to two cells. */
function runOracleProbes(world: ECSWorld, domain: SpatialDomain): void {
  const oracle = getOracle(world, domain.id);
  const memberCount = domain.grid.memberCount;
  if (!oracle?.enabled || memberCount === 0) return;
  const cellSize = domain.opts.cellSize;
  for (let i = 0; i < ORACLE_PROBES_PER_FRAME; i++) {
    const pos = world.getPosition(domain.grid.memberAt(Math.floor(Math.random() * memberCount)));
    if (!pos) continue;
    _probe.x = pos.x + (Math.random() * 2 - 1) * cellSize;
    _probe.y = pos.y + (Math.random() * 2 - 1) * cellSize;
    _probe.z = pos.z + (Math.random() * 2 - 1) * cellSize;
    checkQuery(world, domain, oracle, _probe, Math.random() * cellSize * 2);
  }
}

/**
 * Call after a real `queryVisit`/`queryInto` call on domain `domainId`'s grid, to validate that
 * call's result. No-op unless both `IS_DEBUG_ENV` and the oracle are on for that domain — safe
 * to call unconditionally from a hot path.
 */
export function validateSpatialGridQuery(
  world: ECSWorld,
  p: ReadonlyVec3,
  r: number,
  domainId: string = DEFAULT_SPATIAL_DOMAIN
): void {
  if (!IS_DEBUG_ENV) return;
  const oracle = getOracle(world, domainId);
  const domain = domainsByWorld.get(world)?.byId.get(domainId);
  if (!oracle?.enabled || !domain) return;
  checkQuery(world, domain, oracle, p, r);
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
