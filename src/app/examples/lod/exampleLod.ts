import * as THREE from 'three/webgpu';
import { getECSWorld } from '../../../_engine/core/ECS';
import { getGeometry, saveBufferGeometry } from '../../../_engine/core/Geometry';
import { createInstancedLodPool } from '../../../_engine/core/Instancing/InstancedMeshPool';
import { generateOctahedralImpostor } from '../../../_engine/core/Lod/Impostors/OctahedralImpostor';
import { generateLodChain } from '../../../_engine/core/Lod/LodChains';
import { createMaterial } from '../../../_engine/core/Material';
import { createMeshEntity } from '../../../_engine/core/MeshManager';
import { getRootScene } from '../../../_engine/core/Scene';
import { existsOrThrow } from '../../../_engine/utils/assert';
import { createSeededRandom } from '../../../toolkit/geometry/seededRandom';

const KNOT_ID = 'lodExampleKnot';
/** Bakes at load. To load it instead: export it from the LOD tab's Impostors folder, move its four
 * files next to this scene and list the id in exampleLod.scene.json's `impostors`. */
const IMPOSTOR_ID = 'lodExampleKnotImpostor';
/** The field: rows going away from the camera, columns across */
const ROWS = 20;
const COLUMNS = 9;
const SPACING = 7;

// #region lod-scene (shown in the Hub: hub/pages/examples/lod/)
export const scene = async () => {
  const world = getECSWorld();
  createMeshEntity({
    geo: { id: 'lodGround', type: 'BOX', params: { width: 80, height: 0.2, depth: 200 } },
    mat: { id: 'lodGround', type: 'STANDARD', params: { color: '#6b6f66', roughness: 0.9 } },
    position: { y: -0.1, z: -70 },
    receiveShadow: true,
  });

  // 1. A heavy mesh: a torus knot of 16,384 triangles
  const geometry = saveBufferGeometry(new THREE.TorusKnotGeometry(1.2, 0.38, 256, 32), {
    id: KNOT_ID,
  });
  const material = createMaterial({
    id: 'lodExampleKnot',
    type: 'STANDARD',
    params: { color: '#d9a441', roughness: 0.35, metalness: 0.3 },
  });

  // 2. Its LOD chain: copies simplified to 50, 20 and 6 % of the triangles (in a worker).
  // levels[0] is the knot itself.
  const chain = existsOrThrow(
    await generateLodChain(KNOT_ID, { ratios: [0.5, 0.2, 0.06] }),
    'The knot has no LOD chain.'
  );

  // 3. For the farthest: an octahedral impostor, a quad showing the knot as seen from where the
  // camera is. `hemi`: seen from above only (the knots stand on the ground); `surfaceDepth: false`:
  // a flat quad, the cheapest.
  const impostor = generateOctahedralImpostor(geometry, material, {
    id: IMPOSTOR_ID,
    hemi: true,
    surfaceDepth: false,
  });

  // 4. The levels, finest first. Each is drawn while the knot's height on screen (a fraction of
  // the screen's) is at least its screenSize: the knot from 20 %, the impostor below 4 %.
  const screenSizes = [0.2, 0.12, 0.065, 0.04];
  const levels = [
    ...chain.levels.map((level, i) => ({
      geometry: getGeometry(level.geometryId) as THREE.BufferGeometry,
      material,
      screenSize: screenSizes[i],
    })),
    { geometry: impostor.geometry, material: impostor.material, screenSize: 0 },
  ];

  // 5. Where they stand: a grid, each knot turned a little, standing on the ground
  geometry.computeBoundingBox();
  const y = -geometry.boundingBox!.min.y;
  const random = createSeededRandom(7);
  const placements = Array.from({ length: ROWS * COLUMNS }, (_, i) => ({
    position: new THREE.Vector3(
      ((i % COLUMNS) - (COLUMNS - 1) / 2) * SPACING,
      y,
      -8 - Math.floor(i / COLUMNS) * SPACING
    ),
    quaternion: new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      (random() - 0.5) * 1.5
    ),
    scale: 1,
  }));

  // 6. One instanced pool: a mesh per level, each knot an entity in the one its level draws
  const pool = createInstancedLodPool({ world, levels, maxInstances: placements.length });
  existsOrThrow(getRootScene(), 'No root scene.').add(...pool.meshes);
  pool.spawn(world, placements);
};
// #endregion lod-scene
