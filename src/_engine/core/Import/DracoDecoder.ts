import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { lwarn } from '../../utils/Logger';

export type DracoConfig = {
  /** Directory (with a trailing slash) that serves `draco_decoder.js`, `draco_decoder.wasm` and
   * `draco_wasm_wrapper.js`. Default: `${BASE_URL}draco/gltf/`, filled by
   * `devTools/copyDracoDecoders.ts`. A cross-origin path (eg. a CDN) must send CORS/CORP
   * headers, because the dev server enables cross-origin isolation (COEP `require-corp`). */
  decoderPath?: string;
  /** 'wasm' (default) or the slower pure-JS 'js' decoder (used automatically when WebAssembly
   * is not available). */
  decoderType?: 'wasm' | 'js';
  /** Max number of DRACO decoder workers. Default 4 (DRACOLoader's default). */
  workerLimit?: number;
};

let dracoLoader: DRACOLoader | null = null;
let config: DracoConfig = {};

/** True once the decoder files have been requested (GLTFLoader calls `preload()` as soon as it
 * parses a file that uses KHR_draco_mesh_compression): the decoder path and type are locked from
 * then on. `decoderPending` is a plain DRACOLoader field that @types/three doesn't declare. */
const isDecoderLocked = (loader: DRACOLoader) =>
  Boolean((loader as unknown as { decoderPending: Promise<void> | null }).decoderPending);

const getDefaultDecoderPath = () =>
  new URL(`${import.meta.env.BASE_URL}draco/gltf/`, document.baseURI).href;

/**
 * Returns the one shared DRACOLoader, creating it on the first call. Creating it costs nothing:
 * the decoder files are only fetched (once) when the first file using
 * KHR_draco_mesh_compression is parsed, so apps without compressed models never download them.
 */
export const getDracoLoader = () => {
  if (dracoLoader) return dracoLoader;

  const loader = new DRACOLoader();
  loader.setDecoderPath(config.decoderPath || getDefaultDecoderPath());
  loader.setDecoderConfig({ type: config.decoderType || 'wasm' });
  if (config.workerLimit !== undefined) loader.setWorkerLimit(config.workerLimit);
  dracoLoader = loader;
  return dracoLoader;
};

/**
 * Configures the shared DRACO decoder. Call it before the first compressed import: once the
 * decoder has been requested, `decoderPath` and `decoderType` only take effect after
 * {@link disposeDracoLoader}. `workerLimit` can be changed any time (it doesn't shrink an
 * already started pool).
 * @param newConfig {@link DracoConfig}
 */
export const configureDraco = (newConfig: DracoConfig) => {
  config = { ...config, ...newConfig };
  if (!dracoLoader) return;

  if (newConfig.workerLimit !== undefined) dracoLoader.setWorkerLimit(newConfig.workerLimit);
  if (newConfig.decoderPath === undefined && newConfig.decoderType === undefined) return;

  if (isDecoderLocked(dracoLoader)) {
    lwarn(
      'configureDraco: the DRACO decoder is already in use, so the new decoderPath/decoderType only apply after disposeDracoLoader().'
    );
    return;
  }
  dracoLoader.setDecoderPath(config.decoderPath || getDefaultDecoderPath());
  dracoLoader.setDecoderConfig({ type: config.decoderType || 'wasm' });
};

/**
 * Terminates the shared DRACO worker pool and drops the loader. The next
 * {@link getDracoLoader} call creates a new one (and fetches the decoder again when used).
 * Loaders that already hold the old instance must not be used for compressed files after this.
 * Not called automatically.
 */
export const disposeDracoLoader = () => {
  if (!dracoLoader) return;
  dracoLoader.dispose();
  dracoLoader = null;
};
