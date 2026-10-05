// NO OTHER LOCAL IMPORTS ALLOWED HERE

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
  LINE = 'CORE_LINE',
  /** An entity a manager owns and drives (eg. a sky box's sun light), see ManagedByData. */
  MANAGED_BY = 'CORE_MANAGED_BY',
  /** A character's registry entry (Character.ts's createCharacter), see CharacterObject. */
  CHARACTER = 'CORE_CHARACTER',
  // Physics
  COLLIDER = 'CORE_COLLIDER',
  BODY_DYNAMIC_VISUAL = 'CORE_BODY_DYNAMIC_VISUAL', // Moving + Has Mesh
  BODY_DYNAMIC_HEADLESS = 'CORE_BODY_DYNAMIC_HEADLESS', // Moving + No Mesh
  BODY_STATIC = 'CORE_BODY_STATIC', // Never moves
  // Tags
  TAG_IS_MESH = 'CORE_TAG_IS_MESH',
  TAG_IS_GROUP = 'CORE_TAG_IS_GROUP',
  TAG_IS_LINE = 'CORE_TAG_IS_LINE',
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
  // Frustum culling
  FRUSTUM_CULLING_ENABLED = 'CORE_FRUSTUM_CULLING_ENABLED', // opt-in, user-authored
  TAG_FRUSTUM_CULLED = 'CORE_TAG_FRUSTUM_CULLED', // runtime-only, current culled state
  // Object (contribution) culling — see ECS/LightObjectCullingSystem.ts
  OBJECT_CULLING_ENABLED = 'CORE_OBJECT_CULLING_ENABLED', // opt-in, user-authored
  TAG_OBJECT_CULLED = 'CORE_TAG_OBJECT_CULLED', // runtime-only, current culled state
  // Spatial index (docs/plans/_DONE_p050_spatial-index.md)
  SPATIAL_INDEXED = 'CORE_SPATIAL_INDEXED', // opt-in, membership in the DEFAULT spatial domain
  SPATIAL_DOMAINS = 'CORE_SPATIAL_DOMAINS', // runtime-only, membership in the other spatial domains
  // LOD selection (docs/plans/p348_ecs-lod-selection.md) — see Lod/LodSystem.ts
  LOD = 'CORE_LOD', // opt-in, user-authored
  TAG_LOD_CULLED = 'CORE_TAG_LOD_CULLED', // runtime-only, beyond the last level
  // Instanced mesh pools — see Instancing/InstancedMeshPool.ts
  INSTANCED_MESH_SLOT = 'CORE_INSTANCED_MESH_SLOT', // runtime-only, set by a pool's spawn
  // Debug
  DEBUG_DATA = 'CORE_DEBUG_DATA',
  DEBUG_LIGHT_HELPER = 'CORE_DEBUG_LIGHT_HELPER',
  DEBUG_CAMERA_HELPER = 'CORE_DEBUG_CAMERA_HELPER',
  DEBUG_SYMBOL = 'CORE_DEBUG_SYMBOL',
  DEBUG_PHYSICS_WIREFRAME = 'CORE_DEBUG_PHYSICS_WIREFRAME',
  DEBUG_TAG_IS_DEBUG_CAMERA = 'CORE_DEBUG_IS_DEBUG_CAMERA',
}

/**
 * Marks an entity as owned by a manager, which creates, drives and deletes it (only created in
 * code, never from JSON). Tools treat it as read-only: no persisted debug overrides, no editing
 * or deleting from the debugger, no undo entries.
 */
export type ManagedByData = {
  /** The manager's id, eg. 'SKYBOX'. */
  manager: string;
  /** The owner within that manager, eg. the sky box id. */
  ownerId: string;
  /** What the entity is for its owner, eg. 'SUN_0'. */
  role: string;
};

export type EntityDebugData = {
  name?: string;
  description?: string;
  comments?: { timestamp: number; comment: string }[];
  todo?: { [key: string]: unknown };
  debugObj?: Record<string, unknown>;
};
