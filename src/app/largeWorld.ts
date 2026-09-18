import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { createMeshEntity, getMeshByAppId, type MeshProps } from '../_engine/core/MeshManager';
import { createMaterial } from '../_engine/core/Material';
import { createLightEntity } from '../_engine/core/LightManager';
import { createGeometry, deleteGeometry } from '../_engine/core/Geometry';
import {
  createCameraEntity,
  getActiveCameraId,
  setMainCamera,
} from '../_engine/core/CameraManager';
import { createKeyInputControl } from '../_engine/core/InputControls';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { getECSWorld, getEntityIdByAppId } from '../_engine/core/ECS';
import { getRootScene } from '../_engine/core/Scene';
import { existsOrThrow } from '../_engine/utils/assert';
import { generateTerrain } from '../toolkit/geometry/generateTerrain';
import { generateBushGeometry, generateTreeGeometry } from '../toolkit/geometry/generateFoliage';
import { scatterOnSurface } from '../toolkit/geometry/scatterOnSurface';
import { createInstancedMeshPool } from '../toolkit/ecs/InstancedMeshPool';

/**
 * Phase 4/5 (docs/plans/p090_large-ecs-test-world-scene.md §3): terrain + static overview
 * camera + sun (Phase 4), then foliage scatter + static props + point-light accents (Phase 5).
 * The camera/lights/skybox are declared in `largeWorld.scene.json` and created automatically by
 * the scene loader before this runs — terrain has no JSON authoring support (§1.1), so it's
 * built here imperatively instead. Render-only for now: real colliders (terrain heightfield,
 * static props) are deferred to whichever scene-code convention exists once `PhysicsAPI.ts`
 * lands (§1.3).
 */
export const scene = async () => {
  const updateLoaderFn = getLoaderStatusUpdater();
  updateLoaderFn({ loadedCount: 0, totalCount: 1 });

  const ecsWorld = getECSWorld();
  const rootScene = existsOrThrow(getRootScene(), 'Could not find root scene in largeWorld scene.');

  const terrain = generateTerrain({
    width: 200,
    depth: 200,
    widthSegments: 150,
    depthSegments: 150,
    maxHeight: 7,
    seed: 5,
  });

  const terrainMat = createMaterial({
    id: 'largeWorldTerrainMat',
    type: 'PHONG',
    params: { color: '#4a7c3f', flatShading: false },
  });

  createMeshEntity(
    { geo: terrain.geometry, mat: terrainMat, castShadow: true, receiveShadow: true },
    { appId: 'largeWorldTerrain', debugData: { name: 'Large world terrain' } }
  );
  const terrainMesh = existsOrThrow(
    getMeshByAppId('largeWorldTerrain'),
    'Could not find the just-created terrain mesh by appId in largeWorld scene.'
  );

  // --- Foliage (Phase 5) — scattered directly off the terrain mesh's surface, no
  // `getHeightAt` needed (§3 Phase 5), baked into two ECS-addressable instanced pools.

  const treePlacements = scatterOnSurface({
    surface: terrainMesh,
    count: 1500,
    seed: 2,
    minSpacing: 2,
    scaleRange: [0.7, 1.3],
  });
  const treeGeo = generateTreeGeometry();
  const treeTrunkMat = createMaterial({
    id: 'largeWorldTreeTrunkMat',
    type: 'PHONG',
    params: { color: '#5b3a29' },
  });
  const treeFoliageMat = createMaterial({
    id: 'largeWorldTreeFoliageMat',
    type: 'PHONG',
    params: { color: '#2f5d34', flatShading: true },
  });
  const treePool = createInstancedMeshPool({
    world: ecsWorld,
    geometry: treeGeo.geometry,
    material: [treeTrunkMat, treeFoliageMat],
    maxInstances: treePlacements.length,
    castShadow: true,
    receiveShadow: true,
  });
  rootScene.add(treePool.mesh);
  treePool.spawn(ecsWorld, treePlacements);

  const bushPlacements = scatterOnSurface({
    surface: terrainMesh,
    count: 2000,
    seed: 3,
    minSpacing: 1,
    scaleRange: [0.6, 1.2],
  });
  const bushGeo = generateBushGeometry();
  const bushMat = createMaterial({
    id: 'largeWorldBushMat',
    type: 'PHONG',
    params: { color: '#3c6e35', flatShading: true },
  });
  const bushPool = createInstancedMeshPool({
    world: ecsWorld,
    geometry: bushGeo,
    material: bushMat,
    maxInstances: bushPlacements.length,
    castShadow: true,
    receiveShadow: true,
  });
  rootScene.add(bushPool.mesh);
  bushPool.spawn(ecsWorld, bushPlacements);

  // --- Static props (Phase 5) — physics-less for now (§1.3). A few are placed behind the
  // static overview camera on purpose and opt into `ecsFrustumCullingEnabled`, exercising
  // docs/plans/_DONE_p080_object3d-frustum-culling.md's ECS-queryable culling for the first
  // time anywhere in the engine (§1.7/§2).

  const rockMat = createMaterial({
    id: 'largeWorldRockMat',
    type: 'PHONG',
    params: { color: '#8a8a86', flatShading: true },
  });
  const platformMat = createMaterial({
    id: 'largeWorldPlatformMat',
    type: 'PHONG',
    params: { color: '#a89f91' },
  });
  const wallMat = createMaterial({
    id: 'largeWorldWallMat',
    type: 'PHONG',
    params: { color: '#7d7364' },
  });

  const staticProps: {
    appId: string;
    geo: MeshProps['geo'];
    mat: MeshProps['mat'];
    x: number;
    z: number;
    y?: number;
    /** Placed behind the static overview camera (`largeWorldOverview`, at z=120 looking at the origin) so it's reliably off that camera's frustum. */
    offFrustum?: boolean;
  }[] = [
    {
      appId: 'largeWorldRock1',
      geo: { type: 'SPHERE', params: { radius: 1.6, widthSegments: 6, heightSegments: 5 } },
      mat: rockMat,
      x: -30,
      z: -20,
    },
    {
      appId: 'largeWorldRock2',
      geo: { type: 'SPHERE', params: { radius: 2.2, widthSegments: 6, heightSegments: 5 } },
      mat: rockMat,
      x: 25,
      z: 15,
    },
    {
      appId: 'largeWorldPlatform1',
      geo: { type: 'BOX', params: { width: 6, height: 0.6, depth: 6 } },
      mat: platformMat,
      x: 12,
      z: 30,
    },
    {
      appId: 'largeWorldPlatform2',
      geo: { type: 'BOX', params: { width: 5, height: 0.6, depth: 5 } },
      mat: platformMat,
      x: -40,
      z: 35,
    },
    {
      appId: 'largeWorldWall1',
      geo: { type: 'BOX', params: { width: 8, height: 3, depth: 0.6 } },
      mat: wallMat,
      x: 0,
      z: -55,
    },
    {
      appId: 'largeWorldRockOffFrustum1',
      geo: { type: 'SPHERE', params: { radius: 1.8, widthSegments: 6, heightSegments: 5 } },
      mat: rockMat,
      x: 0,
      z: 150,
      y: 1.8,
      offFrustum: true,
    },
    {
      appId: 'largeWorldPlatformOffFrustum1',
      geo: { type: 'BOX', params: { width: 5, height: 0.6, depth: 5 } },
      mat: platformMat,
      x: 20,
      z: 160,
      y: 0.3,
      offFrustum: true,
    },
    {
      appId: 'largeWorldWallOffFrustum1',
      geo: { type: 'BOX', params: { width: 8, height: 3, depth: 0.6 } },
      mat: wallMat,
      x: -20,
      z: 145,
      y: 1.5,
      offFrustum: true,
    },
  ];

  for (const prop of staticProps) {
    const y = prop.y ?? terrain.getHeightAt(prop.x, prop.z) + 0.3;
    createMeshEntity(
      {
        geo: prop.geo,
        mat: prop.mat,
        castShadow: true,
        receiveShadow: true,
        position: { x: prop.x, y, z: prop.z },
      },
      {
        appId: prop.appId,
        debugData: { name: prop.appId },
        ecsFrustumCullingEnabled: prop.offFrustum,
      },
      ecsWorld
    );
  }

  // --- Point lights (Phase 5) — a handful of lantern/firefly accents among the foliage,
  // exercising docs/plans/_DONE_p081_light-object-culling.md's per-light contribution culling
  // (`objectCullingEnabled`), which no other example scene in this repo uses yet (§1.5).

  const lanternPlacements = scatterOnSurface({
    surface: terrainMesh,
    count: 10,
    seed: 4,
    minSpacing: 12,
  });
  for (let i = 0; i < lanternPlacements.length; i++) {
    const placement = lanternPlacements[i];
    createLightEntity(
      {
        type: 'POINT',
        color: '#ffcc66',
        intensity: 4,
        distance: 8,
        objectCullingEnabled: true,
        position: {
          x: placement.position.x,
          y: placement.position.y + 1.2,
          z: placement.position.z,
        },
      },
      { appId: `largeWorldLantern${i}`, debugData: { name: `Large world lantern ${i}` } },
      ecsWorld
    );
  }

  // --- Dynamic objects (Phase 6) — physics-less for now (§1.3/§5): placed at rest on the
  // terrain, not simulated. Real rigid bodies/colliders are deferred to whichever scene-code
  // convention exists once `PhysicsAPI.ts` lands; this is the render-only fallback the plan
  // calls for if Phase 6 is reached before that API exists.

  const dynamicMat = createMaterial({
    id: 'largeWorldDynamicMat',
    type: 'PHONG',
    params: { color: '#c94f4f' },
  });

  const simpleDynamicObjects: { appId: string; geo: MeshProps['geo']; x: number; z: number }[] = [
    {
      appId: 'largeWorldDynamicBox1',
      geo: { type: 'BOX', params: { width: 1, height: 1, depth: 1 } },
      x: 8,
      z: -10,
    },
    {
      appId: 'largeWorldDynamicBox2',
      geo: { type: 'BOX', params: { width: 1.2, height: 1.2, depth: 1.2 } },
      x: -15,
      z: 5,
    },
    {
      appId: 'largeWorldDynamicSphere1',
      geo: { type: 'SPHERE', params: { radius: 0.6, widthSegments: 12, heightSegments: 10 } },
      x: 18,
      z: -30,
    },
    {
      appId: 'largeWorldDynamicSphere2',
      geo: { type: 'SPHERE', params: { radius: 0.8, widthSegments: 12, heightSegments: 10 } },
      x: -8,
      z: 20,
    },
    {
      appId: 'largeWorldDynamicBox3',
      geo: { type: 'BOX', params: { width: 1, height: 1, depth: 1 } },
      x: 30,
      z: -5,
    },
  ];
  for (const obj of simpleDynamicObjects) {
    createMeshEntity(
      {
        geo: obj.geo,
        mat: dynamicMat,
        castShadow: true,
        receiveShadow: true,
        position: { x: obj.x, y: terrain.getHeightAt(obj.x, obj.z) + 0.6, z: obj.z },
      },
      { appId: obj.appId, debugData: { name: obj.appId } },
      ecsWorld
    );
  }

  // Two compound-shape objects (multiple merged primitives, à la
  // `characterTestObjects.ts`'s stairs/wall use of `mergeGeometries`) — a body-shape variety
  // beyond single primitives, for whichever compound/convex-hull collider the eventual physics
  // wiring uses.

  const crateBaseGeo = createGeometry({
    type: 'BOX',
    params: { width: 1.4, height: 1.4, depth: 1.4 },
  });
  const crateTopGeo = crateBaseGeo.clone();
  crateTopGeo.translate(0.7, 1.4, 0);
  const crateStackGeo = mergeGeometries([crateBaseGeo, crateTopGeo], false)!;
  crateStackGeo.computeVertexNormals();
  crateStackGeo.computeBoundingSphere();
  crateStackGeo.computeBoundingBox();
  deleteGeometry(crateBaseGeo.userData.id);

  const crateX = 5;
  const crateZ = 8;
  const crateBaseY = terrain.getHeightAt(crateX, crateZ) + 0.7;
  const crateStackId = createMeshEntity(
    {
      geo: crateStackGeo,
      mat: dynamicMat,
      castShadow: true,
      receiveShadow: true,
      position: { x: crateX, y: crateBaseY, z: crateZ },
    },
    {
      appId: 'largeWorldDynamicCrateStack',
      debugData: { name: 'Large world dynamic crate stack' },
    },
    ecsWorld
  );
  // Temporary stand-in motion so the FollowTool/camera-toggle below is visibly demonstrable
  // before real physics exists (§1.3) — not a substitute for the eventual rigid body, just a
  // sine-wave bob via the existing HoverEffect toolkit component (already used elsewhere, e.g.
  // the bobbing ball in testECS.ts).
  ecsWorld.addComponent(crateStackId, ComponentType.HOVER, {
    speed: 1.2,
    amplitude: 0.4,
    baseY: crateBaseY,
    time: 0,
  });

  const barbellSphereGeo = createGeometry({
    type: 'SPHERE',
    params: { radius: 0.5, widthSegments: 10, heightSegments: 8 },
  });
  const barbellSphereGeoA = barbellSphereGeo.clone();
  barbellSphereGeoA.translate(-0.9, 0, 0);
  const barbellSphereGeoB = barbellSphereGeo.clone();
  barbellSphereGeoB.translate(0.9, 0, 0);
  const barbellHandleGeo = createGeometry({
    type: 'CYLINDER',
    params: { radiusTop: 0.15, radiusBottom: 0.15, height: 1.8, radialSegments: 8 },
  });
  barbellHandleGeo.rotateZ(Math.PI / 2);
  const barbellGeo = mergeGeometries(
    [barbellSphereGeoA, barbellSphereGeoB, barbellHandleGeo],
    false
  )!;
  barbellGeo.computeVertexNormals();
  barbellGeo.computeBoundingSphere();
  barbellGeo.computeBoundingBox();
  deleteGeometry([barbellSphereGeo.userData.id, barbellHandleGeo.userData.id]);

  const barbellX = -20;
  const barbellZ = -35;
  createMeshEntity(
    {
      geo: barbellGeo,
      mat: dynamicMat,
      castShadow: true,
      receiveShadow: true,
      position: { x: barbellX, y: terrain.getHeightAt(barbellX, barbellZ) + 0.5, z: barbellZ },
    },
    { appId: 'largeWorldDynamicBarbell', debugData: { name: 'Large world dynamic barbell' } },
    ecsWorld
  );

  // --- Dynamic camera (Phase 6) — follows the crate stack via `FollowTool.ts`'s existing
  // leader-relative lerped following (position-only; it isn't light-specific despite living
  // under "effects", and isn't extended here beyond what it already does, per §2/§3 Phase 6).
  // Static until PhysicsAPI.ts lands and the leader actually moves.

  const followOffset = new THREE.Vector3(4, 3, 6);
  const leaderTransform = ecsWorld.getComponent(crateStackId, ComponentType.TRANSFORM)!;
  const dynamicCamId = createCameraEntity(
    {
      type: 'PERSPECTIVE',
      fov: 60,
      near: 0.1,
      far: 500,
      active: false,
      position: {
        x: leaderTransform.position.x + followOffset.x,
        y: leaderTransform.position.y + followOffset.y,
        z: leaderTransform.position.z + followOffset.z,
      },
      lookAtPoint: { x: crateX, y: leaderTransform.position.y, z: crateZ },
    },
    {
      appId: 'largeWorldDynamicCamera',
      debugData: {
        name: 'Large world dynamic camera',
        description: 'Follows largeWorldDynamicCrateStack via FollowTool. Toggle with the C key.',
      },
    },
    ecsWorld
  );
  ecsWorld.addComponent(dynamicCamId, ComponentType.FOLLOW, {
    leaderId: crateStackId,
    offset: followOffset,
    targetOffset: new THREE.Vector3(0, 0, 0),
    speed: 3,
  });

  // --- Camera toggle key binding (Phase 6, §2) ---

  createKeyInputControl({
    id: 'largeWorldToggleCamera',
    key: ['c', 'C'],
    type: 'KEY_UP',
    sceneId: 'largeWorld',
    fn: () => {
      const overviewId = getEntityIdByAppId('largeWorldOverview', ecsWorld);
      const dynamicId = getEntityIdByAppId('largeWorldDynamicCamera', ecsWorld);
      if (overviewId === undefined || dynamicId === undefined) return;
      const world = getECSWorld();
      setMainCamera(world, getActiveCameraId() === overviewId ? dynamicId : overviewId);
    },
  });

  updateLoaderFn({ loadedCount: 1, totalCount: 1 });
};
