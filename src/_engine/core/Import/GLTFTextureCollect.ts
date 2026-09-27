// Runs on both threads (main-thread imports and the assets worker): keep it free of imports that
// touch `window`/`document` (eg. Config.ts, Logger.ts, Texture.ts, utils/helpers.ts).
import type * as THREE from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { textureMapKeys } from '../../utils/constants';
import type { TextureMapKeys } from '../Material';
import type { ExtractedPrimitive } from './GLTFExtract';

export type CollectedGLTFTexture = {
  texture: THREE.Texture;
  /** The id part of the texture's registry id (`${importId}/${name}`). */
  name: string;
  /** Identifies the texture within its glTF file across re-imports. */
  gltfTextureKey: string;
};

export type CollectedGLTFTextures = {
  /** Every texture object used by a primitive's material slot, once, in first-use order. */
  textures: CollectedGLTFTexture[];
  /** Per extracted primitive (same order): slot → index in `textures`, in slot walk order. */
  slotsPerPrimitive: Partial<Record<TextureMapKeys, number>>[];
};

/** Texture name → id part: the glTF texture name, else the image name or file basename
 * (GLTFLoader puts those in `texture.name`), else the glTF texture index. */
const getTextureName = (texture: THREE.Texture, gltf: GLTF) => {
  const name = texture.name
    .split(/[?#]/)[0]
    .split('/')
    .pop()
    ?.replace(/\.[a-z0-9]+$/i, '');
  if (name) return name;
  const assoc = gltf.parser.associations.get(texture) as { textures?: number } | undefined;
  return `texture_${assoc?.textures ?? texture.id}`;
};

/** Identifies a texture within its glTF file across re-imports: the glTF texture index, plus the
 * UV channel and transform, which differ on GLTFLoader's clones (texCoord > 0 or
 * KHR_texture_transform) of the same glTF texture. */
const getGltfTextureKey = (texture: THREE.Texture, gltf: GLTF) => {
  const assoc = gltf.parser.associations.get(texture) as { textures?: number } | undefined;
  const { offset, repeat, rotation, channel } = texture;
  return `${assoc?.textures}:${channel}:${offset.x},${offset.y}:${repeat.x},${repeat.y}:${rotation}`;
};

/**
 * Finds the textures in the extracted primitives' glTF material slots (only slots in
 * `textureMapKeys`; the first material with a slot filled wins it). Pure: nothing is registered,
 * disposed or logged. GLTFTextures.ts's registerGLTFTextures() registers the result.
 */
export const collectGLTFTextures = (
  gltf: GLTF,
  primitives: Pick<ExtractedPrimitive, 'material'>[]
): CollectedGLTFTextures => {
  const textures: CollectedGLTFTexture[] = [];
  const indexByTexture = new Map<THREE.Texture, number>();

  const slotsPerPrimitive = primitives.map(({ material }) => {
    const slots: Partial<Record<TextureMapKeys, number>> = {};
    const materials = Array.isArray(material) ? material : [material];
    for (const mat of materials) {
      if (!mat) continue;
      for (const key of textureMapKeys as TextureMapKeys[]) {
        const texture = (mat as unknown as Record<string, unknown>)[key] as THREE.Texture | null;
        if (!texture?.isTexture || slots[key] !== undefined) continue;
        let index = indexByTexture.get(texture);
        if (index === undefined) {
          index =
            textures.push({
              texture,
              name: getTextureName(texture, gltf),
              gltfTextureKey: getGltfTextureKey(texture, gltf),
            }) - 1;
          indexByTexture.set(texture, index);
        }
        slots[key] = index;
      }
    }
    return slots;
  });

  return { textures, slotsPerPrimitive };
};
