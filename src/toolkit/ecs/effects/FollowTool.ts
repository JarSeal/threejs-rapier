/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import type { ECSWorld } from '../../../_engine/core/ECS';
import { CoreComponentType } from '../../../_engine/core/ECS/ECSRegistry';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ComponentType } from '../../../_engine/core/ECS/ECSRegistry';

/** Internal Key (Values) */
export enum FollowToolComponentType {
  FOLLOW = 'TOOL_FOLLOW',
}

/** Internal Data Shape (Types) */
export interface FollowToolData {
  /** The entityId of the leader (usually the Player) */
  leaderId: number;
  /** Fixed offset for the Light Source relative to the leader */
  offset: THREE.Vector3;
  /** Fixed offset for the Light Target relative to the leader (ignored for Point Lights) */
  targetOffset: THREE.Vector3;
  /** * Follow speed.
   * Higher = snappier, Lower = lazier.
   * Use 0 for instant snapping.
   */
  speed: number;
}

export interface FollowComponentData {
  [FollowToolComponentType.FOLLOW]: FollowToolData;
}

// Scratchpad vector to prevent garbage collection stutters
const _targetPos = new THREE.Vector3();

/** ECS System */
export const followToolSystem = (world: ECSWorld, dt: number) => {
  const storage = world.getStorage(FollowToolComponentType.FOLLOW as any);
  if (!storage) return;

  for (const [entityId, data] of storage) {
    // 1. Get the Leader's position
    const leaderTransform = world.getComponent(data.leaderId, CoreComponentType.TRANSFORM);
    if (!leaderTransform) continue;

    // Framerate independent alpha calculation
    // If speed is 0, we treat it as an instant snap (alpha 1)
    const alpha = data.speed <= 0 ? 1 : 1 - Math.exp(-data.speed * dt);

    // 2. Update the Light Source Entity
    const lightTransform = world.getComponent(entityId, CoreComponentType.TRANSFORM);
    if (lightTransform) {
      _targetPos.copy(leaderTransform.position).add(data.offset);

      if (alpha >= 1) {
        lightTransform.position.copy(_targetPos);
      } else {
        lightTransform.position.lerp(_targetPos, alpha);
      }

      lightTransform.setDirty();
    }

    // 3. Update the Light Target Entity (Only if it exists)
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink) {
      const targetTransform = world.getComponent(targetLink.targetId, CoreComponentType.TRANSFORM);
      if (targetTransform) {
        _targetPos.copy(leaderTransform.position).add(data.targetOffset);

        if (alpha >= 1) {
          targetTransform.position.copy(_targetPos);
        } else {
          targetTransform.position.lerp(_targetPos, alpha);
        }

        targetTransform.setDirty();
      }
    }
  }
};

/** The Registration Helper */
export const registerFollowToolEffect = (world: ECSWorld) => {
  // We use APP_LOGIC to ensure the follow happens before the Render Sync stage
  world.addSystem(ECSSystemStage.APP_LOGIC, 'followToolSystem', followToolSystem);
  return world;
};
