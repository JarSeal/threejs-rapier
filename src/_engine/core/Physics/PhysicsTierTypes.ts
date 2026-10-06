import type { ColliderAPI, PhysVector, RigidBodyAPI } from './PhysicsAPITypes';

/**
 * A dynamic rigid body's simulation tier (p352, `PhysicsTiers.ts`):
 * - `FULL`: simulated as created.
 * - `STATIC`: switched to `FIXED`: it still collides, but nothing moves it or wakes it. Rapier
 *   zeroes its velocities, so it resumes from rest when it goes back to `FULL`.
 * - `DISABLED`: `setEnabled(false)`: out of the broad phase, the contacts and the queries (rays
 *   miss it), so only safe where nothing can reach it. It keeps its pose and velocities exactly.
 * - `REMOVED`: the body and its colliders are out of the physics world and its transform-buffer
 *   slot is free; their state is kept engine side, with their ids, and they come back with it.
 */
export type PhysicsTier = 'FULL' | 'STATIC' | 'DISABLED' | 'REMOVED';

export type PhysicsTierBucket = 'BODY_DYNAMIC_VISUAL' | 'BODY_DYNAMIC_HEADLESS';

/** The PHYSICS_SIM_TIER component, added by the entity's first requestPhysicsTier. */
export type PhysicsSimTierData = {
  /** The tier the body is in. */
  tier: PhysicsTier;
  /** The tier last requested; differs from `tier` until the next APP_PHYSICS_STEP applies it. */
  target: PhysicsTier;
  /** The dynamic bucket the entity was created in, which `FULL` puts it back into (`STATIC` and
   * `DISABLED` move it to BODY_STATIC, so it isn't synced or interpolated per frame). */
  bucket: PhysicsTierBucket;
  /** The entity's body. It keeps its id through `REMOVED`, while the entity has no bucket
   * component (world.getRigidBody returns undefined). */
  body: RigidBodyAPI;
  /** The entity's colliders while it has no COLLIDER component (`REMOVED`, or in flight back). */
  colliders: ColliderAPI[] | null;
  /** WORKER_THREAD: the body is back in the world (requested on a fixed step), but the main
   * thread hasn't got its transform-buffer slot yet, so the entity has no bucket or COLLIDER
   * component. Later requests still apply on their own steps. */
  inFlight: boolean;
  /** Bumped by every move to or from `REMOVED`, so a worker reply overtaken by a later one is
   * dropped. */
  removalSeq: number;
};

/** One ring of a physics tier policy: entities within `within` of the focus get `tier`. */
export type PhysicsTierRing = {
  tier: PhysicsTier;
  /** Outer radius in world units. Every ring but the last has one; the last has none and
   * covers everything beyond the others. */
  within?: number;
};

/**
 * When a tier policy decides (p343):
 * - `STEPS` (default): it measures on a fixed physics step `k` and applies on step
 *   `k + interval`, so with a deterministic focus a scene plays out the same on every load and
 *   in both worker targets. In WORKER_THREAD mode stepping waits at `k + interval` for the
 *   measurement's reply when it's late (a catch-up frame, a slow worker): a hitch, never a
 *   different result.
 * - `FRAMES`: every `interval` frames at APP_LOGIC, from the members' TRANSFORM positions; its
 *   requests apply on the next physics step, which depends on frame timing.
 */
export type PhysicsTierPolicyCadence = 'STEPS' | 'FRAMES';

/** A world's distance policy (PhysicsTierPolicy.ts's setPhysicsTierPolicy). */
export type PhysicsTierPolicy = {
  /**
   * Where distances are measured from: a position, or an entity id. Null or undefined skips the
   * pass. Default: the world's main camera (TAG_IS_MAIN_CAMERA, so not the debug camera).
   *
   * With the `STEPS` cadence it's called on the measured step, with that step's index
   * (getPhysicsSubStepIndex): a position computed from `step` is deterministic. An entity with a
   * rigid body is measured with the members (deterministic); one without, by its TRANSFORM
   * (deterministic only if it's moved on physics steps), and so is the camera. With `FRAMES`,
   * `step` is undefined and an entity is measured by its TRANSFORM.
   */
  focus?: (step?: number) => PhysVector | number | null | undefined;
  /** Nearest first, `within` strictly ascending, each tier at most once. */
  rings: PhysicsTierRing[];
  /** An entity moves out to a coarser ring only beyond `within × (1 + hysteresis)` of the ring
   * it's in. Default 0.15. */
  hysteresis?: number;
  /** Default `STEPS`. */
  cadence?: PhysicsTierPolicyCadence;
  /** Physics steps (`STEPS`) or frames (`FRAMES`) between passes. Default 10. With `STEPS` in
   * WORKER_THREAD mode, keep it above the worker's reply time in steps (a few): below that,
   * every pass holds stepping until its reply arrives. */
  interval?: number;
  /** When set, the policy is removed when that scene is exited. Otherwise it stays (no physics
   * entity survives a scene switch, but the next scene's members follow it). */
  sceneId?: string;
};

/** The PHYSICS_TIER_POLICY component: the entity's tier follows its world's policy. */
export type PhysicsTierPolicyMemberData = {
  /** The tier the policy last asked for and requestPhysicsTier refused (eg. REMOVED for a body
   * with joints): not asked again until the policy wants another tier. */
  refusedTier: PhysicsTier | null;
  /** Whether a pass has placed it: its first ring is picked by `within` alone, without the
   * hysteresis (a new entity is FULL because it was created so, not because it was near). */
  placed: boolean;
};
