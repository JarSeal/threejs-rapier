import { ECSWorld } from './_engine/core/ECS';
import { registerHoverToolEffect } from './toolkit/ecs/effects/HoverEffect';
import { registerFollowToolEffect } from './toolkit/ecs/effects/FollowTool';
import { registerInstancedMeshPoolEffect } from './toolkit/ecs/InstancedMeshPool';

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
});
