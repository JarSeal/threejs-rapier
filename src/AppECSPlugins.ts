import { ECSWorld } from './_engine/core/ECS';
import { registerHoverToolEffect } from './toolkit/ecs/effects/HoverEffect';

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
});
