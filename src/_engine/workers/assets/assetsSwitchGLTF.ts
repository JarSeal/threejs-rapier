/// <reference lib="webworker" />

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
// Static, unlike the main thread's on-demand import: the worker bundle can't be code-split
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type {
  AssetsDownProtocol,
  AssetsLoadGLTFRequest,
  DracoWorkerSettings,
  KTX2WorkerSettings,
} from '../../core/Assets/AssetsAPITypes';
import { disposeGLTFLeftovers, extractPrimitives } from '../../core/Import/GLTFExtract';
import {
  getGLTFDecoderNeeds,
  readGLTFExtensionsUsed,
  setGLTFDecoders,
} from '../../core/Import/GLTFExtensions';
import { collectGLTFTextures } from '../../core/Import/GLTFTextureCollect';
import type { TransferableGeometry } from '../../core/Import/GeometryTransfer';
import { serializeGeometry } from '../../core/Import/GeometryTransfer';
import {
  readGLTFLodChains,
  serializeLodChain,
  type TransferableLodChain,
} from '../../core/Lod/LodChainGLTF';
import type { TransferableImage } from '../../core/Import/TextureTransfer';
import { collectImageTransferables, serializeTexture } from '../../core/Import/TextureTransfer';
import { fetchAsset } from './assetsFetch';

let gltfLoader: GLTFLoader | null = null;
let dracoLoader: DRACOLoader | null = null;
let dracoKey = '';
let ktx2Loader: KTX2Loader | null = null;
let ktx2Key = '';

/** The worker's own KTX2Loader (it starts its own nested transcoder workers), set up with the
 * main thread's transcoder path and detected GPU formats (there's no renderer here). Changed
 * settings (a new renderer on the main thread) replace it. */
const getKTX2Loader = (settings: KTX2WorkerSettings) => {
  const key = JSON.stringify(settings);
  if (!ktx2Loader || key !== ktx2Key) {
    ktx2Loader?.dispose();
    ktx2Loader = new KTX2Loader().setTranscoderPath(settings.transcoderPath);
    ktx2Loader.workerConfig = { ...settings.workerConfig };
    ktx2Key = key;
  }
  return ktx2Loader;
};

/** The worker's own GLTFLoader + DRACOLoader (DRACOLoader starts its own nested decoder
 * workers). Like the main thread's shared loader, the decoder files are only fetched when the
 * first DRACO-compressed file is parsed. A changed decoder path/type (the main thread's changes
 * only apply after its disposeDracoLoader()) replaces the DRACO loader. */
const getGLTFLoader = (draco: DracoWorkerSettings) => {
  const key = `${draco.decoderPath}|${draco.decoderType}`;
  if (!dracoLoader || key !== dracoKey) {
    dracoLoader?.dispose();
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(draco.decoderPath);
    // WASM is the default and setDecoderConfig() is deprecated (warns since r186)
    if (draco.decoderType === 'js') dracoLoader.setDecoderConfig({ type: 'js' });
    dracoKey = key;
    gltfLoader = null;
  }
  if (draco.workerLimit !== undefined) dracoLoader.setWorkerLimit(draco.workerLimit);
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);
  }
  return gltfLoader;
};

export const assetsSwitchGLTF = async (
  data: AssetsLoadGLTFRequest,
  sendMessage: (message: AssetsDownProtocol, transfer?: Transferable[]) => void
) => {
  const { type, requestId, url, importId, meshIndex, importTextures, draco, ktx2 } = data;
  const buffer = await (await fetchAsset(url)).arrayBuffer();
  const needs = getGLTFDecoderNeeds(readGLTFExtensionsUsed(buffer));
  if (needs.ktx2 && !ktx2) {
    throw new Error(`"${url}" has KTX2 textures, but the main thread sent no KTX2 settings.`);
  }
  const loader = getGLTFLoader(draco);
  setGLTFDecoders(loader, {
    meshopt: needs.meshopt ? MeshoptDecoder : null,
    ktx2: needs.ktx2 && ktx2 ? getKTX2Loader(ktx2) : null,
  });
  const gltf = await loader.parseAsync(buffer, THREE.LoaderUtils.extractUrlBase(url));

  // The same extraction the main-thread import runs, so both produce the same manifest
  const extracted = extractPrimitives(gltf, {
    importId,
    meshIndex,
    lodChains: await readGLTFLodChains(gltf),
  });
  if (extracted.error !== undefined) {
    disposeGLTFLeftovers(gltf, {});
    return sendMessage({
      type,
      requestId,
      error: extracted.error,
      geometries: [],
      primitives: [],
      lodChains: [],
      images: [],
      textures: [],
      textureSlotsPerPrimitive: [],
    });
  }

  const transfer = new Set<ArrayBuffer>();
  const geometries: TransferableGeometry[] = [];
  const indexByGeometry = new Map<THREE.BufferGeometry, number>();
  const lodChains: { geometryIndex: number; chain: TransferableLodChain }[] = [];
  const keepGeometries = new Set<THREE.BufferGeometry>();
  const primitives = extracted.primitives.map(({ geometry, info, lodChain }) => {
    let geometryIndex = indexByGeometry.get(geometry);
    if (geometryIndex === undefined) {
      geometryIndex = geometries.push(serializeGeometry(geometry, transfer)) - 1;
      indexByGeometry.set(geometry, geometryIndex);
      keepGeometries.add(geometry);
      if (lodChain) {
        lodChains.push({ geometryIndex, chain: serializeLodChain(lodChain, geometry, transfer) });
        for (const level of lodChain.levels) keepGeometries.add(level.geometry);
      }
    }
    return { geometryIndex, info };
  });

  // The same texture collection the main-thread import runs; registering happens there
  const images: TransferableImage[] = [];
  const keepTextures = new Set<THREE.Texture>();
  const collected = importTextures ? collectGLTFTextures(gltf, extracted.primitives) : null;
  const imageIndexBySource = new Map<THREE.Source<unknown>, number>();
  const textures = (collected?.textures || []).map(({ texture, name, gltfTextureKey }) => {
    keepTextures.add(texture);
    return { texture: serializeTexture(texture, images, imageIndexBySource), name, gltfTextureKey };
  });

  // Free the rest of the parse (materials, unused images) before the buffers and images are
  // transferred: after postMessage, nothing here may touch the kept geometries/textures again
  disposeGLTFLeftovers(gltf, {
    geometries: keepGeometries,
    textures: keepTextures,
  });
  const imageTransfer = new Set<Transferable>();
  for (const image of images) collectImageTransferables(image, imageTransfer);
  sendMessage(
    {
      type,
      requestId,
      geometries,
      primitives,
      lodChains,
      images,
      textures,
      textureSlotsPerPrimitive: collected?.slotsPerPrimitive || [],
    },
    [...transfer, ...imageTransfer]
  );
};
