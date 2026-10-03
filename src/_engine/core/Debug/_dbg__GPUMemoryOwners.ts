import type * as THREE from 'three/webgpu';
import type { Renderer } from 'three/webgpu';
import { textureMapKeys } from '../../utils/constants';
import { getGeometryRegistry } from '../Geometry';
import { getMaterialRegistry, type Materials } from '../Material';
import { getTextureRegistry } from '../Texture';
import { getAssetOwner } from '../Assets/AssetOwners';

/**
 * Per-asset GPU bytes for the GPU memory tab's "By owner" view (p345 §2.1–2.2).
 *
 * The bytes are three's own: `renderer.info.memoryMap` holds, per uploaded texture and attribute,
 * exactly what `info.memory` counted for it. So owners plus untracked add up to
 * `info.memory.total`, and an asset that was never drawn (or not uploaded yet) holds 0 bytes.
 */

/** The owner of assets registered before the first scene load (AssetOwners stores none). */
export const BOOT_OWNER = 'boot';

export type GPUAssetKind = 'texture' | 'geometry';

export type GPUAssetRow = {
  /** Stable per asset across samples: `kind:id`, a material's own texture `texture:materialId.slot` */
  key: string;
  kind: GPUAssetKind;
  /** Readable id: the registry id, or `materialId › slot` for a texture a material holds alone */
  id: string;
  /** AssetOwners key: a scene id (later `sceneId#cellKey`, p353), or {@link BOOT_OWNER} */
  owner: string;
  /** three's counted bytes, 0 when not on the GPU */
  bytes: number;
  /** An estimate of what three leaves out of it (cube textures, {@link getUncountedCubeBytes}) */
  uncounted: number;
};

type MemoryMapEntry = number | { size: number; type: string };
type MemoryMap = WeakMap<object, MemoryMapEntry>;

/** `info.memoryMap` is three's own (Info.js) and missing from @types/three. */
const getMemoryMap = (renderer: Renderer) =>
  (renderer.info as unknown as { memoryMap: MemoryMap }).memoryMap;

const entryBytes = (entry: MemoryMapEntry | undefined) =>
  entry === undefined ? 0 : typeof entry === 'number' ? entry : entry.size;

type TextureSizer = { _getTextureMemorySize: (texture: THREE.Texture) => number };

/**
 * What three r186 leaves out of a cube texture: it sizes a texture by its image, and a cube's image
 * is an array of faces (or nothing, on a CubeRenderTarget), so it counts each face as 1×1. The
 * size three's own formula gives at the real face size (a render target's, or the first face's),
 * minus the `counted` bytes. 0 for anything else.
 */
export const getUncountedCubeBytes = (
  renderer: Renderer,
  texture: THREE.Texture,
  counted: number,
  faceSize?: { width: number; height: number }
) => {
  if (!(texture as THREE.CubeTexture).isCubeTexture || texture.width) return 0;
  const face = faceSize ?? (texture.image as { width?: number; height?: number }[] | null)?.[0];
  if (!face?.width || !face.height) return 0;
  // A view of the texture with the face size; type, format and mipmaps read through to it
  const sized = Object.create(texture, {
    width: { value: face.width },
    height: { value: face.height },
  }) as THREE.Texture;
  const bytes = (renderer.info as unknown as TextureSizer)._getTextureMemorySize(sized);
  return Math.max(0, bytes - counted);
};

/** The textures a material holds:its map slots and its TSL texture node inputs (createMaterial
 * keeps those in userData.uniforms), the same places Material.ts checks before a release. */
const forEachMaterialTexture = (
  material: Materials,
  fn: (texture: THREE.Texture, slot: string) => void
) => {
  for (let i = 0; i < textureMapKeys.length; i++) {
    const texture = material[textureMapKeys[i] as keyof Materials] as THREE.Texture | undefined;
    if (texture?.isTexture) fn(texture, textureMapKeys[i]);
  }
  const uniforms = material.userData.uniforms as Record<string, unknown> | undefined;
  for (const key in uniforms) {
    const node = uniforms[key] as { isTextureNode?: boolean; value?: THREE.Texture } | undefined;
    if (node?.isTextureNode && node.value?.isTexture) fn(node.value, key);
  }
};

/**
 * Every registered texture and geometry, plus the textures registered materials hold alone (eg.
 * clones: three uploads each Texture object on its own), with three's bytes and their owner.
 * A GPU object shared by two assets counts once, for the first. `counted` collects the GPU
 * objects counted, for the sources to skip (_dbg__GPUMemorySources.ts).
 */
export const collectGPUAssets = (
  renderer: Renderer,
  counted = new Set<object>()
): GPUAssetRow[] => {
  const memoryMap = getMemoryMap(renderer);
  const bytesOf = (gpuObject: object) => {
    if (counted.has(gpuObject)) return 0;
    counted.add(gpuObject);
    return entryBytes(memoryMap.get(gpuObject));
  };
  const rows: GPUAssetRow[] = [];

  const uncountedOf = (texture: THREE.Texture, bytes: number) =>
    bytes ? getUncountedCubeBytes(renderer, texture, bytes) : 0;

  for (const [id, entry] of Object.entries(getTextureRegistry())) {
    const bytes = bytesOf(entry.resource);
    rows.push({
      key: `texture:${id}`,
      kind: 'texture',
      id,
      owner: getAssetOwner(entry.resource) ?? BOOT_OWNER,
      bytes,
      uncounted: uncountedOf(entry.resource, bytes),
    });
  }

  for (const [id, entry] of Object.entries(getGeometryRegistry())) {
    const geometry = entry.resource;
    let bytes = 0;
    for (const name in geometry.attributes) bytes += bytesOf(geometry.attributes[name]);
    if (geometry.index) bytes += bytesOf(geometry.index);
    rows.push({
      key: `geometry:${id}`,
      kind: 'geometry',
      id,
      owner: getAssetOwner(geometry) ?? BOOT_OWNER,
      bytes,
      uncounted: 0,
    });
  }

  // After the registered textures, so a registered one a material holds is already counted
  for (const [materialId, entry] of Object.entries(getMaterialRegistry())) {
    const owner = getAssetOwner(entry.resource) ?? BOOT_OWNER;
    forEachMaterialTexture(entry.resource, (texture, slot) => {
      if (counted.has(texture)) return;
      const bytes = bytesOf(texture);
      if (!bytes) return;
      rows.push({
        key: `texture:${materialId}.${slot}`,
        kind: 'texture',
        id: `${materialId} › ${slot}`,
        owner,
        bytes,
        uncounted: uncountedOf(texture, bytes),
      });
    });
  }

  return rows;
};

/** What one asset or source adds to its owner: texture bytes, and buffer bytes (attributes,
 * index, storage) under geometries. */
export type OwnerItem = { owner: string; textures: number; geometries: number };

export const assetOwnerItem = (row: GPUAssetRow): OwnerItem => ({
  owner: row.owner,
  textures: row.kind === 'texture' ? row.bytes : 0,
  geometries: row.kind === 'geometry' ? row.bytes : 0,
});

export type OwnerSums = OwnerItem & {
  total: number;
  /** Assets and sources with bytes on the GPU */
  count: number;
};

export type OwnerGroup = OwnerSums & {
  /** Per-cell sums (`sceneId#cellKey` owners, p353), largest first; empty until streaming lands */
  cells: OwnerSums[];
};

const emptySums = (owner: string): OwnerSums => ({
  owner,
  textures: 0,
  geometries: 0,
  total: 0,
  count: 0,
});

const addItem = (sums: OwnerSums, item: OwnerItem) => {
  sums.textures += item.textures;
  sums.geometries += item.geometries;
  sums.total += item.textures + item.geometries;
  sums.count++;
};

/** Sums the items per owner, grouped by the part before `#` (a scene, with its cells under it),
 * largest first. Items with 0 bytes (not on the GPU) are left out. */
export const groupByOwner = (items: OwnerItem[]): OwnerGroup[] => {
  const groups = new Map<string, OwnerGroup>();
  for (const item of items) {
    if (!item.textures && !item.geometries) continue;
    const hashAt = item.owner.indexOf('#');
    const groupKey = hashAt < 0 ? item.owner : item.owner.slice(0, hashAt);
    let group = groups.get(groupKey);
    if (!group) {
      group = { ...emptySums(groupKey), cells: [] };
      groups.set(groupKey, group);
    }
    addItem(group, item);
    if (hashAt < 0) continue;
    let cell = group.cells.find((c) => c.owner === item.owner);
    if (!cell) {
      cell = emptySums(item.owner);
      group.cells.push(cell);
    }
    addItem(cell, item);
  }
  const sorted = [...groups.values()].sort((a, b) => b.total - a.total);
  for (const group of sorted) group.cells.sort((a, b) => b.total - a.total);
  return sorted;
};
