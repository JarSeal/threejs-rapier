import { getECSWorld, type ECSWorld } from '../../../_engine/core/ECS';
import { registerOnAllSceneExits } from '../../../_engine/core/Scene';
import type { PhysVector, RigidBodyAPI } from '../../../_engine/core/Physics/PhysicsAPITypes';
import { ECSSystemStage } from '../../../AppECSRegistry';

/**
 * Mutual (N-body) Newtonian gravity between registered dynamic bodies, for zero-g scenes: every
 * fixed physics sub-step, each registered body's user force is reset and set to the sum of the
 * pulls of all the others.
 *
 * The pull uses Plummer softening, F = G·m₁·m₂·r / (r² + ε²)^(3/2), which is G·m₁·m₂ / r² for
 * r ≫ ε but stays finite as two bodies meet, so touching rocks don't fling apart. Each pair is
 * computed once and applied equal and opposite, so momentum is conserved to float error.
 *
 * Positions come from each rigid body's pose (`readPoseInto`): exact per sub-step in `MAIN_THREAD`
 * mode; in `WORKER_THREAD` mode it's the last pose the worker synced back, so the forces can be up
 * to a frame stale and the simulation isn't deterministic there (like the characters). The cost is
 * O(n²) per sub-step, fine for tens of bodies.
 *
 * Register the system once per world (`registerMutualGravityEffect(world)` in AppECSPlugins.ts),
 * then add bodies with `addGravityBody`. Bodies are dropped once their entity or rigid body is gone,
 * and all of them on every scene exit. The config is global (not per scene), so a scene that
 * changes it should set it on enter.
 */

export type MutualGravityConfig = {
  /** Gravitational constant in scene units (default 1: m/s² per kg of the attractor at 1 m). */
  G: number;
  /** Softening length ε in metres (default 0.5): about the size of the bodies. */
  softening: number;
  /** Whether the forces are applied (default true). Turning it off resets the forces once. */
  enabled: boolean;
};

export type GravityBody = { entityId: number; mass: number };

type GravityBodyEntry = GravityBody & { world: ECSWorld };

const DEFAULT_CONFIG: MutualGravityConfig = { G: 1, softening: 0.5, enabled: true };
const config: MutualGravityConfig = { ...DEFAULT_CONFIG };

const bodies = new Map<number, GravityBodyEntry>();
// Whether the forces on the registered bodies may be non-zero (so turning gravity off resets them once)
let hasAppliedForces = false;

// Per-sub-step scratch, grown on demand: poses (7 per body), forces (3 per body), the bodies
let poses = new Float64Array(7 * 16);
let forces = new Float64Array(3 * 16);
const stepBodies: RigidBodyAPI[] = [];
let stepMasses = new Float64Array(16);
const force: PhysVector = { x: 0, y: 0, z: 0 };

const ensureCapacity = (n: number) => {
  if (stepMasses.length >= n) return;
  const size = Math.max(n, stepMasses.length * 2);
  poses = new Float64Array(7 * size);
  forces = new Float64Array(3 * size);
  stepMasses = new Float64Array(size);
};

const mutualGravitySystem = (world: ECSWorld) => {
  if (!bodies.size) return;

  // Collect this world's live bodies, dropping the ones that are gone
  let n = 0;
  stepBodies.length = 0;
  for (const [entityId, entry] of bodies) {
    if (entry.world !== world) continue;
    const rb = world.isAlive(entityId) ? world.getRigidBody(entityId) : undefined;
    if (!rb || rb.isBeingDeleted) {
      bodies.delete(entityId);
      continue;
    }
    ensureCapacity(n + 1);
    stepBodies.push(rb);
    stepMasses[n] = entry.mass;
    n++;
  }
  if (!n) return;

  if (!config.enabled) {
    if (hasAppliedForces) {
      for (let i = 0; i < n; i++) stepBodies[i].resetForces(true);
      hasAppliedForces = false;
    }
    return;
  }

  for (let i = 0; i < n; i++) stepBodies[i].readPoseInto(poses, i * 7);
  forces.fill(0, 0, n * 3);

  const eps2 = config.softening * config.softening;
  for (let i = 0; i < n; i++) {
    const pi = i * 7;
    const mi = stepMasses[i];
    for (let j = i + 1; j < n; j++) {
      const pj = j * 7;
      const dx = poses[pj] - poses[pi];
      const dy = poses[pj + 1] - poses[pi + 1];
      const dz = poses[pj + 2] - poses[pi + 2];
      const d2 = dx * dx + dy * dy + dz * dz + eps2;
      if (d2 === 0) continue;
      // G·mi·mj / (r² + ε²)^(3/2), times the (unnormalized) separation
      const s = (config.G * mi * stepMasses[j]) / (d2 * Math.sqrt(d2));
      const fx = dx * s;
      const fy = dy * s;
      const fz = dz * s;
      forces[i * 3] += fx;
      forces[i * 3 + 1] += fy;
      forces[i * 3 + 2] += fz;
      forces[j * 3] -= fx;
      forces[j * 3 + 1] -= fy;
      forces[j * 3 + 2] -= fz;
    }
  }

  // Rapier keeps user forces until reset, so each sub-step replaces the last one's. The force
  // object is reused: MAIN_THREAD copies it into Rapier, WORKER_THREAD clones it at capture.
  for (let i = 0; i < n; i++) {
    const rb = stepBodies[i];
    rb.resetForces(false);
    force.x = forces[i * 3];
    force.y = forces[i * 3 + 1];
    force.z = forces[i * 3 + 2];
    rb.addForce(force, true);
  }
  hasAppliedForces = true;
};

/**
 * Adds a dynamic physics entity to the mutual gravity (or updates its mass). Use the body's real
 * mass, so it falls as it's pulled: with a density-based collider that's density × collider volume
 * (eg. `generateAsteroid`'s `hullVolume` for a `CONVEXHULL` collider).
 * @param entityId entity with a dynamic rigid body (see PhysicsManager.createPhysicsEntity)
 * @param mass gravitational mass
 * @param world ECS world the entity lives in (default: the default world)
 */
export const addGravityBody = (entityId: number, mass: number, world?: ECSWorld) => {
  const w = world || getECSWorld();
  if (!w) return;
  bodies.set(entityId, { entityId, mass, world: w });
};

/** Removes an entity from the mutual gravity and resets its user forces (if its body still exists).
 * @param entityId entity added with addGravityBody */
export const removeGravityBody = (entityId: number) => {
  const entry = bodies.get(entityId);
  if (!entry) return;
  bodies.delete(entityId);
  const rb = entry.world.isAlive(entityId) ? entry.world.getRigidBody(entityId) : undefined;
  if (rb && !rb.isBeingDeleted) rb.resetForces(true);
};

/** Removes every gravity body (their forces are left as they are: this runs on scene exit, when
 * the bodies are deleted anyway). */
export const clearGravityBodies = () => {
  bodies.clear();
  hasAppliedForces = false;
};

/** The registered gravity bodies (entity id and mass), eg. for a debug list or an energy readout. */
export const getGravityBodies = (): GravityBody[] =>
  [...bodies.values()].map(({ entityId, mass }) => ({ entityId, mass }));

/** Sets any of the mutual gravity's settings (the rest keep their values). */
export const setMutualGravityConfig = (partial: Partial<MutualGravityConfig>) => {
  Object.assign(config, partial);
};

/** A copy of the current mutual gravity settings. */
export const getMutualGravityConfig = (): MutualGravityConfig => ({ ...config });

/** The mutual gravity's default settings. */
export const getMutualGravityDefaults = (): MutualGravityConfig => ({ ...DEFAULT_CONFIG });

/** The Registration Helper: registers the mutual gravity system on `world` at APP_PHYSICS_STEP
 * (once per fixed physics sub-step). */
export const registerMutualGravityEffect = (world: ECSWorld) => {
  world.addSystem(ECSSystemStage.APP_PHYSICS_STEP, 'mutualGravitySystem', mutualGravitySystem);
  registerOnAllSceneExits('mutualGravity', clearGravityBodies);
  return world;
};
