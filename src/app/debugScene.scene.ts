import * as THREE from 'three/webgpu';
import { createCameraEntity } from '../_engine/core/CameraManager';
import { createGeometry } from '../_engine/core/Geometry';
import { createLightEntity } from '../_engine/core/LightManager';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
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
