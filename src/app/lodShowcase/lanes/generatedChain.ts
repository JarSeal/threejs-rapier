import * as THREE from 'three/webgpu';
import { saveBufferGeometry } from '../../../_engine/core/Geometry';
import { resolveAutoLod } from '../../../_engine/core/Lod/LodAuto';
import {
  generateLodChain,
  getLodChain,
  type LodChainOptions,
} from '../../../_engine/core/Lod/LodChains';
import type { LodAutoDef } from '../../../_engine/core/Lod/LodTypes';
import { createMaterial } from '../../../_engine/core/Material';
import { createMeshEntity, setMeshLod } from '../../../_engine/core/MeshManager';
import { getConservativeGeometryRadius } from '../../../_engine/core/Spatial/SpatialIndexSystem';
import type { ShowcaseLane } from '../layout';

/** The heavy procedural mesh lanes 2 and 4 share: 256 × 32 segments, 16,384 triangles. */
export const SHOWCASE_KNOT_GEO_ID = 'lodShowcaseKnot';

/** Its chain: down to 6 % of the triangles (982). Each level's error is about three times the
 * last one's, so their switch distances spread the same way: four levels fit in a lane (18-290 m
 * from the start camera), a fifth at 2 % (error 0.039) would not. */
export const SHOWCASE_KNOT_CHAIN: LodChainOptions = { ratios: [0.5, 0.2, 0.06] };

/** A quarter of AUTO's default pixel: at 1 px the knot keeps level 0 only within 5 m of the camera
 * and level 1 within 14 m, nearer than the lane starts. */
const KNOT_LOD: LodAutoDef = { auto: true, maxPixelError: 0.25 };

/** Registers the torus knot (or returns the registered one) and starts its LOD chain. */
export const getShowcaseKnot = () => {
  const knot = new THREE.TorusKnotGeometry(1.2, 0.38, 256, 32);
  const geometry = saveBufferGeometry(knot, {
    id: SHOWCASE_KNOT_GEO_ID,
    debugData: { name: 'LOD showcase torus knot', description: '256 × 32 segments.' },
  });
  // A cached one (the scene loaded again before its assets were released) is the same knot
  if (geometry !== knot) knot.dispose();
  geometry.computeBoundingBox();
  // generateLodChain replaces an existing chain (a pending one it returns)
  const chain = getLodChain(SHOWCASE_KNOT_GEO_ID)
    ? Promise.resolve(getLodChain(SHOWCASE_KNOT_GEO_ID)!)
    : generateLodChain(SHOWCASE_KNOT_GEO_ID, SHOWCASE_KNOT_CHAIN);
  return { geometry, chain };
};

/**
 * Lane 2: a generated chain (docs/plans/_DONE_p347_lod-chain-generation.md) on plain meshes: a heavy
 * procedural torus knot with an AUTO `lod`, its chain simplified at load (in the assets worker).
 * Each level is used while its simplification error stays within a quarter pixel at 1080p, so the
 * thresholds come from the chain: the lane resolves them first to place the meshes.
 */
export const generatedChainLane: ShowcaseLane = {
  id: 'generatedChain',
  title: 'Generated chain',
  description:
    'A 16k-triangle torus knot with lod { auto: true, maxPixelError: 0.25 }, its LOD chain simplified at load.',
  create: async (ctx) => {
    const { geometry } = getShowcaseKnot();
    const material = createMaterial({
      id: 'lodShowcaseKnotMat',
      type: 'STANDARD',
      params: { color: '#5f8fb4', roughness: 0.35, metalness: 0.3 },
    });
    const radius = getConservativeGeometryRadius(geometry);
    // Standing on the ground (the knot lies in its xy plane, facing the camera)
    const y = -geometry.boundingBox!.min.y;

    const create = (index: number, distance: number) =>
      createMeshEntity(
        {
          geo: geometry,
          mat: material,
          castShadow: true,
          receiveShadow: true,
          position: ctx.placeAt(distance, y),
        },
        {
          appId: `lodShowcaseKnot_${index}`,
          debugData: {
            name: `LOD showcase: generated chain ${index}`,
            description: `${distance.toFixed(0)} m from the start camera.`,
          },
        },
        ctx.world
      );

    // The levels AUTO resolves to (it waits for the chain), to place the meshes by
    const def = await resolveAutoLod(geometry, KNOT_LOD, SHOWCASE_KNOT_GEO_ID);
    if (!def) {
      const id = create(0, 0);
      return { getEntityIds: () => [id], radius, switchDistances: [] };
    }
    const entityIds = ctx.getSlots(radius, def).map((slot, i) => create(i, slot.distance));
    // Each mesh resolves its own, as app code would
    await Promise.all(entityIds.map((id) => setMeshLod(id, KNOT_LOD, ctx.world)));

    return {
      getEntityIds: () => entityIds,
      radius,
      switchDistances: ctx.getSwitchDistances(radius, def),
    };
  },
};
