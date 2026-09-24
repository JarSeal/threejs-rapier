// The assets API decides where asset files are loaded and decoded: on the main thread or in
// the assets worker (AppConfig.assets). Callers never see the thread: a worker-targeted load
// that can't run in the worker (start-up failure, missing capability, timeout, error reply or
// crash) transparently re-runs on the main thread. The worker holds no cache: the main-thread
// registries stay the single source of truth.

import AssetsWorker from '../../workers/assetsWorker?worker';
import { getConfig, isDebugEnvironment } from '../Config';
import { initWorker } from '../../utils/helpers';
import { lerror, llog, lwarn } from '../../utils/Logger';
import {
  createNewResolver,
  isRequestPending,
  rejectRequest,
  RequestTimeoutError,
  resolveRequest,
} from '../../utils/PromiseResolver';
import {
  AssetKind,
  AssetsDownProtocol,
  AssetsFallbackCause,
  AssetsLoadGLTFResponse,
  AssetsLoadHDRTextureResponse,
  AssetsLoadTextureResponse,
  AssetsPingResponse,
  AssetsProtocolType,
  AssetsState,
  AssetsUpProtocol,
  AssetsWorkerCapabilities,
  AssetsWorkerReadyMessage,
  AssetsWorkerStatus,
  AssetsWorkerTarget,
  DracoWorkerSettings,
} from './AssetsAPITypes';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A failed worker request, with the fallback cause it maps to. */
class AssetsWorkerRequestError extends Error {
  reason: AssetsFallbackCause;
  constructor(reason: AssetsFallbackCause, message: string) {
    super(message);
    this.name = 'AssetsWorkerRequestError';
    this.reason = reason;
  }
}

/** The file itself failed in the worker (eg. an HTTP error): the main thread would fail the same
 * way, so it is passed on to the caller instead of re-running the load there. */
class AssetsSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetsSourceError';
  }
}

const DEFAULT_ASSETS_STATE: AssetsState = {
  workerTarget: 'MAIN_THREAD',
  maxConcurrentLoads: 8,
  requestTimeoutMs: 30_000,
  fallbackToMainThread: true,
};

/** The worker capability each asset kind needs. */
const REQUIRED_CAPABILITY: Record<AssetKind, keyof AssetsWorkerCapabilities> = {
  GLTF: 'gltfImageBitmapPath',
  TEXTURE: 'createImageBitmap',
};

let assetsState: AssetsState = { ...DEFAULT_ASSETS_STATE };

let worker: Worker | null = null;
/** Settles once: with the worker, or with null when it could not be started (never retried). */
let workerStartPromise: Promise<Worker | null> | null = null;
let workerStatus: AssetsWorkerStatus = 'NOT_STARTED';
let workerFailReason: string | undefined;
let workerCapabilities: AssetsWorkerCapabilities | undefined;

/** Requests sent to the worker and not yet settled, rejected at once if the worker crashes. */
const inFlightRequestIds = new Set<number>();
/** Requests waiting for a free slot (maxConcurrentLoads), first in first out. */
const slotQueue: (() => void)[] = [];
let usedSlots = 0;

const fallbackCounts: Record<AssetsFallbackCause, number> = {
  INIT_FAILED: 0,
  CAPABILITY: 0,
  TIMEOUT: 0,
  WORKER_ERROR: 0,
  CRASHED: 0,
};
let lastFallback: { kind: AssetKind; cause: AssetsFallbackCause; detail: string } | undefined;
const warnedCauses = new Set<AssetsFallbackCause>();

/**
 * Resolves the assets config (AppConfig.assets) with its defaults. Called once from
 * InitEngine, after loadConfig(). Doesn't start the worker: the first worker-targeted request
 * does.
 */
export const initAssets = () => {
  const assetsConfig = getConfig().assets || {};
  assetsState = {
    workerTarget: assetsConfig.workerTarget ?? DEFAULT_ASSETS_STATE.workerTarget,
    gltfWorkerTarget: assetsConfig.gltfWorkerTarget,
    textureWorkerTarget: assetsConfig.textureWorkerTarget,
    maxConcurrentLoads: Math.max(
      1,
      Math.floor(assetsConfig.maxConcurrentLoads ?? DEFAULT_ASSETS_STATE.maxConcurrentLoads)
    ),
    requestTimeoutMs: Math.max(
      0,
      assetsConfig.requestTimeoutMs ?? DEFAULT_ASSETS_STATE.requestTimeoutMs
    ),
    fallbackToMainThread:
      assetsConfig.fallbackToMainThread ?? DEFAULT_ASSETS_STATE.fallbackToMainThread,
  };
};

/** Returns the resolved assets config (read-only). */
export const getAssetsState = (): Readonly<AssetsState> => assetsState;

/**
 * Returns where an asset kind is loaded: its per-kind override, else the shared workerTarget.
 * @param kind {@link AssetKind}
 */
export const getAssetsWorkerTarget = (kind: AssetKind): AssetsWorkerTarget =>
  (kind === 'GLTF' ? assetsState.gltfWorkerTarget : assetsState.textureWorkerTarget) ??
  assetsState.workerTarget;

/** Returns the assets worker's state, and the fallbacks so far, for debug purposes. */
export const getAssetsWorkerInfo = () => ({
  status: workerStatus,
  failReason: workerFailReason,
  capabilities: workerCapabilities ? { ...workerCapabilities } : undefined,
  inFlight: inFlightRequestIds.size,
  queued: slotQueue.length,
  fallbackCounts: { ...fallbackCounts },
  lastFallback: lastFallback ? { ...lastFallback } : undefined,
});

const onWorkerError = (err: ErrorEvent) => {
  lerror(`Assets worker error: ${err.message}`);
  setWorkerFailed(`the worker crashed (${err.message})`);
};

const onWorkerMessage = (event: MessageEvent<AssetsDownProtocol>) => {
  const data = event.data;
  const requestId = data.requestId;

  if (requestId === undefined || !isRequestPending(requestId)) {
    // Not tied to a request, or a late reply to a request that already timed out (and fell
    // back): nothing uses its result, so free what the result holds
    if (data.type === AssetsProtocolType.ERROR && requestId === undefined) {
      lerror(`Error in assets worker, message: ${data.message}`);
    } else if (data.type === AssetsProtocolType.LOAD_TEXTURE) {
      data.bitmap.close();
    }
    return;
  }

  if (data.type === AssetsProtocolType.ERROR) {
    rejectRequest(
      requestId,
      data.isSourceError
        ? new AssetsSourceError(data.message)
        : new AssetsWorkerRequestError('WORKER_ERROR', data.message)
    );
    return;
  }
  resolveRequest(data, requestId);
};

/** Stops the worker for good: in-flight requests fail with CRASHED (and so fall back), queued
 * ones do so once they get a slot, and later requests fall back without trying. */
const setWorkerFailed = (reason: string) => {
  workerStatus = 'FAILED';
  workerFailReason = reason;
  worker?.terminate();
  worker = null;
  workerStartPromise = Promise.resolve(null);
  for (const requestId of [...inFlightRequestIds]) {
    rejectRequest(requestId, new AssetsWorkerRequestError('CRASHED', reason));
  }
};

/** Starts the worker on the first call; every call returns the same outcome. */
const startWorker = () => {
  if (workerStartPromise) return workerStartPromise;
  workerStatus = 'STARTING';
  workerStartPromise = initWorker<AssetsDownProtocol>(
    AssetsWorker,
    'Assets Worker',
    onWorkerMessage,
    onWorkerError,
    {
      onReady: (data) => {
        workerCapabilities = (data as AssetsWorkerReadyMessage).capabilities;
      },
      timeoutMs: assetsState.requestTimeoutMs,
    }
  )
    .then((startedWorker) => {
      worker = startedWorker;
      workerStatus = 'READY';
      if (isDebugEnvironment()) llog('Assets worker ready, capabilities:', workerCapabilities);
      return startedWorker;
    })
    .catch((err) => {
      setWorkerFailed(
        `the worker could not be started (${err instanceof Error ? err.message : String(err)})`
      );
      return null;
    });
  return workerStartPromise;
};

const acquireSlot = () => {
  if (usedSlots < assetsState.maxConcurrentLoads) {
    usedSlots += 1;
    return Promise.resolve();
  }
  // The slot is handed over as is by releaseSlot(), so usedSlots doesn't change
  return new Promise<void>((resolve) => slotQueue.push(resolve));
};

const releaseSlot = () => {
  const next = slotQueue.shift();
  if (next) next();
  else usedSlots -= 1;
};

/**
 * Sends one request to the worker and waits for its response, once a slot is free
 * (maxConcurrentLoads). The request timeout starts when the request is sent, not while it waits
 * in the queue. Rejects with an {@link AssetsWorkerRequestError}.
 */
const requestAssetsWorker = async <R extends AssetsDownProtocol>(
  message: DistributiveOmit<AssetsUpProtocol, 'requestId'>,
  transfer: Transferable[] = []
): Promise<R> => {
  await acquireSlot();
  let requestId: number | undefined;
  try {
    const activeWorker = worker;
    if (!activeWorker) {
      throw new AssetsWorkerRequestError(
        'CRASHED',
        `the worker is not running (${workerFailReason ?? 'not started'})`
      );
    }
    return await new Promise<R>((resolve, reject) => {
      requestId = createNewResolver(resolve, { reject, timeoutMs: assetsState.requestTimeoutMs });
      inFlightRequestIds.add(requestId);
      try {
        activeWorker.postMessage({ ...message, requestId }, transfer);
      } catch (err) {
        // Eg. a DataCloneError: nothing was sent, so no reply will come
        rejectRequest(requestId, err);
      }
    });
  } catch (err) {
    if (err instanceof RequestTimeoutError) {
      throw new AssetsWorkerRequestError('TIMEOUT', `the request timed out (${err.message})`);
    }
    throw err;
  } finally {
    if (requestId !== undefined) inFlightRequestIds.delete(requestId);
    releaseSlot();
  }
};

const fallBack = <T>(
  kind: AssetKind,
  cause: AssetsFallbackCause,
  detail: string,
  mainThreadTask: () => Promise<T>
) => {
  fallbackCounts[cause] += 1;
  lastFallback = { kind, cause, detail };
  if (!assetsState.fallbackToMainThread) {
    throw new Error(`Assets worker could not load a ${kind} asset (${cause}): ${detail}.`);
  }
  if (!warnedCauses.has(cause)) {
    warnedCauses.add(cause);
    lwarn(
      `Assets worker: ${detail}. Falling back to the main thread (${kind}, cause ${cause}; warned once per cause).`
    );
  }
  return mainThreadTask();
};

/**
 * Runs an asset load where its kind is targeted (see {@link getAssetsWorkerTarget}). A
 * worker-targeted load that can't run in the worker re-runs as `mainThreadTask` (warned once per
 * cause), or fails when AppConfig.assets.fallbackToMainThread is false. Both tasks must produce
 * the same result, so callers never depend on the thread. A load whose file itself failed in the
 * worker (eg. an HTTP error) is not re-run: its error is thrown as is.
 * @param kind {@link AssetKind}
 * @param workerTask the load through the worker
 * @param mainThreadTask the same load on the main thread
 * @param requiredCapability the worker capability this load needs (default: the kind's own,
 * see REQUIRED_CAPABILITY), or null when it needs none
 */
export const runAssetTask = async <T>(
  kind: AssetKind,
  workerTask: () => Promise<T>,
  mainThreadTask: () => Promise<T>,
  requiredCapability: keyof AssetsWorkerCapabilities | null = REQUIRED_CAPABILITY[kind]
): Promise<T> => {
  if (getAssetsWorkerTarget(kind) === 'MAIN_THREAD') return mainThreadTask();

  const startedWorker = await startWorker();
  if (!startedWorker) {
    return fallBack(kind, 'INIT_FAILED', workerFailReason || 'no worker', mainThreadTask);
  }
  if (requiredCapability && !workerCapabilities?.[requiredCapability]) {
    return fallBack(
      kind,
      'CAPABILITY',
      `the worker runtime has no "${requiredCapability}" support`,
      mainThreadTask
    );
  }

  try {
    return await workerTask();
  } catch (err) {
    if (err instanceof AssetsSourceError) throw err;
    const cause = err instanceof AssetsWorkerRequestError ? err.reason : 'WORKER_ERROR';
    return fallBack(kind, cause, err instanceof Error ? err.message : String(err), mainThreadTask);
  }
};

/**
 * Round-trips a PING through the assets worker, starting it if needed (whatever the
 * workerTarget: this is a debug/verification helper). Resolves with the round-trip time in ms,
 * or null when the worker could not be started or didn't answer.
 */
export const pingAssetsWorker = async () => {
  const startedWorker = await startWorker();
  if (!startedWorker) return null;
  const sentAt = performance.now();
  try {
    await requestAssetsWorker<AssetsPingResponse>({ type: AssetsProtocolType.PING });
  } catch (err) {
    lwarn('Assets worker PING failed:', err);
    return null;
  }
  return performance.now() - sentAt;
};

/**
 * Fetches and decodes a standard (non-HDR) image in the assets worker. The bitmap is already
 * flipped vertically (like TextureLoader's default flipY = true), so its texture needs
 * `flipY = false`. Call it inside {@link runAssetTask}.
 * @param url absolute URL
 */
export const loadTextureInWorker = async (url: string) =>
  (
    await requestAssetsWorker<AssetsLoadTextureResponse>({
      type: AssetsProtocolType.LOAD_TEXTURE,
      url,
    })
  ).bitmap;

/**
 * Fetches and parses an .hdr file in the assets worker (HDRLoader, HalfFloatType). Call it
 * inside {@link runAssetTask}.
 * @param url absolute URL
 */
export const loadHDRTextureInWorker = async (url: string) => {
  const { width, height, data } = await requestAssetsWorker<AssetsLoadHDRTextureResponse>({
    type: AssetsProtocolType.LOAD_HDR_TEXTURE,
    url,
  });
  return { width, height, data };
};

/**
 * Fetches, parses (DRACO decoded) and extracts a .glb/.gltf file in the assets worker, with the
 * same extractPrimitives() the main-thread import runs. The geometries come back as transferable
 * data (GeometryTransfer.ts's deserializeGeometry() rebuilds them). Call it inside
 * {@link runAssetTask}.
 * @param url absolute URL
 * @param opts.importId the import id (geometry id prefix)
 * @param opts.meshIndex only extract this node (see ImportAssetParams.meshIndex)
 * @param opts.draco the main thread's DRACO settings (DracoDecoder.ts's getDracoWorkerSettings())
 */
export const loadGLTFInWorker = (
  url: string,
  opts: { importId: string; meshIndex?: number | number[]; draco: DracoWorkerSettings }
) =>
  requestAssetsWorker<AssetsLoadGLTFResponse>({
    type: AssetsProtocolType.LOAD_GLTF,
    url,
    importId: opts.importId,
    ...(opts.meshIndex !== undefined ? { meshIndex: opts.meshIndex } : {}),
    draco: opts.draco,
  });
