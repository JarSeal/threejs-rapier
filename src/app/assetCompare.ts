import * as THREE from 'three/webgpu';
import { float, normalMap, texture, uv, vec2 } from 'three/tsl';
// The real generic `Node<T>` typings (the `three/tsl` `Node` is a loose local shim)
import type { Node } from 'three/webgpu';
import { createCameraEntity } from '../_engine/core/CameraManager';
import { IS_DEBUG_ENV } from '../_engine/core/Config';
import { getECSWorld } from '../_engine/core/ECS';
import { CoreComponentType } from '../_engine/core/ECS/ECSRegistry';
import { createGeometry, saveBufferGeometry } from '../_engine/core/Geometry';
import { importAssetAsync, releaseImportedAsset } from '../_engine/core/Import/ImportRegistry';
import type { ImportedAssetManifest } from '../_engine/core/Import/ImportTypes';
import { spawnImportedAsset } from '../_engine/core/Import/SpawnImported';
import { createKeyBinding } from '../_engine/core/Input/KeyboardInput';
import { createMaterial, deleteMaterial, saveMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { getRenderer } from '../_engine/core/Renderer';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { deleteTexture, getTexture, loadTextureAsync } from '../_engine/core/Texture';
import { lerror, lwarn } from '../_engine/utils/Logger';

/**
 * The p300 Phase 1d comparison scene: the codec variants that `phase1Variants.ts` built, side by
 * side with their uncompressed baselines. Two slots (A and B) each build the whole set at the same
 * spots, one variant per slot, and the V key (or the scene's debug tab) shows one or the other:
 * - a tiled ground (rocks01, p303's LITE packing: albedo × AO + roughness, normal XY + height) at
 *   grazing angles, REPEAT and the renderer's max anisotropy;
 * - a sphere with the MetalRust ORM and normal map (the problem case), on its committed base colour;
 * - the metal toolbox prop GLB (meshopt geometry, all three maps in the variant's codec).
 * The "png" variant is each one's uncompressed baseline (the toolbox's JPG source GLB).
 * Throwaway: it goes with `testOptimized/phase1/` once Phase 1f has picked the profiles.
 */

export const ASSET_COMPARE_SCENE_ID = 'assetCompare';

/** Where phase1Variants.ts writes its outputs (and report.json). */
export const PHASE1_URL = '/debugger/assets/testOptimized/phase1';
const BASE_COLOR_URL = '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg';

export const COMPARE_VARIANTS = [
  'png',
  'etc1s_q128',
  'etc1s_q255',
  'uastc',
  'uastc_rdo1',
  'uastc_rdo2',
  'uastc_rdo4',
] as const;
export type CompareVariant = (typeof COMPARE_VARIANTS)[number];
export type CompareSlotId = 'A' | 'B';
export type CompareSubject = 'ground' | 'sphere' | 'prop';

/** Both slots' settings and which one is shown. The debug tab binds to (and persists) this. */
export const compareConfig = {
  variantA: 'png' as CompareVariant,
  /** The MetalRust normal map's `--normal-mode` copy (KTX2 variants only). */
  normalModeA: false,
  variantB: 'uastc_rdo2' as CompareVariant,
  normalModeB: false,
  shown: 'A' as CompareSlotId,
};

/** A texture a slot shows: what it is, its file (relative to PHASE1_URL; `<glb>#<name>` for the
 * prop's embedded ones) and the loaded texture. */
export type CompareTexture = {
  subject: CompareSubject;
  name: string;
  file: string;
  texture: THREE.Texture;
  /** A prop texture's kind in report.json, which names it after its image, not its material. */
  reportKind?: 'color' | 'normal' | 'data';
};

export type CompareSlot = {
  id: CompareSlotId;
  /** What the slot holds now (null while it builds for the first time, or after an error). */
  built: { variant: CompareVariant; normalMode: boolean } | null;
  isBuilding: boolean;
  textures: CompareTexture[];
  /** The prop GLB's file and size, when it was loaded. */
  propFile: string | null;
  /** Problems to show in the debug tab (eg. a gitignored prop GLB that isn't built). */
  messages: string[];
  entityIds: number[];
  textureIds: string[];
  materialIds: string[];
  propImportId: string | null;
  queue: Promise<void>;
};

const GROUND_SIZE = 120;
/** rocks01 (ambientCG Ground079S) covers about 2 × 2 m. */
const GROUND_TILES = GROUND_SIZE / 2;
const SPHERE_RADIUS = 0.75;
const SPHERE_POS = { x: -1.1, y: SPHERE_RADIUS, z: 0 };
const PROP_POS = { x: 0.9, y: 0, z: 1.1 };

type TextureSpec = {
  subject: CompareSubject;
  group: 'rocks01' | 'metalRust';
  name: string;
  srgb?: boolean;
  hasNormalMode?: boolean;
};

const GROUND_ALBEDO_ROUGH: TextureSpec = {
  subject: 'ground',
  group: 'rocks01',
  name: 'albedoRough',
  srgb: true,
};
const GROUND_NORMAL_HEIGHT: TextureSpec = {
  subject: 'ground',
  group: 'rocks01',
  name: 'normalHeight',
};
const SPHERE_ORM: TextureSpec = { subject: 'sphere', group: 'metalRust', name: 'orm' };
const SPHERE_NORMAL: TextureSpec = {
  subject: 'sphere',
  group: 'metalRust',
  name: 'normal',
  hasNormalMode: true,
};

// The shim types `texture` and `uv` too: these take the real types
const sampleTexture = texture as unknown as (tex: THREE.Texture, uvNode: Node) => Node<'vec4'>;
const meshUv = uv as unknown as () => Node<'vec2'>;

const getTextureFile = (spec: TextureSpec, variant: CompareVariant, normalMode: boolean) =>
  variant === 'png'
    ? `${spec.group}/${spec.name}.png`
    : `${spec.group}/${spec.name}_${spec.hasNormalMode && normalMode ? 'nm_' : ''}${variant}.ktx2`;

const getPropFile = (variant: CompareVariant) =>
  `metalToolbox/${variant === 'png' ? 'source' : variant}.glb`;

const createSlot = (id: CompareSlotId): CompareSlot => ({
  id,
  built: null,
  isBuilding: false,
  textures: [],
  propFile: null,
  messages: [],
  entityIds: [],
  textureIds: [],
  materialIds: [],
  propImportId: null,
  queue: Promise.resolve(),
});

let slots: Record<CompareSlotId, CompareSlot> = { A: createSlot('A'), B: createSlot('B') };
let onChange: (() => void) | null = null;

export const getCompareSlots = () => slots;

/** Called after a slot was rebuilt or the shown slot changed (the debug tab's refresh). */
export const setCompareChangeListener = (fn: (() => void) | null) => {
  onChange = fn;
};

/** Whether the dev server serves the file: the gitignored prop GLBs may not be built, and a
 * missing file gets the SPA's index.html. */
const isServed = async (url: string) => {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok && !(res.headers.get('content-type') || '').includes('text/html');
  } catch {
    return false;
  }
};

const getMaxAnisotropy = () => getRenderer()?.getMaxAnisotropy() ?? 1;

const applyVisibility = () => {
  const world = getECSWorld();
  for (const slot of Object.values(slots)) {
    for (const entityId of slot.entityIds) {
      const obj = world.getComponent(entityId, CoreComponentType.OBJECT3D)?.value;
      if (obj) obj.visible = slot.id === compareConfig.shown;
    }
  }
};

/** Deletes what a slot built: its entities, materials, textures and prop import. */
const clearSlot = (slot: CompareSlot) => {
  const world = getECSWorld();
  for (const entityId of slot.entityIds) if (world.isAlive(entityId)) world.deleteEntity(entityId);
  // The meshes' refs are gone, so these only remain when a build failed half way
  deleteMaterial(slot.materialIds);
  // Standalone textures are sampled through TSL nodes, which a material's dispose doesn't track
  for (const id of slot.textureIds) if (getTexture(id)) deleteTexture(id);
  if (slot.propImportId) releaseImportedAsset(slot.propImportId);
  Object.assign(slot, {
    built: null,
    textures: [],
    propFile: null,
    messages: [],
    entityIds: [],
    textureIds: [],
    materialIds: [],
    propImportId: null,
  });
};

/** A STANDARD material with the maps the import's glTF material had (its first primitive's). */
const createPropMaterial = (manifest: ImportedAssetManifest, id: string) => {
  const slotTextures = manifest.geometries[0]?.textureSlots || {};
  const params: Record<string, THREE.Texture | undefined> = {};
  for (const [key, textureId] of Object.entries(slotTextures)) params[key] = getTexture(textureId);
  return createMaterial({ id, type: 'STANDARD', params });
};

const buildSlot = async (slot: CompareSlot) => {
  clearSlot(slot);
  const variant = compareConfig[`variant${slot.id}`];
  const normalMode = compareConfig[`normalMode${slot.id}`];
  const prefix = `assetCompare/${slot.id}`;
  const anisotropy = getMaxAnisotropy();

  const loadSlotTexture = async (spec: TextureSpec) => {
    const file = getTextureFile(spec, variant, normalMode);
    const id = `${prefix}/${file}`;
    slot.textureIds.push(id);
    const loaded = await loadTextureAsync({
      id,
      fileName: `${PHASE1_URL}/${file}`,
      // A KTX2 file carries its own colour space; the PNG baselines get theirs here
      texOpts: {
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        anisotropy,
        ...(variant === 'png' && spec.srgb ? { colorSpace: THREE.SRGBColorSpace } : {}),
      },
      throwOnError: true,
    });
    slot.textures.push({ subject: spec.subject, name: spec.name, file, texture: loaded });
    return loaded;
  };

  const [albedoRough, normalHeight, orm, normal, baseColor] = await Promise.all([
    loadSlotTexture(GROUND_ALBEDO_ROUGH),
    loadSlotTexture(GROUND_NORMAL_HEIGHT),
    loadSlotTexture(SPHERE_ORM),
    loadSlotTexture(SPHERE_NORMAL),
    // Shared by both slots (the same JPG in every variant), released with the scene
    loadTextureAsync({
      id: 'assetCompare/metalRustBaseColor',
      fileName: BASE_COLOR_URL,
      texOpts: {
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        anisotropy,
        colorSpace: THREE.SRGBColorSpace,
      },
      throwOnError: true,
    }),
  ]);

  // Ground: p303's LITE packing (albedo × AO in RGB, roughness in A; normal XY, height in B)
  const tiledUv = meshUv().mul(GROUND_TILES);
  const groundAr = sampleTexture(albedoRough, tiledUv);
  const groundNormal = normalMap(sampleTexture(normalHeight, tiledUv));
  groundNormal.unpackNormalMode = THREE.NormalRGPacking;
  const groundMat = new THREE.MeshStandardNodeMaterial();
  groundMat.colorNode = groundAr.rgb;
  groundMat.roughnessNode = groundAr.a;
  groundMat.metalnessNode = float(0);
  groundMat.normalNode = groundNormal;
  saveMaterial(groundMat, `${prefix}/groundMaterial`);
  slot.materialIds.push(`${prefix}/groundMaterial`);

  const planeGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2);
  const groundGeo = saveBufferGeometry(planeGeo, { id: 'assetCompareGround' });
  if (groundGeo !== planeGeo) planeGeo.dispose();
  slot.entityIds.push(
    createMeshEntity(
      { geo: groundGeo, mat: groundMat, receiveShadow: true },
      { appId: `assetCompare${slot.id}Ground` }
    )
  );

  // Sphere: MetalRust, its UVs wrap twice round the equator
  const sphereUv = meshUv().mul(vec2(2, 1));
  const sphereOrm = sampleTexture(orm, sphereUv);
  const sphereNormal = normalMap(sampleTexture(normal, sphereUv));
  // `--normal-mode` files have X in RGB and Y in A, and three only unpacks RG formats by itself
  if (normalMode && variant !== 'png') sphereNormal.unpackNormalMode = THREE.NormalGAPacking;
  const sphereMat = new THREE.MeshStandardNodeMaterial();
  sphereMat.colorNode = sampleTexture(baseColor, sphereUv).rgb;
  sphereMat.aoNode = sphereOrm.r;
  sphereMat.roughnessNode = sphereOrm.g;
  sphereMat.metalnessNode = sphereOrm.b;
  sphereMat.normalNode = sphereNormal;
  saveMaterial(sphereMat, `${prefix}/sphereMaterial`);
  slot.materialIds.push(`${prefix}/sphereMaterial`);
  slot.entityIds.push(
    createMeshEntity(
      {
        geo: createGeometry({
          id: 'assetCompareSphere',
          type: 'SPHERE',
          params: { radius: SPHERE_RADIUS, widthSegments: 128, heightSegments: 64 },
        }),
        mat: sphereMat,
        position: SPHERE_POS,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: `assetCompare${slot.id}Sphere` }
    )
  );

  // Prop: the gitignored GLBs are rebuilt by phase1Variants.ts, so one may be missing
  const propFile = getPropFile(variant);
  if (!(await isServed(`${PHASE1_URL}/${propFile}`))) {
    const message = `${propFile} is not built: run \`npx tsx devTools/assetPipeline/phase1Variants.ts --only metalToolbox\``;
    lwarn(`[assetCompare] ${message}`);
    slot.messages.push(message);
  } else {
    const importId = `${prefix}/prop/${variant}`;
    slot.propImportId = importId;
    const manifest = await importAssetAsync({
      id: importId,
      fileName: `${PHASE1_URL}/${propFile}`,
      importTextures: { texOpts: { anisotropy } },
      throwOnError: true,
    });
    const material = createPropMaterial(manifest!, `${prefix}/propMaterial`);
    slot.materialIds.push(`${prefix}/propMaterial`);
    const { meshEntityIds } = await spawnImportedAsset(manifest!, {
      transform: { position: PROP_POS, rotation: { x: 0, y: -0.5, z: 0 } },
      material,
      castShadow: true,
      receiveShadow: true,
      entityOpts: { appId: `assetCompare${slot.id}Prop` },
    });
    slot.entityIds.push(...meshEntityIds);
    slot.propFile = propFile;
    // One row per texture (the ARM map fills more than one slot)
    const slotsByTexture = new Map<string, string[]>();
    for (const [key, textureId] of Object.entries(manifest!.geometries[0]?.textureSlots || {})) {
      slotsByTexture.set(textureId, [...(slotsByTexture.get(textureId) || []), key]);
    }
    for (const [textureId, keys] of slotsByTexture) {
      const loaded = getTexture(textureId);
      if (!loaded) continue;
      slot.textures.push({
        subject: 'prop',
        name: keys.join(' + '),
        file: `${propFile}#${textureId.slice(importId.length + 1)}`,
        texture: loaded,
        reportKind: keys.includes('normalMap') ? 'normal' : keys.includes('map') ? 'color' : 'data',
      });
    }
  }

  slot.built = { variant, normalMode };
};

/** Rebuilds a slot from compareConfig (queued after a build that is still running). */
export const rebuildCompareSlot = (slotId: CompareSlotId) => {
  const slot = slots[slotId];
  slot.queue = slot.queue.then(async () => {
    slot.isBuilding = true;
    onChange?.();
    try {
      await buildSlot(slot);
    } catch (error) {
      lerror(`[assetCompare] Slot ${slot.id} failed to build`, error);
      slot.messages.push(`Build failed: ${(error as Error).message}`);
    }
    slot.isBuilding = false;
    applyVisibility();
    onChange?.();
  });
  return slot.queue;
};

export const showCompareSlot = (slotId: CompareSlotId) => {
  compareConfig.shown = slotId;
  applyVisibility();
  onChange?.();
};

export const toggleCompareSlot = () => showCompareSlot(compareConfig.shown === 'A' ? 'B' : 'A');

export const scene = async () => {
  const updateLoaderFn = getLoaderStatusUpdater();
  updateLoaderFn({ loadedCount: 0, totalCount: 2 });
  slots = { A: createSlot('A'), B: createSlot('B') };

  // Low over the ground, looking along it (grazing angles), the sphere and the prop in front.
  // One camera only: another camera's debug symbol would stand in this view (close-ups: F1)
  createCameraEntity(
    {
      type: 'PERSPECTIVE',
      fov: 50,
      far: 300,
      position: { x: 0, y: 1.1, z: 3.6 },
      lookAtPoint: { x: 0, y: 0.35, z: -6 },
      active: true,
    },
    { appId: 'assetCompareGrazing', debugData: { name: 'Asset compare: grazing' } }
  );
  // The debug tab first: it restores the saved slot settings the builds read
  if (IS_DEBUG_ENV) {
    const { createAssetCompareTab } = await import('./_dbg__assetCompare');
    createAssetCompareTab();
  }

  createKeyBinding({
    id: 'assetCompareToggleSlot',
    name: 'Show slot A / B',
    description: 'Switches between the two codec variants (the Asset compare tab picks them).',
    chord: { key: 'v' },
    type: 'KEY_UP',
    sceneId: ASSET_COMPARE_SCENE_ID,
    fn: toggleCompareSlot,
  });

  await rebuildCompareSlot('A');
  updateLoaderFn({ loadedCount: 1, totalCount: 2 });
  await rebuildCompareSlot('B');
  updateLoaderFn({ loadedCount: 2, totalCount: 2 });
};
