// NOTE! Import only types and everything with "import type ..."
import type * as THREE from 'three/webgpu';
import { HoverComponentData, HoverToolComponentType } from './toolkit/ecs/effects/HoverEffect';
import { FollowComponentData, FollowToolComponentType } from './toolkit/ecs/effects/FollowTool';
import {
  InstancedMeshPoolComponentData,
  InstancedMeshPoolComponentType,
} from './toolkit/ecs/InstancedMeshPool';

/**
 * App and toolkit components (app specific)
 * Example:
 * {
 *   HEALTH: 'APP_HEALTH',       // Declared here
 *   ...HoverToolComponentType,  // Imported from toolkit
 * }
 */
export const AppComponentType = {
  HEALTH: 'APP_HEALTH',
  INSTANCED_STRESS_TEST_DATA: 'APP_INSTANCED_STRESS_TEST_DATA',
  ...HoverToolComponentType,
  ...FollowToolComponentType,
  ...InstancedMeshPoolComponentType,
} as const;

/**
 * Data types from toolkit and other sources.
 * Examples:
 * type ToolKitComponentData = {};
 * type ToolKitComponentData = HoverComponentData & SomeOtherComponentData;
 */
type ExtraComponentData = HoverComponentData & FollowComponentData & InstancedMeshPoolComponentData;

/** App specific components (extended by ExtraComponentData) */
export interface AppComponentData extends ExtraComponentData {
  [AppComponentType.HEALTH]: { current: number; max: number }; // Example
  [AppComponentType.INSTANCED_STRESS_TEST_DATA]: {
    mesh: THREE.InstancedMesh;
    index: number;
  };
}

export type AppComponentType = (typeof AppComponentType)[keyof typeof AppComponentType];

/** Stages of ECS system invocation */
export enum ECSSystemStage {
  // --- Runs in updateMainLoop (Always runs if MasterPlay is true) ---
  MAIN = 'MAIN',

  // --- Runs in updateAppLoop (Only if AppPlay is true) ---
  APP_PRE_PHYSICS = 'APP_PRE_PHYSICS', // Input handling, logic before physics
  // Runs once per fixed physics sub-step (0-N times per frame), right before that step, with
  // dt = the fixed timestep — for anything that has to move in lockstep with the simulation
  // (kinematic paths, character controllers). Only runs while physics is stepping.
  APP_PHYSICS_STEP = 'APP_PHYSICS_STEP',
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
 * - FRUSTUM_CULLING / LIGHT_CULLING: objectFrustumCullingSystem, then lightObjectCullingSystem
 *   (which depends on this frame's frustum-culling result).
 */
export const APP_RENDER_SYNC_ORDER = {
  POSE_PRODUCERS: 0,
  POSE_CONSUMERS: -0.5,
  FRUSTUM_CULLING: -1,
  LIGHT_CULLING: -2,
} as const;
