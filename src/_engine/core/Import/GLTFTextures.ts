import * as THREE from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { lwarn } from '../../utils/Logger';
import { textureMapKeys } from '../../utils/constants';
import type { TextureMapKeys } from '../Material';
import { doesTextureExist, getTextureRegistry, saveTexture, type TexOpts } from '../Texture';
import type { ExtractedPrimitive } from './GLTFExtract';

type TextureSlots = Partial<Record<TextureMapKeys, string>>;

export type RegisteredGLTFTextures = {
  textureIds: string[];
  /** Per extracted primitive (same order): slot → registered texture id. */
  slotsPerPrimitive: TextureSlots[];
  /** The registered texture objects, which the glTF disposal must keep. */
  keep: Set<THREE.Texture>;
};

const applyTexOpts = (texture: THREE.Texture, texOpts?: TexOpts) => {
  if (!texOpts) return;
  if (texOpts.mapping !== undefined) texture.mapping = texOpts.mapping;
  if (texOpts.wrapS !== undefined) texture.wrapS = texOpts.wrapS;
  if (texOpts.wrapT !== undefined) texture.wrapT = texOpts.wrapT;
  if (texOpts.magFilter !== undefined) texture.magFilter = texOpts.magFilter;
  if (texOpts.minFilter !== undefined) texture.minFilter = texOpts.minFilter;
  if (texOpts.format !== undefined) texture.format = texOpts.format;
  if (texOpts.type !== undefined) texture.type = texOpts.type;
  if (texOpts.anisotropy !== undefined) texture.anisotropy = texOpts.anisotropy;
  if (texOpts.colorSpace !== undefined) texture.colorSpace = texOpts.colorSpace;
  texture.needsUpdate = true;
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

/** Registry id for a texture: `${importId}/${name}`, or the first free `_n`-suffixed one. A
 * texture this same import registered earlier from the same glTF texture is reused. */
const resolveTextureId = (preferredId: string, importId: string, gltfTextureKey: string) => {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? preferredId : `${preferredId}_${n}`;
    if (!doesTextureExist(candidate)) return { textureId: candidate, isReused: false };
    const userData = getTextureRegistry()[candidate].resource.userData;
    if (userData.importId === importId && userData.gltfTextureKey === gltfTextureKey) {
      return { textureId: candidate, isReused: true };
    }
  }
};

/**
 * Registers the textures used by the extracted primitives' glTF material slots (only slots in
 * `textureMapKeys`), once per texture object even when shared by several slots or materials.
 * GLTFLoader's flipY (false) and per-slot colorSpace are kept, unless `texOpts` override them.
 * Each registered texture gets `userData.gltfSlots` (every slot it fills) and `userData.importId`.
 */
export const registerGLTFTextures = (
  gltf: GLTF,
  primitives: ExtractedPrimitive[],
  opts: {
    importId: string;
    /** Debug name prefix (the import's debugData name, else its id). */
    importName: string;
    fileName: string;
    texOpts?: TexOpts;
    isPersistent?: boolean;
  }
): RegisteredGLTFTextures => {
  const { importId, importName, fileName, texOpts, isPersistent } = opts;
  const idByTexture = new Map<THREE.Texture, string>();
  const textureIds: string[] = [];
  const keep = new Set<THREE.Texture>();
  const idsInUse = new Set<string>();

  const slotsById = new Map<string, Set<string>>();

  const registerTexture = (texture: THREE.Texture, slot: TextureMapKeys) => {
    const existingId = idByTexture.get(texture);
    if (existingId) {
      slotsById.get(existingId)?.add(slot);
      return existingId;
    }

    const gltfTextureKey = getGltfTextureKey(texture, gltf);
    const name = getTextureName(texture, gltf);
    let preferredId = `${importId}/${name}`;
    for (let n = 2; idsInUse.has(preferredId); n++) preferredId = `${importId}/${name}_${n}`;
    idsInUse.add(preferredId);

    const { textureId, isReused } = resolveTextureId(preferredId, importId, gltfTextureKey);
    idByTexture.set(texture, textureId);
    textureIds.push(textureId);
    slotsById.set(textureId, new Set([slot]));
    if (isReused) return textureId;
    if (textureId !== preferredId) {
      lwarn(
        `Import "${importId}" (${fileName}): texture id "${preferredId}" is already used by another texture, registered as "${textureId}" instead.`
      );
    }

    applyTexOpts(texture, texOpts);
    texture.userData.importId = importId;
    texture.userData.gltfTextureKey = gltfTextureKey;
    texture.userData.name = `${importName} / ${name}`;
    saveTexture(texture, textureId, isPersistent);
    keep.add(texture);
    return textureId;
  };

  const slotsPerPrimitive = primitives.map(({ material }) => {
    const slots: TextureSlots = {};
    const materials = Array.isArray(material) ? material : [material];
    for (const mat of materials) {
      if (!mat) continue;
      for (const key of textureMapKeys as TextureMapKeys[]) {
        const texture = (mat as unknown as Record<string, unknown>)[key] as THREE.Texture | null;
        if (texture?.isTexture && !slots[key]) slots[key] = registerTexture(texture, key);
      }
    }
    return slots;
  });

  // On the registered texture (a reused one included): every slot it fills in this import
  for (const [textureId, slots] of slotsById) {
    getTextureRegistry()[textureId].resource.userData.gltfSlots = [...slots];
  }

  return { textureIds, slotsPerPrimitive, keep };
};
