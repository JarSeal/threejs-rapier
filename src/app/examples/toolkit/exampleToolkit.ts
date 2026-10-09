import { getECSWorld } from '../../../_engine/core/ECS';
import { ComponentType } from '../../../_engine/core/ECS/ECSCoreComponents';
import { getMaterial } from '../../../_engine/core/Material';
import { createMeshEntity } from '../../../_engine/core/MeshManager';
import { existsOrThrow } from '../../../_engine/utils/assert';

// #region toolkit-scene (shown in the Hub: hub/pages/examples/toolkit/)
export const scene = async () => {
  const world = getECSWorld();

  // The toolkit's materials, listed in the scene JSON
  const grid = existsOrThrow(getMaterial('triplanarGrid'), 'No triplanarGrid material.');
  const checker = existsOrThrow(
    getMaterial('triplanarCheckerboard'),
    'No triplanarCheckerboard material.'
  );

  createMeshEntity({
    geo: { id: 'toolkitGround', type: 'BOX', params: { width: 10, height: 0.2, depth: 10 } },
    mat: grid,
    position: { y: -0.1 },
    receiveShadow: true,
  });

  // The Æ symbol, imported from the toolkit's aekashaSymbol.importedAsset.json (the scene JSON
  // lists it): its geometry id is `<import id>/<node name>`. Two of them, the second a variant of
  // the material with its own checker colours (`matOverrides`).
  const symbols = [
    { x: -1.3, baseY: 1.4, overrides: undefined },
    {
      x: 1.3,
      baseY: 1.6,
      overrides: { nodes: { colorNode: { checkerColorA: '#e8833a', checkerColorB: '#c96a26' } } },
    },
  ];
  for (const { x, baseY, overrides } of symbols) {
    const symbolId = createMeshEntity({
      geo: 'aekashaSymbol/aekashaSymbol',
      mat: checker,
      matOverrides: overrides,
      position: { x, y: baseY },
      scale: { x: 1.6, y: 1.6, z: 1.6 },
      castShadow: true,
      receiveShadow: true,
    });
    // The toolkit's HoverEffect, out of step so they don't bob together
    world.addComponent(symbolId, ComponentType.HOVER, {
      speed: 1.2,
      amplitude: 0.15,
      baseY,
      time: x,
    });
  }
};
// #endregion toolkit-scene
