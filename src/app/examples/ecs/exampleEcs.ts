import { getECSWorld } from '../../../_engine/core/ECS';
import { ComponentType } from '../../../_engine/core/ECS/ECSCoreComponents';
import { createMeshEntity } from '../../../_engine/core/MeshManager';

// #region ecs-scene (shown in the Hub: hub/pages/examples/ecs/)
export const scene = async () => {
  const world = getECSWorld();

  createMeshEntity({
    geo: { id: 'ecsGround', type: 'BOX', params: { width: 14, height: 0.2, depth: 8 } },
    mat: { id: 'ecsGround', type: 'STANDARD', params: { color: '#59606e' } },
    position: { y: -0.1 },
    receiveShadow: true,
  });

  // Each shape turns about its own axis at its own speed: that's all in its SPIN data
  const shapes = [
    { x: -4.5, color: '#e8833a', axis: { x: 0, y: 1, z: 0 }, speed: 0.6 },
    { x: -1.5, color: '#4fa3d9', axis: { x: 1, y: 0, z: 0 }, speed: 1.2 },
    { x: 1.5, color: '#7cc46b', axis: { x: 1, y: 1, z: 0 }, speed: 2 },
    { x: 4.5, color: '#c26bc4', axis: { x: 0, y: 1, z: 1 }, speed: -1 },
  ];
  const ids = shapes.map(({ x, color, axis, speed }, i) => {
    const entityId = createMeshEntity({
      geo: { id: 'ecsBox', type: 'BOX', params: { width: 1.4, height: 1.4, depth: 1.4 } },
      mat: { id: `ecsBox${i}`, type: 'STANDARD', params: { color } },
      position: { x, y: 1.6 },
      castShadow: true,
    });
    world.addComponent(entityId, ComponentType.SPIN, { axis, speed });
    return entityId;
  });

  // Components combine: the last one hovers too, the toolkit's HOVER moving it as SPIN turns it
  world.addComponent(ids[3], ComponentType.HOVER, {
    speed: 1.5,
    amplitude: 0.4,
    baseY: 1.6,
    time: 0,
  });
};
// #endregion ecs-scene
