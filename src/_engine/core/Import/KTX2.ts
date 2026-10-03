import * as THREE from 'three/webgpu';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { getRenderer } from '../Renderer';
import type { KTX2WorkerSettings } from '../Assets/AssetsAPITypes';

let ktx2Loader: Promise<KTX2Loader> | null = null;
/** The renderer the shared loader detected its supported formats on. */
let detectedOn: THREE.WebGPURenderer | null = null;

const getTranscoderPath = () => new URL(`${import.meta.env.BASE_URL}basis/`, document.baseURI).href;

/**
 * Returns the one shared KTX2Loader (KTX2 / Basis Universal textures), creating it on the first
 * call. KTX2Loader itself is imported then, so apps without KTX2 files never download it.
 * It detects which GPU formats it can transcode to on the renderer, so it throws before
 * createRenderer() has finished; a new renderer (eg. after deleteRenderer()) gets a new loader.
 * The transcoder (`${BASE_URL}basis/`, filled by `devTools/copyDecoders.ts`) is only fetched,
 * and its worker pool only started, when the first file is transcoded.
 */
export const getKTX2Loader = () => {
  const renderer = getRenderer();
  if (!renderer) {
    return Promise.reject(
      new Error('KTX2 textures can only be loaded after the renderer has been created.')
    );
  }
  if (ktx2Loader && detectedOn === renderer) return ktx2Loader;

  disposeKTX2Loader();
  detectedOn = renderer;
  ktx2Loader = import('three/addons/loaders/KTX2Loader.js').then(({ KTX2Loader }) =>
    new KTX2Loader().setTranscoderPath(getTranscoderPath()).detectSupport(renderer)
  );
  return ktx2Loader;
};

/**
 * Loads a .ktx2 file through the shared KTX2Loader (transcoded in its own worker pool, into the
 * best format the GPU supports). The result is a CompressedTexture (a CompressedArrayTexture or
 * CompressedCubeTexture for an array or cube file) with the file's mip chain: compressed
 * textures can't be flipped (`flipY`) or get mipmaps generated at upload, so both are baked in
 * when the file is encoded.
 * @param url the file's URL
 */
export const loadKTX2Texture = async (url: string) =>
  (await getKTX2Loader()).loadAsync(url) as Promise<THREE.CompressedTexture>;

/**
 * Returns the shared KTX2Loader's settings for the assets worker's own KTX2Loader (which has no
 * renderer to detect support with), or null when there is no renderer yet.
 */
export const getKTX2WorkerSettings = async (): Promise<KTX2WorkerSettings | null> => {
  if (!getRenderer()) return null;
  const loader = await getKTX2Loader();
  return { transcoderPath: getTranscoderPath(), workerConfig: { ...loader.workerConfig } };
};

/**
 * Terminates the shared KTX2Loader's worker pool and drops it. The next {@link getKTX2Loader}
 * call creates a new one. Not called automatically, except when the renderer has changed.
 */
export const disposeKTX2Loader = () => {
  if (!ktx2Loader) return;
  ktx2Loader.then((loader) => loader.dispose()).catch(() => {});
  ktx2Loader = null;
  detectedOn = null;
};
