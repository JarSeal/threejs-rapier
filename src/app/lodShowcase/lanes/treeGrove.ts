import * as THREE from 'three/webgpu';
import { saveBufferGeometry } from '../../../_engine/core/Geometry';
import { createInstancedLodPool } from '../../../_engine/core/Instancing/InstancedMeshPool';
import { generateCrossQuads } from '../../../_engine/core/Lod/Impostors/CrossQuads';
import type { LodDef } from '../../../_engine/core/Lod/LodTypes';
import { createMaterial } from '../../../_engine/core/Material';
import { getConservativeGeometryRadius } from '../../../_engine/core/Spatial/SpatialIndexSystem';
import { generateTreeGeometry } from '../../../toolkit/geometry/generateFoliage';
import { createSeededRandom } from '../../../toolkit/geometry/seededRandom';
import type { ShowcaseLane } from '../layout';

/** The cross-quads' export (src/app/impostors/), listed in lodShowcase.scene.json's `impostors`. */
const CROSS_ID = 'lodShowcaseTreeCross';
const TREE = { trunkHeight: 1.4, foliageRadius: 1.2, foliageHeight: 3 };
/** Trees per level band. */
const PER_BAND = 3;
/** How far a tree stands off the lane's line, at most. */
const JITTER_X = 1.5;

/**
 * Lane 3: an instanced LOD pool and cross-quads (docs/plans/_DONE_p348_ecs-lod-selection.md, and
 * p351 Phases 1-2 and 4): a grove of largeWorld's trees (its generators, larger and with more
 * segments) at 8 and 4 radial segments, then three alpha-cut planes with the tree baked on them,
 * loaded from their export. Past the last band the trees fade out.
 */
export const treeGroveLane: ShowcaseLane = {
  id: 'treeGrove',
  title: 'Pool and cross-quads',
  description:
    'An instanced LOD pool of trees: two mesh levels, exported cross-quads, then a cull fade.',
  create: async (ctx) => {
    const geometry = saveBufferGeometry(
      generateTreeGeometry({ ...TREE, radialSegments: 8 }).geometry,
      { id: 'lodShowcaseTreeGeo' }
    );
    const lod1Geometry = saveBufferGeometry(
      generateTreeGeometry({ ...TREE, radialSegments: 4 }).geometry,
      { id: 'lodShowcaseTreeLod1Geo' }
    );
    const materials = [
      createMaterial({
        id: 'lodShowcaseTreeTrunkMat',
        type: 'PHONG',
        params: { color: '#5b3a29' },
      }),
      createMaterial({
        id: 'lodShowcaseTreeFoliageMat',
        type: 'PHONG',
        params: { color: '#2f6a3a', flatShading: true },
      }),
    ];
    // Built from its export, so nothing is baked at load; re-export it from the LOD tab's
    // Impostors after changing the tree
    const cross = generateCrossQuads(geometry, materials, { id: CROSS_ID });

    // From the start camera (fov 50) a tree (LOD radius 4.26) crosses 0.15 at 61 m, 0.075 at 122 m
    // and hides below 0.04, from 228 m (254 m on the way out)
    const lod: Omit<LodDef, 'levels'> = { cullScreenSize: 0.04 };
    const levels = [
      { geometry, material: materials, screenSize: 0.15 },
      { geometry: lod1Geometry, material: materials, screenSize: 0.075 },
      { geometry: cross.geometry, material: cross.material, screenSize: 0 },
    ];
    const def: LodDef = { ...lod, levels: levels.map(({ screenSize }) => ({ screenSize })) };
    const radius = getConservativeGeometryRadius(geometry);

    const random = createSeededRandom(7);
    const placements = ctx.getSlots(radius, def, PER_BAND).map((slot) => {
      // The tree's origin is its base, which the selection measures from
      const { x, z } = ctx.placeAt(slot.distance, 0);
      return {
        position: new THREE.Vector3(x + (random() * 2 - 1) * JITTER_X, 0, z),
        quaternion: new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          random() * Math.PI * 2
        ),
        scale: 1,
      };
    });

    const pool = createInstancedLodPool({
      world: ctx.world,
      levels,
      lod,
      maxInstances: placements.length,
      receiveShadow: true,
    });
    ctx.rootScene.add(...pool.meshes);
    const entityIds = pool.spawn(ctx.world, placements);

    return {
      getEntityIds: () => entityIds,
      radius,
      switchDistances: ctx.getSwitchDistances(radius, def),
    };
  },
};
