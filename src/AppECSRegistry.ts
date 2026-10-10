// NOTE! Import only types and everything with "import type ..."
import type * as THREE from 'three/webgpu';
import type { HoverComponentData } from './toolkit/ecs/effects/HoverEffect';
import { HoverToolComponentType } from './toolkit/ecs/effects/HoverEffect';
import type { FollowComponentData } from './toolkit/ecs/effects/FollowTool';
import { FollowToolComponentType } from './toolkit/ecs/effects/FollowTool';
import type { SunShadowFitComponentData } from './toolkit/ecs/effects/SunShadowFit';
import { SunShadowFitComponentType } from './toolkit/ecs/effects/SunShadowFit';
import type { SpinComponentData } from './app/examples/ecs/SpinComponent';
import { SpinComponentType } from './app/examples/ecs/SpinComponent';

/**
 * App and toolkit components (app specific)
 * Example:
 * {
 *   HEALTH: 'APP_HEALTH',       // Declared here
 *   ...HoverToolComponentType,  // Imported from toolkit
 * }
 */
// #region ecs-component-types (shown in the Hub: hub/pages/examples/ecs/)
export const AppComponentType = {
  HEALTH: 'APP_HEALTH',
  INSTANCED_STRESS_TEST_DATA: 'APP_INSTANCED_STRESS_TEST_DATA',
  ...HoverToolComponentType,
  ...FollowToolComponentType,
  ...SunShadowFitComponentType,
  ...SpinComponentType,
} as const;
// #endregion ecs-component-types

/**
 * Data types from toolkit and other sources.
 * Examples:
 * type ToolKitComponentData = {};
 * type ToolKitComponentData = HoverComponentData & SomeOtherComponentData;
 */
// #region ecs-component-data (shown in the Hub: hub/pages/examples/ecs/)
type ExtraComponentData = HoverComponentData &
  FollowComponentData &
  SunShadowFitComponentData &
  SpinComponentData;
// #endregion ecs-component-data

/** App specific components (extended by ExtraComponentData) */
export interface AppComponentData extends ExtraComponentData {
  [AppComponentType.HEALTH]: { current: number; max: number }; // Example
  [AppComponentType.INSTANCED_STRESS_TEST_DATA]: {
    mesh: THREE.InstancedMesh;
    index: number;
  };
}

export type AppComponentType = (typeof AppComponentType)[keyof typeof AppComponentType];
