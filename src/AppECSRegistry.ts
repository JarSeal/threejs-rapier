// NOTE! Import only types and everything with "import type ..."
import type * as THREE from 'three/webgpu';
import { HoverToolComponentType, HoverToolData } from './toolkit/ecs/effects/HoverEffect';

/** App components (app specific) */
export const AppComponentType = {
  HEALTH: 'APP_HEALTH',
  INSTANCED_STRESS_TEST_DATA: 'APP_INSTANCED_STRESS_TEST_DATA',
  ...HoverToolComponentType,
} as const;

export type AppComponentType = (typeof AppComponentType)[keyof typeof AppComponentType];

// type ToolKitComponentData = {};
// type ToolKitComponentData = HoverToolData & SomeOtherToolData;
type ToolKitComponentData = HoverToolData & HoverToolData;

export interface AppComponentData extends ToolKitComponentData {
  [AppComponentType.HEALTH]: { current: number; max: number }; // Example
  [AppComponentType.INSTANCED_STRESS_TEST_DATA]: {
    mesh: THREE.InstancedMesh;
    index: number;
  };
}
