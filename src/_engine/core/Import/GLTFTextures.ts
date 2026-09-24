import * as THREE from 'three/webgpu';
import { lwarn } from '../../utils/Logger';
import type { TextureMapKeys } from '../Material';
import { doesTextureExist, getTextureRegistry, saveTexture, type TexOpts } from '../Texture';
import type { CollectedGLTFTextures } from './GLTFTextureCollect';
import { retagAssetOwner } from '../Assets/AssetOwners';

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
 * Registers the textures collectGLTFTextures() found in the extracted primitives' glTF material
 * slots, once per texture object even when shared by several slots or materials.
 * GLTFLoader's flipY (false) and per-slot colorSpace are kept, unless `texOpts` override them.
 * Each registered texture gets `userData.gltfSlots` (every slot it fills) and `userData.importId`.
 */
export const registerGLTFTextures = (
  collected: CollectedGLTFTextures,
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
  /** Index in collected.textures → registered id. */
  const idByIndex: string[] = [];
  const textureIds: string[] = [];
  const keep = new Set<THREE.Texture>();
  const idsInUse = new Set<string>();

  const slotsById = new Map<string, Set<string>>();

  const registerTexture = (index: number, slot: TextureMapKeys) => {
    const existingId = idByIndex[index];
    if (existingId) {
      slotsById.get(existingId)?.add(slot);
      return existingId;
    }

    const { texture, name, gltfTextureKey } = collected.textures[index];
    let preferredId = `${importId}/${name}`;
    for (let n = 2; idsInUse.has(preferredId); n++) preferredId = `${importId}/${name}_${n}`;
    idsInUse.add(preferredId);

    const { textureId, isReused } = resolveTextureId(preferredId, importId, gltfTextureKey);
    idByIndex[index] = textureId;
    textureIds.push(textureId);
    slotsById.set(textureId, new Set([slot]));
    if (isReused) {
      retagAssetOwner(getTextureRegistry()[textureId].resource);
      return textureId;
    }
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

  // Registered in slot walk order, which decides the `_n` suffixes and the id order
  const slotsPerPrimitive = collected.slotsPerPrimitive.map((indices) => {
    const slots: TextureSlots = {};
    for (const [key, index] of Object.entries(indices) as [TextureMapKeys, number][]) {
      slots[key] = registerTexture(index, key);
    }
    return slots;
  });

  // On the registered texture (a reused one included): every slot it fills in this import
  for (const [textureId, slots] of slotsById) {
    getTextureRegistry()[textureId].resource.userData.gltfSlots = [...slots];
  }

  return { textureIds, slotsPerPrimitive, keep };
};
