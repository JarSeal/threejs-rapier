import fs from 'fs';
import path from 'path';

/**
 * A glTF's JSON (a .glb's first chunk, or a .gltf's whole text), read without gltf-transform:
 * what the pipeline needs to know about a file before it decides to encode it (p300 §7's cache
 * key), the same way the runtime reads `extensionsUsed` (core/Import/GLTFExtensions.ts).
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'

export type GLTFJson = {
  nodes?: { mesh?: number; extras?: { colliderType?: unknown } }[];
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
};

/**
 * Throws for a file that isn't a .glb or a .gltf's JSON. A .glb's binary chunk isn't read: the
 * dev server reads every GLB's JSON on each asset change (Phase 3).
 */
export const readGLTFJson = (file: string): GLTFJson => {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    const headerBytes = fs.readSync(fd, header, 0, 20, 0);
    let text: string;
    if (headerBytes === 20 && header.readUInt32LE(0) === GLB_MAGIC) {
      if (header.readUInt32LE(16) !== GLB_CHUNK_JSON) {
        throw new Error(`${file}: the .glb's first chunk isn't JSON`);
      }
      const json = Buffer.alloc(header.readUInt32LE(12));
      fs.readSync(fd, json, 0, json.byteLength, 20);
      text = json.toString('utf-8');
    } else {
      text = fs.readFileSync(fd, 'utf-8');
    }
    return JSON.parse(text) as GLTFJson;
  } finally {
    fs.closeSync(fd);
  }
};

/** A .gltf's buffers and images that are separate files (not data URIs), as written in it. */
export const listExternalGLTFUris = (json: GLTFJson) =>
  [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((entry) => entry.uri)
    .filter((uri): uri is string => !!uri && !uri.startsWith('data:'));

/** A .gltf's external files on disk, in the order the JSON lists them. */
export const listExternalGLTFFiles = (file: string, json: GLTFJson) =>
  listExternalGLTFUris(json).map((uri) =>
    path.resolve(path.dirname(file), decodeURIComponent(uri))
  );

/** A node with a mesh and a `colliderType` custom property (CustomProps.ts reads the same). */
export const hasColliderNodes = (json: GLTFJson) =>
  (json.nodes ?? []).some((node) => node.mesh !== undefined && !!node.extras?.colliderType);
