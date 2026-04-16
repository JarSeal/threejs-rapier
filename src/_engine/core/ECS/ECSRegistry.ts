// NO OTHER LOCAL IMPORTS ALLOWED HERE
import { AppComponentType } from '../../../AppECSRegistry';

/** Engine Core Components */
export enum CoreComponentType {
  APP_ID = 'CORE_APP_ID',
  TRANSFORM = 'CORE_TRANSFORM',
  DISABLED = 'CORE_DISABLED',
  PERSISTENT = 'CORE_PERSISTENT',
  USER_DATA = 'CORE_USER_DATA',
  LIFETIME = 'CORE_LIFETIME',
  OBJECT3D = 'CORE_MESH',
  COLLIDER = 'CORE_COLLIDER',
  // Movement Buckets
  BODY_DYNAMIC_VISUAL = 'CORE_BODY_DYNAMIC_VISUAL', // Moving + Has Mesh
  BODY_DYNAMIC_HEADLESS = 'CORE_BODY_DYNAMIC_HEADLESS', // Moving + No Mesh
  BODY_STATIC = 'CORE_BODY_STATIC', // Never moves
  // Tags
  TAG_IS_MESH = 'CORE_TAG_IS_MESH',
  TAG_IS_GROUP = 'CORE_TAG_IS_GROUP',
  TAG_IS_LIGHT = 'CORE_TAG_IS_LIGHT',
  TAG_IS_CAMERA = 'CORE_TAG_IS_CAMERA',
  TAG_IS_CHARACTER = 'CORE_TAG_IS_CHARACTER',
  TAG_IS_PHYSICS_OBJECT = 'CORE_TAG_IS_PHYSICS_OBJECT',
  // Debug
  DEBUG_DATA = 'CORE_DEBUG_DATA',
}

export const ComponentType = {
  ...CoreComponentType,
  ...AppComponentType,
} as const;

export type ComponentType = (typeof ComponentType)[keyof typeof ComponentType];

export type EntityDebugData = {
  name?: string;
  description?: string;
  comments?: { timestamp: number; comment: string }[];
  debugObj?: Record<string, unknown>;
};
