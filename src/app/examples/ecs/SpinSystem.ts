import * as THREE from 'three/webgpu';
import type { ECSWorld } from '../../../_engine/core/ECS';
import { SpinComponentType } from './SpinComponent';
import { ECSSystemStage } from '../../../_engine/core/ECS/SystemStages';

// #region spin-system (shown in the Hub: hub/pages/examples/ecs/)
// Scratch objects, reused every frame: a system that runs for every entity shouldn't allocate
const axis = new THREE.Vector3();
const turn = new THREE.Quaternion();

/** Turns every entity with a SPIN component by its speed × the frame's time */
export const spinSystem = (world: ECSWorld, dt: number) => {
  for (const [entityId, spin] of world.getStorage(SpinComponentType.SPIN)) {
    const rotation = world.getRotation(entityId);
    if (!rotation) continue;
    axis.set(spin.axis.x, spin.axis.y, spin.axis.z).normalize();
    rotation.multiply(turn.setFromAxisAngle(axis, spin.speed * dt));
    world.setTransform(entityId, { rot: rotation });
  }
};

/** Adds the system to a world, at the stage where gameplay systems run */
export const registerSpinSystem = (world: ECSWorld) =>
  world.addSystem(ECSSystemStage.APP_LOGIC, 'exampleSpin', spinSystem);
// #endregion spin-system
