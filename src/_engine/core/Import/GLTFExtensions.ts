// Shared by the main thread (GLTFSource.ts) and the assets worker: keep this file free of imports
// that touch `window`/`document`.
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'

/**
 * Returns the glTF's `extensionsUsed`, read from the file's JSON (a .glb's first chunk, or a
 * .gltf's whole text) without parsing anything else. GLTFLoader needs its decoders (meshopt,
 * KTX2) set before it parses, so this decides which ones a file needs. Empty for a file it
 * can't read: GLTFLoader then reports the real error.
 * @param data the file's bytes
 */
export const readGLTFExtensionsUsed = (data: ArrayBuffer): string[] => {
  try {
    let jsonBytes: Uint8Array;
    const view = new DataView(data);
    if (data.byteLength >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
      const chunkLength = view.getUint32(12, true);
      if (view.getUint32(16, true) !== GLB_CHUNK_JSON) return [];
      jsonBytes = new Uint8Array(data, 20, chunkLength);
    } else {
      jsonBytes = new Uint8Array(data);
    }
    const json = JSON.parse(new TextDecoder().decode(jsonBytes)) as { extensionsUsed?: unknown };
    return Array.isArray(json.extensionsUsed) ? json.extensionsUsed.map(String) : [];
  } catch {
    return [];
  }
};

/** The decoders a file's extensions need (see {@link readGLTFExtensionsUsed}). */
export const getGLTFDecoderNeeds = (extensionsUsed: string[]) => ({
  meshopt: extensionsUsed.includes('EXT_meshopt_compression'),
  ktx2: extensionsUsed.includes('KHR_texture_basisu'),
});

/**
 * Sets the meshopt decoder and the KTX2 loader on a GLTFLoader for the next parse, each only when
 * given (a loader shared between files keeps the ones it got earlier, which is harmless).
 */
export const setGLTFDecoders = (
  loader: GLTFLoader,
  decoders: { meshopt?: typeof MeshoptDecoder | null; ktx2?: KTX2Loader | null }
) => {
  if (decoders.meshopt) loader.setMeshoptDecoder(decoders.meshopt);
  if (decoders.ktx2) loader.setKTX2Loader(decoders.ktx2);
};
