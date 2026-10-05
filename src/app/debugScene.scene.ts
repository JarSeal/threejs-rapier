import * as THREE from 'three/webgpu';
import { createCameraEntity } from '../_engine/core/CameraManager';
import { getECSWorld } from '../_engine/core/ECS';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { createGeometry, getGeometry, incGeometryRef } from '../_engine/core/Geometry';
import { createLightEntity } from '../_engine/core/LightManager';
import { createMaterial, getMaterial, incMaterialRef } from '../_engine/core/Material';
import { createMeshEntity, setMeshLod } from '../_engine/core/MeshManager';
import { getRootScene } from '../_engine/core/Scene';
import { getTexture, loadTextureAsync, type TexOpts } from '../_engine/core/Texture';
import { importAssetAsync } from '../_engine/core/Import/ImportRegistry';
import { spawnImportedAsset } from '../_engine/core/Import/SpawnImported';
import type { ImportedAssetManifest } from '../_engine/core/Import/ImportTypes';

// p300 Phase 0 check: hand-optimized assets (KTX2 textures, meshopt GLBs, made with gltfpack)
// next to their sources. Top row: each PNG texture, then its KTX2 copy; they must look the same
// (the KTX2 files are encoded flipped, so this is the orientation check). Bottom row, left to
// right: box01Textured.glb, its meshopt + KTX2 copy and its quantized meshopt + KTX2 copy (all
// three must look the same), then box01.glb (no textures, a plain material) and its meshopt copy.
// Switch the GLTF worker target in the Assets tab (and reload) to check the assets worker path.
const TEX = '/debugger/assets/testTextures';
const OPT = '/debugger/assets/testOptimized';
const MODELS = '/debugger/assets/testModels';

// The PNG gets the sRGB colour space its KTX2 copy carries in its own header
const TEXTURES: { id: string; fileName: string; texOpts?: TexOpts }[] = [
  {
    id: 'p300_uvChecker_png',
    fileName: `${TEX}/UVMaps/UVCheckerMap-orange-white-1024.png`,
    texOpts: { colorSpace: THREE.SRGBColorSpace },
  },
  { id: 'p300_uvChecker_ktx2', fileName: `${OPT}/uvChecker_etc1s.ktx2` },
  { id: 'p300_normal_png', fileName: `${TEX}/Poliigon_MetalRust_7642_Normal.png` },
  { id: 'p300_normal_ktx2', fileName: `${OPT}/metalRust_normal_uastc.ktx2` },
];

const MODELS_TO_IMPORT = [
  { id: 'p300_source', fileName: `${MODELS}/box01Textured.glb` },
  { id: 'p300_meshoptKtx2', fileName: `${OPT}/box01Textured_meshopt_ktx2.glb` },
  { id: 'p300_meshoptKtx2Quantized', fileName: `${OPT}/box01Textured_meshopt_ktx2_quantized.glb` },
  { id: 'p300_untexturedSource', fileName: `${MODELS}/box01.glb`, noTextures: true },
  { id: 'p300_meshoptOnly', fileName: `${OPT}/box01_meshopt.glb`, noTextures: true },
];

/** A STANDARD material with the maps the import's glTF material had (its first primitive's). */
const createSlotMaterial = (manifest: ImportedAssetManifest) => {
  const slots = manifest.geometries[0]?.textureSlots || {};
  const params: Record<string, THREE.Texture | undefined> = {};
  for (const [slot, textureId] of Object.entries(slots)) params[slot] = getTexture(textureId);
  return createMaterial({ id: `${manifest.id}_material`, type: 'STANDARD', params });
};

// p348 Phase 1 check: a sphere with three hand-made levels, by segment count, each in its own
// colour (level 0 green, 1 yellow, 2 red), so a swap shows. Level 2 casts no shadow, and below
// cullScreenSize the sphere hides. With the radius 0.5 and the camera's fov 50, level 0 holds to
// ~3.6 m, level 1 to ~10.7 m, level 2 to ~107 m.
const createLodTestMesh = () => {
  const levelGeo = (id: string, widthSegments: number, heightSegments: number) =>
    createGeometry({ id, type: 'SPHERE', params: { radius: 0.5, widthSegments, heightSegments } });
  const levelMat = (id: string, color: number) =>
    createMaterial({ id, type: 'STANDARD', params: { color } });

  const lod1Geo = levelGeo('p348_sphere_lod1', 16, 8);
  const lod2Geo = levelGeo('p348_sphere_lod2', 6, 4);
  const lod1Mat = levelMat('p348_sphere_lod1_material', 0xe0c020);
  const lod2Mat = levelMat('p348_sphere_lod2_material', 0xd03020);
  createMeshEntity(
    {
      geo: levelGeo('p348_sphere_lod0', 64, 32),
      mat: levelMat('p348_sphere_lod0_material', 0x30c040),
      position: { x: 3.6, y: 0.5, z: 1.5 },
      castShadow: true,
      preWarm: true,
      lod: {
        levels: [
          { screenSize: 0.3 },
          {
            screenSize: 0.1,
            geo: lod1Geo.userData.id,
            mat: lod1Mat.userData.id,
          },
          {
            screenSize: 0.03,
            geo: lod2Geo.userData.id,
            mat: lod2Mat.userData.id,
            castShadow: false,
          },
        ],
        cullScreenSize: 0.01,
      },
    },
    { appId: 'p348LodSphere' }
  );
};

// p348 Phase 4 check: a static instance cell (§4.3) the way p308 builds one, an InstancedMesh entity
// with OBJECT3D + TAG_IS_MESH and no per-instance entities, on the sphere's levels. Its 5×5 small
// spheres (scale 0.3, 0.4 m apart) sit left of the origin, away from the mesh's own origin, so the
// selection has to measure from the cell's bounds (radius ~1.28 m), not from one sphere at (0, 0, 0).
// Level 0 holds to ~9.2 m, level 1 to ~27 m, level 2 to ~275 m; the whole cell switches at once.
const createLodTestCell = () => {
  const geometry = getGeometry('p348_sphere_lod0') as THREE.BufferGeometry;
  const material = getMaterial('p348_sphere_lod0_material') as THREE.Material;
  const mesh = new THREE.InstancedMesh(geometry, material, 25);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.id = 'p348LodCell';
  mesh.userData.preWarm = true;
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < 25; i++) {
    const x = -4.6 + (i % 5) * 0.4;
    const z = 0.6 + Math.floor(i / 5) * 0.4;
    mesh.setMatrixAt(i, matrix.makeScale(0.3, 0.3, 0.3).setPosition(x, 0.15, z));
  }
  incGeometryRef('p348_sphere_lod0');
  incMaterialRef('p348_sphere_lod0_material');

  const world = getECSWorld();
  const entityId = world.createEntity({ appId: 'p348LodCell' });
  // Marks the mesh as holding refs: the level swaps move them (setMeshGeometry / setMeshMaterial)
  mesh.userData.entityId = entityId;
  world.addComponent(entityId, ComponentType.OBJECT3D, { value: mesh, _lastVersion: -1 });
  world.addComponent(entityId, ComponentType.TAG_IS_MESH, true);
  getRootScene()?.add(mesh);

  setMeshLod(
    entityId,
    {
      levels: [
        { screenSize: 0.3 },
        { screenSize: 0.1, geo: 'p348_sphere_lod1', mat: 'p348_sphere_lod1_material' },
        {
          screenSize: 0.03,
          geo: 'p348_sphere_lod2',
          mat: 'p348_sphere_lod2_material',
          castShadow: false,
        },
      ],
      cullScreenSize: 0.01,
    },
    world
  );
};

export const scene = async () => {
  createCameraEntity(
    {
      type: 'PERSPECTIVE',
      fov: 50,
      position: { x: 0, y: 1, z: 7 },
      lookAtPoint: { x: 0, y: 0.7, z: 0 },
      active: true,
    },
    { appId: 'p300Camera' }
  );
  createLightEntity(
    { type: 'AMBIENT', color: '#ffffff', intensity: 0.6 },
    { appId: 'p300Ambient' }
  );
  createLightEntity(
    {
      type: 'DIRECTIONAL',
      color: '#ffffff',
      intensity: 2.5,
      position: { x: 3, y: 5, z: 6 },
      targetPos: { x: 0, y: 0, z: 0 },
    },
    { appId: 'p300Sun' }
  );

  createLodTestMesh();
  createLodTestCell();

  const textures = await Promise.all(
    TEXTURES.map(({ id, fileName, texOpts }) => loadTextureAsync({ id, fileName, texOpts }))
  );
  const planeGeo = createGeometry({
    id: 'p300_plane',
    type: 'BOX',
    params: { width: 1.4, height: 1.4, depth: 0.02 },
  });
  textures.forEach((texture, i) => {
    createMeshEntity(
      {
        geo: planeGeo,
        mat: createMaterial({
          id: `${TEXTURES[i].id}_material`,
          type: 'BASIC',
          params: { map: texture },
        }),
        position: { x: -2.4 + i * 1.6, y: 1.9, z: 0 },
      },
      { appId: `${TEXTURES[i].id}_plane` }
    );
  });

  for (let i = 0; i < MODELS_TO_IMPORT.length; i++) {
    const { id, fileName, noTextures } = MODELS_TO_IMPORT[i];
    const manifest = await importAssetAsync({
      id,
      fileName,
      importTextures: !noTextures,
      throwOnError: true,
    });
    await spawnImportedAsset(manifest!, {
      transform: { position: { x: -3.2 + i * 1.6, y: 0, z: 0 } },
      material: noTextures
        ? createMaterial({ id: `${id}_material`, type: 'STANDARD', params: { color: 0x8899aa } })
        : createSlotMaterial(manifest!),
    });
  }
};
