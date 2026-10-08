import * as THREE from 'three/webgpu';
import { ComponentType } from '../../../_engine/core/ECS/ECSCoreComponents';
import { createGeometry, incGeometryRef } from '../../../_engine/core/Geometry';
import type { LodDef } from '../../../_engine/core/Lod/LodTypes';
import { createMaterial, incMaterialRef } from '../../../_engine/core/Material';
import { setMeshLod } from '../../../_engine/core/MeshManager';
import { createSeededRandom } from '../../../toolkit/geometry/seededRandom';
import type { ShowcaseLaneContext, ShowcaseLane } from '../layout';

const GRID = 4;
const SPACING = 0.7;
const BOLLARD = { radius: 0.25, height: 0.6 };

/** Bollard levels by segment count: capsule caps and sides. */
const LEVEL_SEGMENTS = [
  { capSegments: 6, radialSegments: 16 },
  { capSegments: 2, radialSegments: 8 },
  { capSegments: 1, radialSegments: 4 },
];

const MAT_ID = 'lodShowcaseBollardMat';
const levelGeoId = (level: number) => `lodShowcaseBollardLod${level}`;

/** The cell's LOD: from the start camera (fov 50) a cell (LOD radius 2.04) crosses 0.08 at 55 m,
 * 0.035 at 125 m and hides below 0.022, from 199 m (221 m on the way out). */
const DEF: LodDef = {
  levels: [
    { screenSize: 0.08 },
    { screenSize: 0.035, geo: levelGeoId(1) },
    { screenSize: 0, geo: levelGeoId(2), castShadow: false },
  ],
  cullScreenSize: 0.022,
};

/** One cell: a 4 × 4 block of bollards drawn by one InstancedMesh entity, its instances around
 * the mesh's origin (the way p308 builds a static cell). It stands at the origin until placed. */
const createCell = (ctx: ShowcaseLaneContext, index: number) => {
  const geometry = createGeometry({
    id: levelGeoId(0),
    type: 'CAPSULE',
    params: { ...BOLLARD, ...LEVEL_SEGMENTS[0] },
  });
  const material = createMaterial({
    id: MAT_ID,
    type: 'STANDARD',
    params: { color: '#b8b2a7', roughness: 0.6, metalness: 0 },
  });
  const mesh = new THREE.InstancedMesh(geometry, material, GRID * GRID);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.id = `lodShowcaseCell_${index}`;
  const random = createSeededRandom(31);
  const matrix = new THREE.Matrix4();
  const half = ((GRID - 1) * SPACING) / 2;
  for (let i = 0; i < GRID * GRID; i++) {
    const x = (i % GRID) * SPACING - half + (random() - 0.5) * 0.15;
    const z = Math.floor(i / GRID) * SPACING - half + (random() - 0.5) * 0.15;
    // Standing on the ground: the capsule's centre is half its full height up
    mesh.setMatrixAt(i, matrix.makeTranslation(x, BOLLARD.height / 2 + BOLLARD.radius, z));
  }
  mesh.computeBoundingSphere();
  // The mesh holds level 0's refs, which the level swaps move
  incGeometryRef(levelGeoId(0));
  incMaterialRef(MAT_ID);

  const entityId = ctx.world.createEntity({ appId: `lodShowcaseCell_${index}` });
  mesh.userData.entityId = entityId;
  ctx.world.addComponent(entityId, ComponentType.OBJECT3D, { value: mesh, _lastVersion: -1 });
  ctx.world.addComponent(entityId, ComponentType.TAG_IS_MESH, true);
  ctx.rootScene.add(mesh);
  return { entityId };
};

/**
 * Lane 6: a static instance cell (docs/plans/_DONE_p348_ecs-lod-selection.md §4.3): an
 * `InstancedMesh` entity (no per-instance entities) whose whole cell swaps levels and cross-fades,
 * measured from its bounds over every instance. One cell per level band, hand-made levels by
 * segment count, hidden past the last band.
 */
export const instanceCellLane: ShowcaseLane = {
  id: 'instanceCell',
  title: 'Static instance cell',
  description:
    'A 4 × 4 block of bollards drawn by one InstancedMesh entity: the whole cell swaps level and fades.',
  create: async (ctx) => {
    for (let level = 1; level < LEVEL_SEGMENTS.length; level++) {
      createGeometry({
        id: levelGeoId(level),
        type: 'CAPSULE',
        params: { ...BOLLARD, ...LEVEL_SEGMENTS[level] },
      });
    }

    // The first cell measures the cell's LOD radius (its bounds over every instance), which the
    // slots need
    const first = createCell(ctx, 0);
    await setMeshLod(first.entityId, DEF, ctx.world);
    const radius = ctx.world.getComponent(first.entityId, ComponentType.LOD)?.radius ?? 0;

    const entityIds: number[] = [];
    const slots = ctx.getSlots(radius, DEF);
    for (let i = 0; i < slots.length; i++) {
      const cell = i === 0 ? first : createCell(ctx, i);
      // Through its Transform (the mesh entity gets one, synced onto the mesh every frame)
      const { x, z } = ctx.placeAt(slots[i].distance, 0);
      const transform = ctx.world.getComponent(cell.entityId, ComponentType.TRANSFORM);
      if (transform) {
        transform.position.set(x, 0, z);
        transform.setDirty();
        ctx.world.commitTransform(cell.entityId, transform);
      }
      if (i > 0) await setMeshLod(cell.entityId, DEF, ctx.world);
      entityIds.push(cell.entityId);
    }

    return {
      getEntityIds: () => entityIds,
      radius,
      switchDistances: ctx.getSwitchDistances(radius, DEF),
    };
  },
};
