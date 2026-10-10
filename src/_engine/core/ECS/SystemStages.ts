// The ECS system stages, in the order every world runs them, and the order constants that place
// a system within a stage.

/** Stages of ECS system invocation */
export enum ECSSystemStage {
  // --- Runs in updateMainLoop (Always runs if MasterPlay is true, also while the app is paused) ---
  MAIN = 'MAIN',
  APP_PRE_PHYSICS = 'APP_PRE_PHYSICS', // Input handling, logic before physics

  // --- Runs from stepPhysics (Only if AppPlay is true) ---
  // Runs once per fixed physics sub-step (0-N times per frame), right before that step, with
  // dt = the fixed timestep — for anything that has to move in lockstep with the simulation
  // (kinematic paths, character controllers). Only runs while physics is stepping.
  APP_PHYSICS_STEP = 'APP_PHYSICS_STEP',

  // --- Runs in updateAppLoop (Only if AppPlay is true) ---
  APP_POST_PHYSICS = 'APP_POST_PHYSICS', // physicsToTransform (Syncing SAB to ECS)
  /**
   * Standard gameplay systems. Work in the ECS TRANSFORM domain here — TRANSFORM already holds
   * this frame's physics pose (APP_POST_PHYSICS).
   *
   * Render-pose rule: do NOT read or write the Object3D render pose (`.position`/`.quaternion`)
   * of a physics-driven entity at this stage. At APP_LOGIC that Object3D still holds what
   * object3DSyncSystem wrote at MAIN (the previous frame's pose), and physicsInterpolationSystem
   * overwrites it later at APP_RENDER_SYNC. Anything that follows or frames the rendered pose
   * (camera rigs, attachments) belongs at APP_RENDER_SYNC with
   * `APP_RENDER_SYNC_ORDER.POSE_CONSUMERS`.
   */
  APP_LOGIC = 'APP_LOGIC',
  /** Syncing ECS/physics to Three.js. Within this stage use the `APP_RENDER_SYNC_ORDER`
   * constants (higher `order` runs earlier) so render-pose producers, consumers and culling
   * keep their relative order regardless of registration sequence. */
  APP_RENDER_SYNC = 'APP_RENDER_SYNC',

  // --- Runs in updateLateMainLoop (After rendering) ---
  LATE_MAIN = 'LATE_MAIN',
}

/**
 * `addSystem` order values for `ECSSystemStage.APP_RENDER_SYNC` (higher runs earlier, equal
 * values run in registration order).
 * - POSE_PRODUCERS: systems that write the final Object3D render pose (physicsInterpolationSystem,
 *   lookAtSystem). Plain default order.
 * - POSE_CONSUMERS: systems that read the final render pose of another entity (camera rigs).
 *   Deliberately fractional: it has to run after every order-0 producer whatever their
 *   registration sequence (the follow camera rig registers before PhysicsManager does), and
 *   still before frustum culling, which reads the main camera's matrices — running a rig after
 *   culling would cull against a one-frame-stale camera and pop objects at the frustum edges.
 * - SHADOW_FIT: systems that fit something to this frame's final camera (the toolkit's
 *   SunShadowFit): after the camera rigs, before frustum culling.
 * - FRUSTUM_CULLING / LIGHT_CULLING: objectFrustumCullingSystem, then lightObjectCullingSystem
 *   (which depends on this frame's frustum-culling result).
 * - LOD_SELECTION: lodSelectionSystem, lodApplySystem and lodFadeSystem (Lod/LodSystem.ts), between the two:
 *   after frustum culling, so they skip entities culled this frame and see the final camera.
 */
export const APP_RENDER_SYNC_ORDER = {
  POSE_PRODUCERS: 0,
  POSE_CONSUMERS: -0.5,
  SHADOW_FIT: -0.75,
  FRUSTUM_CULLING: -1,
  LOD_SELECTION: -1.5,
  LIGHT_CULLING: -2,
} as const;
