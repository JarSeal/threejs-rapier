/**
 * A dynamic rigid body's simulation tier (p352, `PhysicsTiers.ts`):
 * - `FULL`: simulated as created.
 * - `STATIC`: switched to `FIXED`: it still collides, but nothing moves it or wakes it. Rapier
 *   zeroes its velocities, so it resumes from rest when it goes back to `FULL`.
 * - `DISABLED`: `setEnabled(false)`: out of the broad phase, the contacts and the queries (rays
 *   miss it), so only safe where nothing can reach it. It keeps its pose and velocities exactly.
 */
export type PhysicsTier = 'FULL' | 'STATIC' | 'DISABLED';

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
};
