import * as THREE from 'three/webgpu';
import { type GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getDracoLoader } from './DracoDecoder';

const ALLOWED_FILENAME_EXTENSIONS = ['gltf', 'glb'];

/** In-flight file fetches by absolute URL. Entries are removed once settled: this only merges
 * parallel requests for the same file, it is not a cache. */
const pendingFetches = new Map<string, Promise<ArrayBuffer>>();

let gltfLoader: GLTFLoader | null = null;
const getGLTFLoader = () => {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(getDracoLoader());
  }
  return gltfLoader;
};

/** Returns an error message for an invalid glTF file name, or null when it is valid. */
export const validateGLTFFileName = (fileName: string) => {
  if (!fileName) return 'To import a model, the "fileName" param is required.';
  const extension = fileName.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  if (!extension || !ALLOWED_FILENAME_EXTENSIONS.includes(extension)) {
    return `Unknown file extension "${extension}" in "${fileName}" (allowed: ${ALLOWED_FILENAME_EXTENSIONS.join(', ')}).`;
  }
  return null;
};

/** Resolves a file name against the document, so the same file always has the same key. */
export const toAbsoluteUrl = (fileName: string) => new URL(fileName, document.baseURI).href;

const fetchFile = (url: string) => {
  const pending = pendingFetches.get(url);
  if (pending) return pending;

  const promise = fetch(url)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for "${url}"`);
      }
      // SPA-style servers (incl. the Vite dev server) answer a missing file with index.html
      if (response.headers.get('content-type')?.includes('text/html')) {
        throw new Error(`File not found (the server returned an HTML page) for "${url}"`);
      }
      return response.arrayBuffer();
    })
    .finally(() => pendingFetches.delete(url));
  pendingFetches.set(url, promise);
  return promise;
};

/**
 * Loads and parses a .glb/.gltf file. Parallel calls for the same URL share one network fetch,
 * but each call gets its own parsed GLTF (every caller owns, and disposes, its result).
 * DRACO-compressed primitives are decoded through the shared DRACO loader.
 * @param fileName URL of the file
 * @returns Promise<GLTF>
 */
export const loadGLTF = async (fileName: string): Promise<GLTF> => {
  const url = toAbsoluteUrl(fileName);
  const data = await fetchFile(url);
  return getGLTFLoader().parseAsync(data, THREE.LoaderUtils.extractUrlBase(url));
};
