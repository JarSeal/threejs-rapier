import { ECSWorld } from './_engine/core/ECS';
import { registerHoverToolEffect } from './toolkit/ecs/effects/HoverEffect';
import { registerFollowToolEffect } from './toolkit/ecs/effects/FollowTool';
import { registerInstancedMeshPoolEffect } from './toolkit/ecs/InstancedMeshPool';
import { registerMovingPlatformSystem } from './_engine/utils/world/movingPlatform';
import { registerFollowObjectCameraRigSystem } from './_engine/utils/cameras/followObjectCameraRig';
import { registerDynamicCharacterSystem } from './_engine/utils/character/dynamicCharacter';

/**
 * IMPORT YOUR MANAGERS HERE
 * This triggers their static ECSWorld.registerPlugin()
 * and ECSWorld.registerComponentHooks() calls.
 * Example:
 *
 * import './app/managers/CombatManager.ts
 *
 * and/or
 *
 * ECSWorld.registerPlugin((world) => {
 *   registerHoverToolEffect()
 * });
 *
 */

ECSWorld.registerPlugin((world) => {
  registerHoverToolEffect(world);
  registerFollowToolEffect(world);
  registerInstancedMeshPoolEffect(world);
  registerMovingPlatformSystem(world);
  registerFollowObjectCameraRigSystem(world);
  registerDynamicCharacterSystem(world);
});
