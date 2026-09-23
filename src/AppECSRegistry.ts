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
  APP_LOGIC = 'APP_LOGIC', // Standard gameplay systems
  APP_RENDER_SYNC = 'APP_RENDER_SYNC', // transformToMesh (Syncing ECS to Three.js)

  // --- Runs in updateLateMainLoop (After rendering) ---
  LATE_MAIN = 'LATE_MAIN',
}
