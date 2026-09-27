// Shared by the main thread (AssetsAPI.ts) and the assets worker: keep this file free of
// runtime imports, so the worker never pulls in main-thread-only modules (eg. Config.ts reads
// `window` at module load).

import type { TransferableGeometry } from '../Import/GeometryTransfer';
import type { ImportedGeometryInfo } from '../Import/ImportTypes';
import type { TransferableTexture } from '../Import/TextureTransfer';
import type { TextureMapKeys } from '../Material';

/** Where an asset kind is loaded. */
export type AssetsWorkerTarget = 'MAIN_THREAD' | 'WORKER_THREAD';

/** The asset kinds that can be loaded in the assets worker. Each has its own workerTarget. */
export type AssetKind = 'GLTF' | 'TEXTURE';

/** Resolved assets config (AppConfig.assets with the defaults filled in). */
export type AssetsState = {
  /** Shared default for all asset kinds. */
  workerTarget: AssetsWorkerTarget;
  /** Per-kind overrides; undefined falls back to workerTarget. */
  gltfWorkerTarget?: AssetsWorkerTarget;
  textureWorkerTarget?: AssetsWorkerTarget;
  /** Max number of requests in flight in the worker at once, the rest wait in a queue. */
  maxConcurrentLoads: number;
  /** A worker request (and the worker handshake) not answered in this time falls back (or fails). */
  requestTimeoutMs: number;
  /** Re-run a failed worker request on the main thread. When false, the failure is thrown. */
  fallbackToMainThread: boolean;
};

/** What the worker's runtime supports, reported in its INIT_READY handshake. */
export type AssetsWorkerCapabilities = {
  createImageBitmap: boolean;
  /** GLTFLoader decodes images with ImageBitmapLoader (no `document` needed). It falls back to
   * TextureLoader (needs `document`) without createImageBitmap, on Safari < 17 and Firefox < 98. */
  gltfImageBitmapPath: boolean;
  offscreenCanvas: boolean;
};

/** The main thread's DRACO settings (DracoDecoder.ts), for the worker's own DRACOLoader. */
export type DracoWorkerSettings = {
  /** Absolute URL of the decoder directory. */
  decoderPath: string;
  decoderType: 'wasm' | 'js';
  workerLimit?: number;
};

export type AssetsWorkerStatus = 'NOT_STARTED' | 'STARTING' | 'READY' | 'FAILED';

/** Why a worker-targeted request ran on the main thread instead. */
export type AssetsFallbackCause =
  /** The worker could not be started (or its handshake timed out). */
  | 'INIT_FAILED'
  /** The worker runtime lacks something this asset kind needs. */
  | 'CAPABILITY'
  /** The request was not answered within requestTimeoutMs. */
  | 'TIMEOUT'
  /** The worker answered the request with an ERROR. */
  | 'WORKER_ERROR'
  /** The worker crashed (uncaught error) while the request was in flight, or before it was sent. */
  | 'CRASHED';

/** Where one load ran, and how long it took (debug info, see recordAssetLoadReport()). */
export type AssetLoadReport = {
  /** Where the asset kind was targeted. */
  target: AssetsWorkerTarget;
  /** Where it was actually loaded. */
  loadedOn: AssetsWorkerTarget;
  /** Why a worker-targeted load ran on the main thread instead. */
  fallbackCause?: AssetsFallbackCause;
  fallbackDetail?: string;
  /** From the request to the result, incl. waiting for a worker slot or for the worker to start. */
  durationMs: number;
  /** The loaded file's absolute URL, added by the caller (debug tooling can't read it from an
   * ImageBitmap or a DataTexture). */
  sourceUrl?: string;
};

/** The worker's handshake message (read by initWorker, not part of the protocol unions). */
export type AssetsWorkerReadyMessage = {
  status: 'INIT_READY';
  capabilities: AssetsWorkerCapabilities;
};

export enum AssetsProtocolType {
  ERROR = 0,
  /** Round-trip check, eg. to confirm the worker is alive. */
  PING = 1,
  /** A standard (non-HDR) texture: fetched and decoded into an ImageBitmap. */
  LOAD_TEXTURE = 2,
  /** An .hdr texture: fetched and parsed by HDRLoader into half-float RGBA data. */
  LOAD_HDR_TEXTURE = 3,
  /** A .glb/.gltf file: fetched, parsed (DRACO decoded) and its mesh primitives extracted. */
  LOAD_GLTF = 4,
}

// UP (main thread → worker). Every request has a requestId; the worker answers each one with
// a response of the same type, or with an ERROR carrying the same requestId.

export type AssetsPingRequest = { type: AssetsProtocolType.PING; requestId: number };

/** `url` must be absolute: a relative one would resolve against the worker script's URL. */
export type AssetsLoadTextureRequest = {
  type: AssetsProtocolType.LOAD_TEXTURE;
  requestId: number;
  url: string;
};

/** `url` must be absolute: a relative one would resolve against the worker script's URL. */
export type AssetsLoadHDRTextureRequest = {
  type: AssetsProtocolType.LOAD_HDR_TEXTURE;
  requestId: number;
  url: string;
};

/** `url` must be absolute: a relative one would resolve against the worker script's URL (the
 * glTF's own relative .bin/image URIs resolve against `url`). */
export type AssetsLoadGLTFRequest = {
  type: AssetsProtocolType.LOAD_GLTF;
  requestId: number;
  url: string;
  /** The (main-thread-resolved) import id, the geometry id prefix. */
  importId: string;
  meshIndex?: number | number[];
  /** Also send the textures of the primitives' glTF material slots. */
  importTextures: boolean;
  draco: DracoWorkerSettings;
};

export type AssetsUpProtocol =
  | AssetsPingRequest
  | AssetsLoadTextureRequest
  | AssetsLoadHDRTextureRequest
  | AssetsLoadGLTFRequest;

// DOWN (worker → main thread)

export type AssetsErrorResponse = {
  type: AssetsProtocolType.ERROR;
  /** Missing when the error isn't tied to a request. */
  requestId?: number;
  message: string;
  /** The file itself failed (eg. an HTTP error or a missing file), so the main thread would
   * fail the same way: the request is not re-run there. */
  isSourceError?: boolean;
};

export type AssetsPingResponse = {
  type: AssetsProtocolType.PING;
  requestId: number;
  /** The worker's performance.now() when it answered. */
  workerTime: number;
};

/** The decoded image, already flipped vertically (the flip TextureLoader's default
 * `flipY = true` would do), not premultiplied. Transferred, not copied. */
export type AssetsLoadTextureResponse = {
  type: AssetsProtocolType.LOAD_TEXTURE;
  requestId: number;
  bitmap: ImageBitmap;
};

/** HDRLoader's parse result in its default HalfFloatType. `data` is transferred, not copied. */
export type AssetsLoadHDRTextureResponse = {
  type: AssetsProtocolType.LOAD_HDR_TEXTURE;
  requestId: number;
  width: number;
  height: number;
  data: Uint16Array;
};

/** GLTFExtract's extractPrimitives() result, run in the worker. Nodes sharing one glTF mesh share
 * one geometry (`geometryIndex`), as they share one BufferGeometry on the main thread. With
 * importTextures, also GLTFTextureCollect's collectGLTFTextures() result (textures sharing one
 * image share its `imageIndex`, as they share one THREE.Source). The geometries' arrays and the
 * images are transferred, not copied. */
export type AssetsLoadGLTFResponse = {
  type: AssetsProtocolType.LOAD_GLTF;
  requestId: number;
  /** extractPrimitives()'s error (eg. no node at meshIndex): the file loaded, the import fails. */
  error?: string;
  geometries: TransferableGeometry[];
  primitives: { geometryIndex: number; info: ImportedGeometryInfo }[];
  /** Empty without importTextures. */
  images: ImageBitmap[];
  /** Empty without importTextures. */
  textures: { texture: TransferableTexture; name: string; gltfTextureKey: string }[];
  /** Per primitive (same order): slot → index in `textures`. Empty without importTextures. */
  textureSlotsPerPrimitive: Partial<Record<TextureMapKeys, number>>[];
};

export type AssetsDownProtocol =
  | AssetsErrorResponse
  | AssetsPingResponse
  | AssetsLoadTextureResponse
  | AssetsLoadHDRTextureResponse
  | AssetsLoadGLTFResponse;
