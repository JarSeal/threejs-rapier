import { ECSWorld } from './_engine/core/ECS';
import { registerHoverToolEffect } from './toolkit/ecs/effects/HoverEffect';
import { registerFollowToolEffect } from './toolkit/ecs/effects/FollowTool';
import { registerSunShadowFitEffect } from './toolkit/ecs/effects/SunShadowFit';
import { registerMutualGravityEffect } from './toolkit/ecs/effects/MutualGravity';
import { registerMovingPlatformSystem } from './_engine/utils/world/movingPlatform';
import { registerFollowObjectCameraRigSystem } from './_engine/utils/cameras/followObjectCameraRig';
import { registerSpinSystem } from './app/examples/ecs/SpinSystem';

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

// #region ecs-register-plugin (shown in the Hub: hub/pages/examples/ecs/)
// Runs for every ECS world, the ones that exist and every one created later
ECSWorld.registerPlugin((world) => {
  registerHoverToolEffect(world);
  registerFollowToolEffect(world);
  registerSunShadowFitEffect(world);
  registerMutualGravityEffect(world);
  registerMovingPlatformSystem(world);
  registerFollowObjectCameraRigSystem(world);
  registerSpinSystem(world);
});
// #endregion ecs-register-plugin
