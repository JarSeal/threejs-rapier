import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';

/** Roughness along each sphere row, front (south) to back (north). */
const ROUGHNESS = [0, 0.2, 0.4, 0.6, 0.8, 1];
const SPHERE_RADIUS = 0.45;
const SPHERE_SPACING = 1.5;

/**
 * The sky box verification scene (p113-p115). The camera and the `dayNight` sky box come from
 * `skyShowcase.scene.json`; the sky box owns every light. Built here: a ground, a row of metal
 * and a row of dielectric spheres (PBR, so they show the environment bake: sharp to blurred
 * reflections of the sky), and a stone gate that casts long shadows at sunset.
 */
export const scene = async () => {
  const updateLoaderFn = getLoaderStatusUpdater();
  updateLoaderFn({ loadedCount: 0, totalCount: 1 });

  createMeshEntity(
    {
      geo: { type: 'BOX', params: { width: 60, height: 0.2, depth: 60 } },
      mat: createMaterial({
        id: 'skyShowcaseGroundMat',
        type: 'STANDARD',
        params: { color: '#6b6f66', roughness: 0.9, metalness: 0 },
      }),
      position: { x: 0, y: -0.1, z: 0 },
      receiveShadow: true,
    },
    { appId: 'skyShowcaseGround', debugData: { name: 'Sky showcase ground' } }
  );

  const rows = [
    { name: 'Metal', x: 0, metalness: 1, color: '#d9d9d9' },
    { name: 'Dielectric', x: -1.4, metalness: 0, color: '#e8e4dc' },
  ];
  for (const row of rows) {
    ROUGHNESS.forEach((roughness, i) => {
      const id = `skyShowcase${row.name}Sphere${i}`;
      createMeshEntity(
        {
          geo: {
            type: 'SPHERE',
            params: { radius: SPHERE_RADIUS, widthSegments: 48, heightSegments: 32 },
          },
          mat: createMaterial({
            id: `${id}Mat`,
            type: 'STANDARD',
            params: { color: row.color, metalness: row.metalness, roughness },
          }),
          position: {
            x: row.x,
            y: SPHERE_RADIUS,
            z: (i - (ROUGHNESS.length - 1) / 2) * SPHERE_SPACING,
          },
          castShadow: true,
          receiveShadow: true,
        },
        { appId: id, debugData: { name: `${row.name} sphere, roughness ${roughness}` } }
      );
    });
  }

  // A stone gate west of the spheres: two pillars and a lintel
  const stone = createMaterial({
    id: 'skyShowcaseStoneMat',
    type: 'STANDARD',
    params: { color: '#9a938a', roughness: 0.85, metalness: 0 },
  });
  for (const z of [-4.5, 4.5]) {
    createMeshEntity(
      {
        geo: { type: 'CYLINDER', params: { radiusTop: 0.35, radiusBottom: 0.4, height: 3.2 } },
        mat: stone,
        position: { x: -4.5, y: 1.6, z },
        castShadow: true,
        receiveShadow: true,
      },
      { appId: `skyShowcasePillar${z < 0 ? 'North' : 'South'}` }
    );
  }
  createMeshEntity(
    {
      geo: { type: 'BOX', params: { width: 0.8, height: 0.5, depth: 10 } },
      mat: stone,
      position: { x: -4.5, y: 3.45, z: 0 },
      castShadow: true,
      receiveShadow: true,
    },
    { appId: 'skyShowcaseLintel' }
  );

  updateLoaderFn({ loadedCount: 1, totalCount: 1 });
};
