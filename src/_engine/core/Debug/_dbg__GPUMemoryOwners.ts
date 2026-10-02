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
};

type MemoryMapEntry = number | { size: number; type: string };
type MemoryMap = WeakMap<object, MemoryMapEntry>;

/** `info.memoryMap` is three's own (Info.js) and missing from @types/three. */
const getMemoryMap = (renderer: Renderer) =>
  (renderer.info as unknown as { memoryMap: MemoryMap }).memoryMap;

const entryBytes = (entry: MemoryMapEntry | undefined) =>
  entry === undefined ? 0 : typeof entry === 'number' ? entry : entry.size;

/** The textures a material holds: its map slots and its TSL texture node inputs (createMaterial
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
 * A GPU object shared by two assets counts once, for the first.
 */
export const collectGPUAssets = (renderer: Renderer): GPUAssetRow[] => {
  const memoryMap = getMemoryMap(renderer);
  const counted = new Set<object>();
  const bytesOf = (gpuObject: object) => {
    if (counted.has(gpuObject)) return 0;
    counted.add(gpuObject);
    return entryBytes(memoryMap.get(gpuObject));
  };
  const rows: GPUAssetRow[] = [];

  for (const [id, entry] of Object.entries(getTextureRegistry())) {
    rows.push({
      key: `texture:${id}`,
      kind: 'texture',
      id,
      owner: getAssetOwner(entry.resource) ?? BOOT_OWNER,
      bytes: bytesOf(entry.resource),
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
      });
    });
  }

  return rows;
};

export type OwnerSums = {
  owner: string;
  textures: number;
  geometries: number;
  total: number;
  /** Assets with bytes on the GPU */
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

const addRow = (sums: OwnerSums, row: GPUAssetRow) => {
  if (row.kind === 'texture') sums.textures += row.bytes;
  else sums.geometries += row.bytes;
  sums.total += row.bytes;
  sums.count++;
};

/** Sums the rows per owner, grouped by the part before `#` (a scene, with its cells under it),
 * largest first. Rows with 0 bytes (not on the GPU) are left out. */
export const groupByOwner = (rows: GPUAssetRow[]): OwnerGroup[] => {
  const groups = new Map<string, OwnerGroup>();
  for (const row of rows) {
    if (!row.bytes) continue;
    const hashAt = row.owner.indexOf('#');
    const groupKey = hashAt < 0 ? row.owner : row.owner.slice(0, hashAt);
    let group = groups.get(groupKey);
    if (!group) {
      group = { ...emptySums(groupKey), cells: [] };
      groups.set(groupKey, group);
    }
    addRow(group, row);
    if (hashAt < 0) continue;
    let cell = group.cells.find((c) => c.owner === row.owner);
    if (!cell) {
      cell = emptySums(row.owner);
      group.cells.push(cell);
    }
    addRow(cell, row);
  }
  const sorted = [...groups.values()].sort((a, b) => b.total - a.total);
  for (const group of sorted) group.cells.sort((a, b) => b.total - a.total);
  return sorted;
};
