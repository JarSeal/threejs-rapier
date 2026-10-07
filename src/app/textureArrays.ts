import * as THREE from 'three/webgpu';
import { dFdx, dFdy, int, texture, uv, vec2 } from 'three/tsl';
// The real generic `Node<T>` typings (the `three/tsl` `Node` is a loose local shim)
import type { Node, TextureNode } from 'three/webgpu';
import { createCameraEntity, getActiveCamera } from '../_engine/core/CameraManager';
import { saveBufferGeometry } from '../_engine/core/Geometry';
import { createLightEntity } from '../_engine/core/LightManager';
import { saveMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { getRenderer } from '../_engine/core/Renderer';
import { getGeneratedAppData } from '../_engine/core/Scene';
import { loadScene, type ScenePrimitiveAssets } from '../_engine/core/SceneLoader';
import {
  getAllTextures,
  getTexture,
  loadTextureAsync,
  type TextureProps,
} from '../_engine/core/Texture';
import {
  buildTextureArray,
  getArrayLayerIndex,
  getTextureArrayInfo,
  sampleArrayLayer,
  setTextureArrayLayer,
  type TextureArray,
} from '../_engine/core/TextureArray';
import { lerror } from '../_engine/utils/Logger';

/**
 * The p299 verification scene: texture arrays next to the textures they were built from. Unlit
 * quads in a grid of 1 × 1 cells, 1.2 apart. Files from `devTools/assetPipeline/p299ArraySpike.ts`
 * (layer `i`: white, `i + 1` coloured stripes, a black bar at the top).
 * - row 0: `buildTextureArray` of four registered UASTC textures (s0-s3), drawn by ONE quad with
 *   one material (the cell picks the layer); right of it a one-member array of the `testTexture`
 *   asset (`*.texture.json`, loaded for the array alone).
 * - row 1: the four registered textures themselves, and `testTexture` (row 0 must match).
 * - row 2: the uncompressed path (`DataArrayTexture` from PNG members), one quad like row 0.
 * - row 3: swappable arrays, one layer swapped after the first upload: ETC1S [s0, s1] with
 *   layer 1 → s2 (red, blue), PNG [l0, l1] with layer 0 → l3 (yellow, green).
 * - row 4: `ktx create --layers` files loaded by loadTextureAsync (Phase 2's runtime side).
 * - column 4, rows 2-4: the layers of the `p299TestArray` asset (`*.textureArray.json`, loaded by
 *   the scene loader), picked by layer name, column 5 the files they were built from (resized to
 *   512² for the array).
 * - column 5, rows 0-1: the one-layer `p299TestArray1` asset, then its file.
 * - column 6, rows 2-4, lit spheres: the asset's `testTexture` layer (`sampleArrayLayer` as the
 *   material's `colorNode`), its source file as a plain `map`, and layer s2 of row 0's array.
 * Every array quad samples through `sampleArrayLayer` (Phase 4). `window.__textureArrays` holds the
 * checks' results and `project()` for the harness.
 */

const URL_BASE = '/debugger/assets/testOptimized/p299';
const CELL = 1.2;
const COLS = 4;
const ROW_WIDTH = CELL * (COLS - 1) + 1;
const X0 = -CELL * 1.5;
const Y0 = CELL * 2;
/** In front of the debug helpers at the world origin */
const Z = 2;

const sampleTexture = texture as unknown as (tex: THREE.Texture, uvNode: Node) => TextureNode;
const meshUv = uv as unknown as () => Node<'vec2'>;

const state: {
  results: Record<string, unknown>;
  arrays: Record<string, TextureArray>;
  project: (x: number, y: number) => { x: number; y: number };
  cellCenter: (row: number, col: number) => { x: number; y: number };
  /** The registered textures' ids (the harness checks what a scene exit released) */
  getTextureIds: () => string[];
  leaveTo: (sceneId: string) => Promise<unknown>;
} = {
  getTextureIds: () => Object.keys(getAllTextures()),
  leaveTo: (sceneId) => loadScene({ sceneId }),
  results: {},
  arrays: {},
  project: (x, y) => {
    const camera = getActiveCamera()!;
    const canvas = getRenderer()!.domElement;
    const v = new THREE.Vector3(x, y, Z).project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  },
  cellCenter: (row, col) => ({ x: X0 + col * CELL, y: Y0 - row * CELL }),
};

let quadGeo: THREE.BufferGeometry;
let rowGeo: THREE.BufferGeometry;
let sphereGeo: THREE.BufferGeometry;

const addQuad = (name: string, colorNode: Node<'vec4'>, row: number, col: number, wide = false) => {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = colorNode;
  saveMaterial(mat, `textureArrays/${name}`);
  const { x, y } = state.cellCenter(row, col);
  createMeshEntity(
    {
      geo: wide ? rowGeo : quadGeo,
      mat,
      position: { x: wide ? x + (ROW_WIDTH - 1) / 2 : x, y, z: Z },
    },
    { appId: `textureArrays_${name}` }
  );
  return mat;
};

/** One quad over a row of four cells, one material: the cell picks the layer, the gaps are cut. */
const addLayerRow = (name: string, array: TextureArray, row: number) => {
  const x = meshUv().x.mul(ROW_WIDTH);
  const cell = x.div(CELL).floor();
  const cellUv = vec2(x.sub(cell.mul(CELL)), meshUv().y);
  // The gradients of the continuous coordinate: cellUv jumps at each cell's edge
  const continuous = vec2(x, meshUv().y);
  const sampled = sampleArrayLayer(array, cellUv, int(cell) as unknown as Node).grad(
    dFdx(continuous) as unknown as Node,
    dFdy(continuous) as unknown as Node
  );
  const mat = addQuad(name, sampled as unknown as Node<'vec4'>, row, 0, true);
  mat.maskNode = cellUv.x.lessThanEqual(1) as unknown as Node;
};

const addLayerQuad = (
  name: string,
  tex: THREE.Texture,
  layer: number | string,
  row: number,
  col: number
) => addQuad(name, sampleArrayLayer(tex, meshUv(), layer) as unknown as Node<'vec4'>, row, col);

const addLitSphere = (
  name: string,
  row: number,
  color: { node?: Node<'vec4'>; map?: THREE.Texture }
) => {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  if (color.map) mat.map = color.map;
  if (color.node) mat.colorNode = color.node;
  saveMaterial(mat, `textureArrays/${name}`);
  const { x, y } = state.cellCenter(row, 6);
  createMeshEntity(
    { geo: sphereGeo, mat, position: { x, y, z: Z }, rotation: { x: 0.35, y: -0.6, z: 0 } },
    { appId: `textureArrays_${name}` }
  );
};

/** Phase 4's exit: lit meshes sampling an array layer, next to the layer's source file. */
const buildLitSpheres = (memberIds: string[]) => {
  const { arrays } = state;
  addLitSphere('lit_assetLayer', 2, {
    node: sampleArrayLayer(arrays.asset, meshUv(), 'testTexture') as unknown as Node<'vec4'>,
  });
  addLitSphere('lit_assetSource', 3, { map: getTexture('textureArrays/assetSource0')! });
  addLitSphere('lit_runtimeLayer', 4, {
    node: sampleArrayLayer(arrays.registered, meshUv(), memberIds[2]) as unknown as Node<'vec4'>,
  });
};

const nextFrames = (count: number) =>
  new Promise<void>((resolve) => {
    const step = () => (--count <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

/** Runs `fn`, expecting it to throw: the message, or a failure note when it didn't. */
const expectError = async (fn: () => unknown) => {
  try {
    await fn();
    return 'FAILED: did not throw';
  } catch (error) {
    return (error as Error).message;
  }
};

const describeArray = (array: TextureArray) => {
  const info = getTextureArrayInfo(array)!;
  return {
    id: array.userData.id,
    type: array.constructor.name,
    isArrayTexture: array.isArrayTexture,
    format: array.format,
    colorSpace: array.colorSpace,
    ...info,
    members: [...info.members],
    cpuBytesNow:
      info.kind === 'COMPRESSED'
        ? (array.mipmaps as unknown as { data: Uint8Array }[]).reduce(
            (sum, m) => sum + m.data.byteLength,
            0
          )
        : (array.image as { data: Uint8Array }).data.byteLength,
    gpuCountedBytes:
      (getRenderer()!.info as unknown as { memoryMap: WeakMap<object, number> }).memoryMap.get(
        array
      ) ?? null,
  };
};

const file = (name: string): TextureProps => ({ fileName: `${URL_BASE}/${name}` });

const loadSourceFile = (name: string, fileName: string) =>
  loadTextureAsync({
    id: `textureArrays/${name}`,
    fileName,
    texOpts: { colorSpace: THREE.SRGBColorSpace },
    throwOnError: true,
  });

/** The texture array assets the scene loader loaded, next to the files they were built from. */
const buildAssetColumns = async (assets: ScenePrimitiveAssets) => {
  const { results, arrays } = state;
  arrays.asset = assets.textures.p299TestArray as TextureArray;
  arrays.assetOneLayer = assets.textures.p299TestArray1 as TextureArray;
  const sources = [
    '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
    `${URL_BASE}/l1.png`,
    '/debugger/assets/testTextures/cubemap01_positive_y.png',
  ];
  const layerNames = getTextureArrayInfo(arrays.asset)!.members;
  for (const [layer, fileName] of sources.entries()) {
    addLayerQuad(`asset_L${layer}`, arrays.asset, layerNames[layer], 2 + layer, 4);
    const source = await loadSourceFile(`assetSource${layer}`, fileName);
    addQuad(`assetSource${layer}`, sampleTexture(source, meshUv()), 2 + layer, 5);
  }
  addLayerQuad('assetOneLayer', arrays.assetOneLayer, 0, 0, 5);
  const oneLayerSource = await loadSourceFile('assetOneLayerSource', `${URL_BASE}/l2.png`);
  addQuad('assetOneLayerSource', sampleTexture(oneLayerSource, meshUv()), 1, 5);

  // Without an output: an error, and (without throwOnError) an empty array of as many layers
  const fallback = await loadTextureAsync({
    id: 'textureArrays/noOutputFallback',
    __layers: ['a', 'b', 'c'],
  });
  results.noOutputFallback = {
    type: fallback.constructor.name,
    depth: (fallback.image as { depth?: number }).depth,
    isRegistered: getTexture('textureArrays/noOutputFallback') !== undefined,
  };
  const assetUrl = (getGeneratedAppData() as unknown as { textures: Record<string, TextureProps> })
    .textures.p299TestArray.__url;
  results.assetErrors = {
    noOutput: await expectError(() =>
      loadTextureAsync({ id: 'textureArrays/noOutput', __layers: ['a'], throwOnError: true })
    ),
    layerCountMismatch: await expectError(() =>
      loadTextureAsync({
        id: 'textureArrays/layerCountMismatch',
        __url: assetUrl,
        __layers: ['a', 'b'],
        throwOnError: true,
      })
    ),
    notSwappable: await expectError(() => setTextureArrayLayer('p299TestArray', 0, file('l0.png'))),
    asMember: await expectError(() => buildTextureArray({ members: ['p299TestArray'] })),
  };
};

/** Phase 4's lookups and sampleArrayLayer's errors. */
const checkHelpers = (memberIds: string[], plainTexture: THREE.Texture) => {
  const { results, arrays } = state;
  results.layerIndex = {
    assetByName: ['testTexture', 'l1', 'cubemap01_positive_y'].map((name) =>
      getArrayLayerIndex('p299TestArray', name)
    ),
    assetOneLayer: getArrayLayerIndex(arrays.assetOneLayer, 'l2'),
    runtimeById: memberIds.map((id) => getArrayLayerIndex(arrays.registered, id)),
    runtimeByFile: getArrayLayerIndex('textureArrays/swapPng', `${URL_BASE}/l1.png`),
    unknownMember: getArrayLayerIndex('p299TestArray', 'noSuchLayer') ?? null,
    unknownArray: getArrayLayerIndex('noSuchArray', 'l1') ?? null,
    notAnArray: getArrayLayerIndex(plainTexture, 'l1') ?? null,
  };
  const expectSampleError = (fn: () => unknown) => {
    try {
      fn();
      return 'FAILED: did not throw';
    } catch (error) {
      return (error as Error).message;
    }
  };
  results.sampleErrors = {
    unknownName: expectSampleError(() => sampleArrayLayer(arrays.asset, meshUv(), 'noSuchLayer')),
    outOfRange: expectSampleError(() => sampleArrayLayer(arrays.asset, meshUv(), 3)),
    notInteger: expectSampleError(() => sampleArrayLayer(arrays.asset, meshUv(), 1.5)),
    notAnArray: expectSampleError(() => sampleArrayLayer(plainTexture, meshUv(), 0)),
  };
};

const build = async (assets: ScenePrimitiveAssets) => {
  const { results, arrays } = state;

  // Row 1: the registered single textures (row 0's members, borrowed by the array)
  const singles = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      loadTextureAsync({
        id: `textureArrays/s${i}_uastc`,
        fileName: `${URL_BASE}/s${i}_uastc.ktx2`,
        throwOnError: true,
      })
    )
  );
  singles.forEach((tex, i) => addQuad(`single_s${i}`, sampleTexture(tex, meshUv()), 1, i));

  // Row 0: four registered members, one quad, one material, one binding
  const memberIds = singles.map((tex) => tex.userData.id as string);
  arrays.registered = await buildTextureArray({ members: memberIds });
  addLayerRow('registeredArray', arrays.registered, 0);
  // A build of the same members shares the array
  results.sharedById = (await buildTextureArray({ members: memberIds })) === arrays.registered;

  // Row 0, col 4: a one-member array of a texture asset, then the asset itself in row 1
  arrays.oneMember = await buildTextureArray({
    id: 'textureArrays/oneMember',
    members: ['testTexture'],
  });
  addLayerQuad('oneMember', arrays.oneMember, 0, 0, 4);
  const testTextureProps = (
    getGeneratedAppData() as unknown as { textures: Record<string, TextureProps> }
  ).textures.testTexture;
  const testTexture = await loadTextureAsync({ ...testTextureProps, throwOnError: true });
  addQuad('testTexture', sampleTexture(testTexture, meshUv()), 1, 4);

  // Row 2: the uncompressed path
  arrays.png = await buildTextureArray({
    members: [0, 1, 2, 3].map((i) => file(`l${i}.png`)),
    colorSpace: THREE.SRGBColorSpace,
  });
  addLayerRow('pngArray', arrays.png, 2);

  // Row 3: swaps after the first upload
  arrays.swapKtx = await buildTextureArray({
    id: 'textureArrays/swapKtx',
    members: [file('s0_etc1s.ktx2'), file('s1_etc1s.ktx2')],
    swappable: true,
  });
  arrays.swapPng = await buildTextureArray({
    id: 'textureArrays/swapPng',
    members: [file('l0.png'), file('l1.png')],
    colorSpace: THREE.SRGBColorSpace,
    swappable: true,
  });
  addLayerQuad('swapKtx0', arrays.swapKtx, 0, 3, 0);
  addLayerQuad('swapKtx1', arrays.swapKtx, 1, 3, 1);
  addLayerQuad('swapPng0', arrays.swapPng, 0, 3, 2);
  addLayerQuad('swapPng1', arrays.swapPng, 1, 3, 3);

  // Row 4: the `--layers` files
  for (const [c, codec] of ['etc1s', 'uastc'].entries()) {
    const built = await loadTextureAsync({
      id: `textureArrays/arr2_${codec}`,
      fileName: `${URL_BASE}/arr2_${codec}.ktx2`,
      throwOnError: true,
    });
    addLayerQuad(`built_${codec}_L0`, built, 0, 4, c * 2);
    addLayerQuad(`built_${codec}_L1`, built, 1, 4, c * 2 + 1);
  }

  await buildAssetColumns(assets);
  checkHelpers(memberIds, testTexture);
  buildLitSpheres(memberIds);

  // The errors a bad member list gets
  results.errors = {
    codecMismatch: await expectError(() =>
      buildTextureArray({ members: [file('s0_etc1s.ktx2'), file('s1_uastc.ktx2')] })
    ),
    sizeMismatch: await expectError(() =>
      buildTextureArray({ members: [memberIds[0], 'testTexture'] })
    ),
    kindMismatch: await expectError(() =>
      buildTextureArray({ members: [memberIds[0], file('l1.png')] })
    ),
    unknownMember: await expectError(() => buildTextureArray({ members: ['noSuchTexture'] })),
    notSwappable: await expectError(() =>
      setTextureArrayLayer(arrays.registered.userData.id, 0, memberIds[1])
    ),
    layerOutOfRange: await expectError(() =>
      setTextureArrayLayer('textureArrays/swapKtx', 2, file('s2_etc1s.ktx2'))
    ),
  };
};

type BackendData = { texture?: unknown; textureGPU?: unknown };
type Backend = { isWebGPUBackend?: boolean; get: (object: object) => BackendData };
const getBackend = () => (getRenderer() as unknown as { backend: Backend }).backend;
const isOnGPU = (tex: THREE.Texture) => {
  const data = getBackend().get(tex);
  return Boolean(data.texture ?? data.textureGPU);
};

/** After the scene has loaded (nothing is drawn while it loads): the layer swaps, then the
 * arrays' state. */
const runSwaps = async () => {
  const { results, arrays } = state;
  results.backend = getBackend().isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  // Swap once the arrays are on the GPU, so the swap goes through the layer update path
  await nextFrames(10);
  results.uploadedBeforeSwap = isOnGPU(arrays.swapKtx) && isOnGPU(arrays.swapPng);
  await Promise.all([
    setTextureArrayLayer('textureArrays/swapKtx', 1, file('s2_etc1s.ktx2')),
    setTextureArrayLayer('textureArrays/swapPng', 0, file('l3.png')),
  ]);
  // The upload consumes the layer updates (on the next frame that draws the array)
  let frames = 0;
  while (frames < 120 && (arrays.swapKtx.layerUpdates.size || arrays.swapPng.layerUpdates.size)) {
    await nextFrames(1);
    frames++;
  }
  results.framesUntilLayerUpload = frames;
  results.arrays = Object.fromEntries(
    Object.entries(arrays).map(([key, array]) => [key, describeArray(array)])
  );
  results.layerUpdatesLeft = {
    swapKtx: arrays.swapKtx.layerUpdates.size,
    swapPng: arrays.swapPng.layerUpdates.size,
  };
  results.done = true;
};

export const scene = async ({ assets }: { assets: ScenePrimitiveAssets }) => {
  (window as unknown as { __textureArrays: typeof state }).__textureArrays = state;
  state.results = {};
  state.arrays = {};

  createCameraEntity(
    {
      type: 'PERSPECTIVE',
      fov: 45,
      position: { x: 1.2, y: 0, z: Z + 9 },
      lookAtPoint: { x: 1.2, y: 0, z: Z },
      active: true,
    },
    { appId: 'textureArraysCam', debugData: { name: 'Texture arrays' } }
  );
  // For the lit spheres only: the quads are unlit
  createLightEntity(
    { type: 'AMBIENT', color: '#ffffff', intensity: 0.6 },
    { appId: 'textureArraysAmbient' }
  );
  createLightEntity(
    {
      type: 'DIRECTIONAL',
      color: '#ffffff',
      intensity: 2.5,
      position: { x: 4, y: 5, z: Z + 6 },
      targetPos: { x: 1.2, y: 0, z: Z },
    },
    { appId: 'textureArraysSun' }
  );

  const quad = new THREE.PlaneGeometry(1, 1);
  quadGeo = saveBufferGeometry(quad, { id: 'textureArraysQuad' });
  if (quadGeo !== quad) quad.dispose();
  const row = new THREE.PlaneGeometry(ROW_WIDTH, 1);
  rowGeo = saveBufferGeometry(row, { id: 'textureArraysRow' });
  if (rowGeo !== row) row.dispose();
  const sphere = new THREE.SphereGeometry(0.45, 48, 24);
  sphereGeo = saveBufferGeometry(sphere, { id: 'textureArraysSphere' });
  if (sphereGeo !== sphere) sphere.dispose();

  try {
    await build(assets);
    void runSwaps().catch((error) => {
      lerror('[textureArrays] Swaps failed', error);
      state.results.buildError = (error as Error).message;
    });
  } catch (error) {
    lerror('[textureArrays] Build failed', error);
    state.results.buildError = (error as Error).message;
  }
};
