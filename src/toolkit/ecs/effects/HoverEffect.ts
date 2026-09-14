/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ECSWorld } from '../../../_engine/core/ECS';
import { CoreComponentType } from '../../../_engine/core/ECS/ECSRegistry';
import { ECSSystemStage } from '../../../AppECSRegistry';

// --- src/toolkit/ecs/systems/HoverEffect.ts ---

/** Internal Key (Values) */
export enum HoverToolComponentType {
  HOVER = 'TOOL_HOVER',
}

/** Internal Data Shape (Types) */
export interface HoverToolData {
  speed: number;
  amplitude: number;
  baseY: number;
  time: number;
}

export interface HoverComponentData {
  [HoverToolComponentType.HOVER]: HoverToolData;
}

/** ECS System */
export const hoverToolSystem = (world: ECSWorld, dt: number) => {
  const storage = world.getStorage(HoverToolComponentType.HOVER as any);
  if (!storage) return;
  const transformStore = world.getTypedTransformStore();

  for (const [entityId, data] of storage) {
    data.time += dt;
    const y = data.baseY + Math.sin(data.time * data.speed) * data.amplitude;

    if (transformStore) {
      const slot = transformStore.getSlot(entityId);
      if (slot === -1) continue;
      transformStore.setPosition(slot, transformStore.posX[slot], y, transformStore.posZ[slot]);
      continue;
    }

    const transform = world.getComponent(entityId, CoreComponentType.TRANSFORM);
    if (!transform) continue;
    transform.position.y = y;
    transform.setDirty();
  }
};

/** The Registration Helper */
export const registerHoverToolEffect = (world: ECSWorld) => {
  world.addSystem(ECSSystemStage.APP_LOGIC, 'hoverToolSystem', hoverToolSystem);
  return world;
};
