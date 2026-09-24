/// <reference lib="webworker" />

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
  AssetsDownProtocol,
  AssetsLoadGLTFRequest,
  DracoWorkerSettings,
} from '../../core/Assets/AssetsAPITypes';
import { disposeGLTFLeftovers, extractPrimitives } from '../../core/Import/GLTFExtract';
import { serializeGeometry, TransferableGeometry } from '../../core/Import/GeometryTransfer';
import { fetchAsset } from './assetsFetch';

let gltfLoader: GLTFLoader | null = null;
let dracoLoader: DRACOLoader | null = null;
let dracoKey = '';

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
    dracoLoader.setDecoderConfig({ type: draco.decoderType });
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
  const { type, requestId, url, importId, meshIndex, draco } = data;
  const buffer = await (await fetchAsset(url)).arrayBuffer();
  const gltf = await getGLTFLoader(draco).parseAsync(buffer, THREE.LoaderUtils.extractUrlBase(url));

  // The same extraction the main-thread import runs, so both produce the same manifest
  const extracted = extractPrimitives(gltf, { importId, meshIndex });
  if (extracted.error !== undefined) {
    disposeGLTFLeftovers(gltf, {});
    return sendMessage({ type, requestId, error: extracted.error, geometries: [], primitives: [] });
  }

  const transfer = new Set<ArrayBuffer>();
  const geometries: TransferableGeometry[] = [];
  const indexByGeometry = new Map<THREE.BufferGeometry, number>();
  const primitives = extracted.primitives.map(({ geometry, info }) => {
    let geometryIndex = indexByGeometry.get(geometry);
    if (geometryIndex === undefined) {
      geometryIndex = geometries.push(serializeGeometry(geometry, transfer)) - 1;
      indexByGeometry.set(geometry, geometryIndex);
    }
    return { geometryIndex, info };
  });

  // Free the rest of the parse (materials, decoded images) before the buffers are transferred:
  // after postMessage, nothing here may touch the geometries again
  disposeGLTFLeftovers(gltf, { geometries: new Set(indexByGeometry.keys()) });
  sendMessage({ type, requestId, geometries, primitives }, [...transfer]);
};
