/* eslint-disable @typescript-eslint/no-explicit-any */
import { ECSSystemStage, ECSWorld } from '../../../_engine/core/ECS';
import { CoreComponentType } from '../../../_engine/core/ECS/ECSRegistry';

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

  for (const [entityId, data] of storage) {
    const transform = world.getComponent(entityId, CoreComponentType.TRANSFORM);
    if (!transform) continue;

    data.time += dt;
    transform.position.y = data.baseY + Math.sin(data.time * data.speed) * data.amplitude;
    transform.setDirty();
  }
};

/** The Registration Helper (chainable) */
export const registerHoverToolEffect = (world: ECSWorld) => {
  world.addSystem(ECSSystemStage.APP_LOGIC, 'hoverToolSystem', hoverToolSystem);
  return world;
};
