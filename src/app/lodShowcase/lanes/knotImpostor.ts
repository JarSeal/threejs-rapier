import * as THREE from 'three/webgpu';
import { getGeometry } from '../../../_engine/core/Geometry';
import { createInstancedLodPool } from '../../../_engine/core/Instancing/InstancedMeshPool';
import { generateOctahedralImpostor } from '../../../_engine/core/Lod/Impostors/OctahedralImpostor';
import type { LodDef } from '../../../_engine/core/Lod/LodTypes';
import { getConservativeGeometryRadius } from '../../../_engine/core/Spatial/SpatialIndexSystem';
import { existsOrThrow } from '../../../_engine/utils/assert';
import { createSeededRandom } from '../../../toolkit/geometry/seededRandom';
import type { ShowcaseLane } from '../layout';
import { getShowcaseKnot, getShowcaseKnotMaterial } from './generatedChain';

/** The impostor's export (src/app/impostors/), listed in lodShowcase.scene.json's `impostors`. */
export const KNOT_IMPOSTOR_ID = 'lodShowcaseKnotImpostor';

/** The chain's levels' screen sizes, then the impostor's (0). From the start camera (fov 50) a
 * knot (LOD radius 2.49) crosses them at 27, 44, 82 and 133 m: the impostor from 148 m on the way
 * out. */
const SCREEN_SIZES = [0.2, 0.12, 0.065, 0.04, 0];
/** Knots per level band: more in the impostor's, where the lane is longest. A knot is 5 m wide:
 * more on the lane's line hide each other from the start camera. */
const PER_BAND = [1, 1, 1, 1, 4];

/**
 * Lane 4: an instanced LOD pool and an octahedral impostor (p351 Phases 3-4): lane 2's torus knot
 * (16,384 triangles) through its generated chain's levels (8,192, 3,276, 982), then a hemi
 * octahedral impostor loaded from its export: one quad instead of 982 triangles. The heavy mesh is
 * where an impostor pays off (largeWorld's 80-triangle rock doesn't, Phase 3 section 5), and the
 * flat one pays off against the chain's last level too.
 */
export const knotImpostorLane: ShowcaseLane = {
  id: 'knotImpostor',
  title: 'Pool and octahedral impostor',
  description:
    "An instanced LOD pool of lane 2's torus knot: its chain's levels, then an exported octahedral impostor.",
  create: async (ctx) => {
    const { geometry, chain: chainPromise } = getShowcaseKnot();
    const material = getShowcaseKnotMaterial();
    const chain = existsOrThrow(await chainPromise, 'The torus knot has no LOD chain.');
    const chainGeometries = chain.levels.map((level) =>
      existsOrThrow(
        getGeometry(level.geometryId) as THREE.BufferGeometry | undefined,
        `The torus knot's LOD level "${level.geometryId}" isn't registered.`
      )
    );
    // Hemi: the knots turn about y only and stand on the ground, so nothing sees them from below.
    // Flat (no surface depth): writing depth from the shader turns off a tile GPU's hidden-surface
    // removal, and with it the impostor costs more than the 982-triangle level it replaces (400
    // knots at the impostor's distances, Apple GPU: +0.44 ms against +0.13; flat +0.08). The flat
    // quad suits objects standing on the ground; lane 5's rocks show the surface depth.
    // Built from its export, so nothing is baked at load; re-export it from the LOD tab's
    // Impostors after changing the knot or its material
    const impostor = generateOctahedralImpostor(geometry, material, {
      id: KNOT_IMPOSTOR_ID,
      hemi: true,
      surfaceDepth: false,
    });

    const levels = [
      ...chainGeometries.map((levelGeometry, i) => ({
        geometry: levelGeometry,
        material,
        screenSize: SCREEN_SIZES[i],
      })),
      {
        geometry: impostor.geometry,
        material: impostor.material,
        screenSize: SCREEN_SIZES[chainGeometries.length],
      },
    ];
    const def: LodDef = { levels: levels.map(({ screenSize }) => ({ screenSize })) };
    const radius = getConservativeGeometryRadius(geometry);
    // Standing on the ground (the knot lies in its xy plane)
    geometry.computeBoundingBox();
    const y = -geometry.boundingBox!.min.y;

    const random = createSeededRandom(13);
    const up = new THREE.Vector3(0, 1, 0);
    const placements = ctx.getSlots(radius, def, PER_BAND).map((slot) => {
      const { x, z } = ctx.placeAt(slot.distance, y);
      return {
        position: new THREE.Vector3(x, y, z),
        // Mostly facing the camera, so its holes show
        quaternion: new THREE.Quaternion().setFromAxisAngle(up, (random() - 0.5) * 1.2),
        scale: 1,
      };
    });

    const pool = createInstancedLodPool({
      world: ctx.world,
      levels,
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
