// Shared by the main thread (AssetsAPI.ts) and the assets worker: keep this file free of
// runtime imports, so the worker never pulls in main-thread-only modules (eg. Config.ts reads
// `window` at module load).

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

/** The worker's handshake message (read by initWorker, not part of the protocol unions). */
export type AssetsWorkerReadyMessage = {
  status: 'INIT_READY';
  capabilities: AssetsWorkerCapabilities;
};

export enum AssetsProtocolType {
  ERROR = 0,
  /** Round-trip check, eg. to confirm the worker is alive. */
  PING = 1,
}

// UP (main thread → worker). Every request has a requestId; the worker answers each one with
// a response of the same type, or with an ERROR carrying the same requestId.

export type AssetsPingRequest = { type: AssetsProtocolType.PING; requestId: number };

export type AssetsUpProtocol = AssetsPingRequest;

// DOWN (worker → main thread)

export type AssetsErrorResponse = {
  type: AssetsProtocolType.ERROR;
  /** Missing when the error isn't tied to a request. */
  requestId?: number;
  message: string;
};

export type AssetsPingResponse = {
  type: AssetsProtocolType.PING;
  requestId: number;
  /** The worker's performance.now() when it answered. */
  workerTime: number;
};

export type AssetsDownProtocol = AssetsErrorResponse | AssetsPingResponse;
