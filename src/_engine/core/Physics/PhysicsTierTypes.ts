import type { ColliderAPI, RigidBodyAPI } from './PhysicsAPITypes';

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
