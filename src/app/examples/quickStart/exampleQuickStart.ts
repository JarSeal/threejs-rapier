import { getECSWorld } from '../../../_engine/core/ECS';
import { ComponentType } from '../../../_engine/core/ECS/ECSCoreComponents';
import { getMaterial } from '../../../_engine/core/Material';
import { createMeshEntity } from '../../../_engine/core/MeshManager';
import { existsOrThrow } from '../../../_engine/utils/assert';

// #region quick-start (shown in the Hub: hub/pages/examples/)
export const scene = async () => {
  // The camera and the lights come from the scene JSON. A ground to cast a shadow on:
  createMeshEntity({
    geo: { id: 'quickStartGround', type: 'BOX', params: { width: 12, height: 0.2, depth: 12 } },
    mat: { id: 'quickStartGround', type: 'STANDARD', params: { color: '#59606e' } },
    position: { y: -0.1 },
    receiveShadow: true,
  });

  // A cube with the toolkit's checkerBoard material, which the scene JSON lists
  const cubeId = createMeshEntity({
    geo: { id: 'quickStartCube', type: 'BOX' },
    mat: existsOrThrow(getMaterial('checkerBoard'), 'No checkerBoard material.'),
    position: { y: 1.5 },
    castShadow: true,
  });

  // The toolkit's HoverEffect bobs it (its system is registered in src/AppECSPlugins.ts)
  getECSWorld().addComponent(cubeId, ComponentType.HOVER, {
    speed: 1.5,
    amplitude: 0.25,
    baseY: 1.5,
    time: 0,
  });
};
// #endregion quick-start
