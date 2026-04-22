// NO OTHER LOCAL IMPORTS ALLOWED HERE
// import { AppComponentType } from '../../../AppECSRegistry';

/** Engine Core Components */
export enum CoreComponentType {
  APP_ID = 'CORE_APP_ID',
  TRANSFORM = 'CORE_TRANSFORM',
  DISABLED = 'CORE_DISABLED',
  PERSISTENT = 'CORE_PERSISTENT',
  USER_DATA = 'CORE_USER_DATA',
  LIFETIME = 'CORE_LIFETIME',
  OBJECT3D = 'CORE_OBJECT3D',
  TARGET_LINK = 'CORE_TARGET_LINK',
  CAMERA_SETTINGS = 'CORE_CAMERA_SETTINGS',
  ORBIT_CONTROLS = 'CORE_ORBIT_CONTROLS',
  // Physics
  COLLIDER = 'CORE_COLLIDER',
  BODY_DYNAMIC_VISUAL = 'CORE_BODY_DYNAMIC_VISUAL', // Moving + Has Mesh
  BODY_DYNAMIC_HEADLESS = 'CORE_BODY_DYNAMIC_HEADLESS', // Moving + No Mesh
  BODY_STATIC = 'CORE_BODY_STATIC', // Never moves
  // Tags
  TAG_IS_MESH = 'CORE_TAG_IS_MESH',
  TAG_IS_GROUP = 'CORE_TAG_IS_GROUP',
  TAG_IS_LIGHT = 'CORE_TAG_IS_LIGHT',
  TAG_IS_AMBIENT_LIGHT = 'CORE_IS_AMBIENT_LIGHT',
  TAG_IS_HEMISPHERE_LIGHT = 'CORE_IS_HEMISPHERE_LIGHT',
  TAG_IS_POINT_LIGHT = 'CORE_IS_POINT_LIGHT',
  TAG_IS_DIRECTIONAL_LIGHT = 'CORE_IS_DIRECTIONAL_LIGHT',
  TAG_IS_SPOT_LIGHT = 'CORE_IS_SPOT_LIGHT',
  TAG_IS_CAMERA = 'CORE_TAG_IS_CAMERA',
  TAG_IS_MAIN_CAMERA = 'CORE_TAG_IS_MAIN_CAMERA',
  TAG_IS_CHARACTER = 'CORE_TAG_IS_CHARACTER',
  TAG_IS_PHYSICS_OBJECT = 'CORE_TAG_IS_PHYSICS_OBJECT',
  // Debug
  DEBUG_DATA = 'CORE_DEBUG_DATA',
  DEBUG_LIGHT_HELPER = 'CORE_DEBUG_LIGHT_HELPER',
  DEBUG_CAMERA_HELPER = 'CORE_DEBUG_CAMERA_HELPER',
  DEBUG_TAG_IS_DEBUG_CAMERA = 'CORE_DEBUG_IS_DEBUG_CAMERA',
}

// export const ComponentType = {
//   ...CoreComponentType,
//   ...AppComponentType,
// } as const;

// export type ComponentType = (typeof ComponentType)[keyof typeof ComponentType];

export type EntityDebugData = {
  name?: string;
  description?: string;
  comments?: { timestamp: number; comment: string }[];
  todo?: { [key: string]: unknown };
  debugObj?: Record<string, unknown>;
};
