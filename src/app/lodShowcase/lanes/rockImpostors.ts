import { saveBufferGeometry } from '../../../_engine/core/Geometry';
import { generateOctahedralImpostor } from '../../../_engine/core/Lod/Impostors/OctahedralImpostor';
import { createMaterial } from '../../../_engine/core/Material';
import { createMeshEntity } from '../../../_engine/core/MeshManager';
import { generateAsteroid } from '../../../toolkit/geometry/generateAsteroid';
import type { ShowcaseLane } from '../layout';

/** largeWorld's rock impostor export, which the scene lists too: built from it. */
const EXPORTED_ID = 'largeWorldRockImpostor';
/** Not listed in the scene: baked at load. */
const BAKED_ID = 'lodShowcaseRockBaked';
/** The rows' distances from the start camera. */
const ROW_DISTANCES = [33, 55, 95];
/** Between the rocks of a row. */
const SPACING = 3;

/**
 * Lane 5: baked against exported (p351 Phase 4). largeWorld's rock (the same seed, shape and
 * material, so its export's fingerprint matches), in rows of three: its octahedral impostor baked
 * at load, the mesh, and the impostor loaded from largeWorld's export. Both impostors are drawn
 * as plain meshes, held at the impostor level (no LOD), so they can be compared with each other
 * and with the mesh at any distance.
 */
export const rockImpostorsLane: ShowcaseLane = {
  id: 'rockImpostors',
  title: 'Baked against exported',
  description:
    'The same rock in rows of three: an octahedral impostor baked at load, the mesh, and the impostor loaded from its export.',
  create: async (ctx) => {
    const rockGeo = saveBufferGeometry(
      generateAsteroid({ seed: 11, shape: [1.25, 0.75, 1] }).geometry,
      { id: 'lodShowcaseRockGeo' }
    );
    const rockMat = createMaterial({
      id: 'lodShowcaseRockMat',
      type: 'PHONG',
      params: { color: '#8f8a80', flatShading: true },
    });
    // Hemi like largeWorld's: the options are part of the export's fingerprint
    const baked = generateOctahedralImpostor(rockGeo, rockMat, { id: BAKED_ID, hemi: true });
    const exported = generateOctahedralImpostor(rockGeo, rockMat, { id: EXPORTED_ID, hemi: true });

    rockGeo.computeBoundingBox();
    // Resting on the ground
    const y = -rockGeo.boundingBox!.min.y;
    const columns = [
      { name: 'baked impostor', geo: baked.geometry, mat: baked.material },
      { name: 'mesh', geo: rockGeo, mat: rockMat },
      { name: 'exported impostor', geo: exported.geometry, mat: exported.material },
    ];

    const entityIds: number[] = [];
    ROW_DISTANCES.forEach((distance, row) => {
      const { x, z } = ctx.placeAt(distance, y);
      columns.forEach((column, i) => {
        entityIds.push(
          createMeshEntity(
            {
              geo: column.geo,
              mat: column.mat,
              castShadow: true,
              receiveShadow: true,
              position: { x: x + (i - 1) * SPACING, y, z },
            },
            {
              appId: `lodShowcaseRock_${row}_${i}`,
              debugData: {
                name: `LOD showcase: rock, ${column.name} (${distance} m)`,
                description: `Lane 5's row at ${distance} m from the start camera: baked impostor, mesh, exported impostor (left to right).`,
              },
            },
            ctx.world
          )
        );
      });
    });

    return { getEntityIds: () => entityIds, radius: 0, switchDistances: [] };
  },
};
