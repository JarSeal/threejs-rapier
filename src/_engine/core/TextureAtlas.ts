import * as THREE from 'three/webgpu';
import { clamp, mix, texture, vec2, vec4 } from 'three/tsl';
import type { TextureAtlasCellInfo, TextureAtlasSlotInfo } from '../schemas/textureAtlasSchema';
import { lwarn } from '../utils/Logger';
import { retagAssetOwner } from './Assets/AssetOwners';
import { getGeometryRegistry, saveBufferGeometry } from './Geometry';
import { getTexture, getTextureRegistry } from './Texture';

/**
 * 2D texture atlases (p299 D3): cells of any size packed into one layout by the asset pipeline
 * (`*.textureAtlas.json`), one KTX2 output per map slot. At runtime each slot is an ordinary
 * registered texture, id `<atlasId>.<slot>`, loaded by loadTextureAsync from its output, with the
 * cell table on its `userData.textureAtlas` ({@link getTextureAtlasInfo}). A scene lists the atlas
 * id in its `textures` for every slot, or a slot's id for that one.
 *
 * The mip chain stops at the last level the layout keeps apart (`levels`), so a cell sampled at
 * any level the texture has never reads its neighbour. An atlas with `mipChain: "FULL"` (p351
 * Phase 4: an impostor's neighbouring views) has every level down to 1 × 1 instead, and its
 * levels past `levels` mix neighbouring cells.
 */

/** A slot texture's cell table and layout, on its `userData.textureAtlas`. */
export type TextureAtlasInfo = TextureAtlasSlotInfo & {
  /** The loaded file's size: the layout's (`size`), halved once per top level its maxSize
   * dropped */
  width: number;
  height: number;
  /** Mip levels in the file: `levels` (with `mipChain: 'FULL'`, the full chain's) less the top
   * levels its maxSize dropped, or 1 with `mipmaps: false` */
  storedLevels: number;
};

/** A cell's content rect as UVs, `[u0, v0, u1, v1]` with v up (three's, like a mesh's UVs) */
export type AtlasCellRect = [u0: number, v0: number, u1: number, v1: number];

type TextureUV = Parameters<typeof texture>[1];

/** A slot texture's cell table and layout (see {@link TextureAtlasInfo}), or undefined for other
 * textures. */
export const getTextureAtlasInfo = (texture: THREE.Texture) =>
  texture.userData.textureAtlas as TextureAtlasInfo | undefined;

/** The atlas info of a slot texture, a slot's id, or the first registered slot of an atlas id. */
const findAtlasInfo = (atlas: string | THREE.Texture) => {
  if (typeof atlas !== 'string') return getTextureAtlasInfo(atlas);
  const slot = getTexture(atlas);
  if (slot) return getTextureAtlasInfo(slot);
  // Every slot of an atlas has the same cell table
  for (const { resource } of Object.values(getTextureRegistry())) {
    const info = getTextureAtlasInfo(resource);
    if (info?.id === atlas) return info;
  }
  return undefined;
};

/**
 * A cell of a loaded atlas: its content rect as UVs (`uv`, v up), its content size in the layout's
 * px and its `data`. Undefined when the cell isn't there, or no slot of the atlas is loaded yet:
 * an atlas has no runtime object of its own, every slot texture carries the cell table.
 * @param atlas the atlas id (`*.textureAtlas.json`), a slot's id (`<atlasId>.<slot>`) or a slot
 * texture
 * @param cellId the cell's id in the atlas JSON
 */
export const getAtlasCell = (
  atlas: string | THREE.Texture,
  cellId: string
): TextureAtlasCellInfo | undefined => findAtlasInfo(atlas)?.cells[cellId];

export type SampleAtlasCellOpts = {
  /** Keeps the sample half a level-0 texel inside the cell's content rect, so a bilinear tap never
   * reaches past the content's edge texels: for UVs outside 0..1, anisotropic taps, or an atlas
   * with little padding. Default true. */
  clampToCell?: boolean;
};

const getLevel0Size = (slot: THREE.Texture) => {
  const info = getTextureAtlasInfo(slot);
  const image = slot.image as { width?: number; height?: number } | null;
  const width = info?.width ?? image?.width;
  const height = info?.height ?? image?.height;
  if (!width || !height) {
    throw new Error(
      `sampleAtlasCell: texture "${slot.userData.id ?? slot.uuid}" has no size yet; clampToCell needs it (load it first, or pass clampToCell: false).`
    );
  }
  return { width, height };
};

const toRectNode = (slot: THREE.Texture, cell: string | AtlasCellRect | THREE.Node<'vec4'>) => {
  if (Array.isArray(cell)) return vec4(...cell) as unknown as THREE.Node<'vec4'>;
  if (typeof cell !== 'string') return cell;
  const info = getTextureAtlasInfo(slot);
  const slotId = slot.userData.id ?? slot.uuid;
  if (!info) {
    throw new Error(
      `sampleAtlasCell: texture "${slotId}" isn't an atlas slot, so cell "${cell}" means nothing: pass a rect.`
    );
  }
  const found = info.cells[cell];
  if (!found) {
    throw new Error(
      `sampleAtlasCell: atlas "${info.id}" has no cell "${cell}" (cells: ${Object.keys(info.cells).join(', ')}).`
    );
  }
  return vec4(...found.uv) as unknown as THREE.Node<'vec4'>;
};

/**
 * Samples one cell of an atlas slot: `uvNode` (0..1 over the cell, eg. the mesh's `uv()`) is
 * mapped into the cell's content rect. Returns the texture node, so `.level()`, `.bias()` or
 * `.grad()` can follow. A mesh UV'd straight into atlas space samples the slot with plain
 * `texture(slot)` instead.
 * @param slot an atlas slot texture (or any texture, with the cell as a rect)
 * @param uvNode the UV over the cell
 * @param cell the cell's id, its content rect (`[u0, v0, u1, v1]`, v up), or a `vec4` node of one
 * (eg. a per-instance attribute: one material for many cells)
 * @param opts {@link SampleAtlasCellOpts}
 */
export const sampleAtlasCell = (
  slot: THREE.Texture,
  uvNode: THREE.Node<'vec2'>,
  cell: string | AtlasCellRect | THREE.Node<'vec4'>,
  { clampToCell = true }: SampleAtlasCellOpts = {}
) => {
  const rect = toRectNode(slot, cell);
  const min = rect.xy as unknown as THREE.Node<'vec2'>;
  const max = rect.zw as unknown as THREE.Node<'vec2'>;
  let cellUv = mix(min, max, uvNode) as unknown as THREE.Node<'vec2'>;
  if (clampToCell) {
    const { width, height } = getLevel0Size(slot);
    const half = vec2(0.5 / width, 0.5 / height);
    cellUv = clamp(cellUv, min.add(half), max.sub(half)) as unknown as THREE.Node<'vec2'>;
  }
  return texture(slot, cellUv as unknown as TextureUV);
};

/** Where a geometry's UVs were remapped to, on its `userData.atlasCell`. */
export type GeometryAtlasCell = {
  atlas: string;
  cell: string;
  /** The UV attribute that was rewritten */
  attribute: string;
  /** The cell's content rect the UVs were mapped into */
  uv: AtlasCellRect;
};

export type RemapUVsToAtlasCellOpts = {
  /** The UV attribute to rewrite. Default `'uv'`. */
  attribute?: string;
  /** Rewrites the given geometry's attribute, in its own array type, instead of a registered
   * clone. Default false. */
  inPlace?: boolean;
  /** The clone's registry id. Default `<geometryId>@<atlasId>:<cellId>`: a second call for the
   * same geometry and cell returns the registered clone. */
  id?: string;
};

/** Why remapped UVs can't be written into this attribute in place, or how much they lose there. */
const checkInPlaceAttribute = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
  const array = attr.array as ArrayLike<number> & { BYTES_PER_ELEMENT: number };
  const isFloat = array instanceof Float32Array || array instanceof Float64Array;
  const isHalf = (attr as { isFloat16BufferAttribute?: boolean }).isFloat16BufferAttribute;
  if (!isFloat && !isHalf && !attr.normalized) {
    return { error: 'stores them as unnormalized integers, which a cell rect cannot be' };
  }
  if (isHalf) return { warning: 'stores them as half floats (11 bits)' };
  if (attr.normalized && array.BYTES_PER_ELEMENT === 1) {
    return { warning: 'stores them in 8 bits (1/255 of the atlas)' };
  }
  return {};
};

/**
 * Rewrites a geometry's UVs from 0..1 into an atlas cell's content rect, so a material samples the
 * atlas slot with plain `texture(slot)` (eg. as its `map`). For a geometry already UV'd into atlas
 * space (Blender) nothing is needed; to keep the geometry as it is, sample with
 * {@link sampleAtlasCell} instead.
 *
 * By default it returns a registered deep clone with float UVs: three r186 frees a geometry's GPU
 * buffers when it is disposed, so a clone sharing attributes with its source would lose them when
 * either goes. `inPlace` rewrites the given geometry's attribute instead (and flags it for upload).
 *
 * UVs outside 0..1 reach past the cell's content into its padding (its edge extended), then its
 * neighbours. A cell can't tile: UVs reaching more than half the padding past it (the other half is
 * a bilinear tap's at the last level the layout protects) are remapped with a warning. Slightly
 * outside is fine (three's SphereGeometry offsets its poles' u by half a segment). A geometry whose
 * UVs were remapped already throws (remap its source).
 * @param geometry a geometry or a registered geometry's id
 * @param atlas the atlas id (`*.textureAtlas.json`), a slot's id or a slot texture; one of its slots
 * must be loaded (the cell table comes from it)
 * @param cellId the cell's id in the atlas JSON
 * @param opts {@link RemapUVsToAtlasCellOpts}
 * @returns the registered clone, or the given geometry with `inPlace`. Either has a
 * {@link GeometryAtlasCell} on its `userData.atlasCell`.
 */
export const remapUVsToAtlasCell = (
  geometry: THREE.BufferGeometry | string,
  atlas: string | THREE.Texture,
  cellId: string,
  { attribute = 'uv', inPlace = false, id }: RemapUVsToAtlasCellOpts = {}
) => {
  const source =
    typeof geometry === 'string' ? getGeometryRegistry()[geometry]?.resource : geometry;
  if (!source) throw new Error(`remapUVsToAtlasCell: no geometry "${geometry as string}".`);
  const geometryId = (source.userData.id as string | undefined) ?? source.uuid;

  const info = findAtlasInfo(atlas);
  const atlasName = typeof atlas === 'string' ? atlas : atlas.userData.id ?? atlas.uuid;
  if (!info) {
    throw new Error(
      `remapUVsToAtlasCell: "${atlasName}" is no loaded atlas: load one of its slots first (list the atlas in the scene's textures).`
    );
  }
  const cell = info.cells[cellId];
  if (!cell) {
    throw new Error(
      `remapUVsToAtlasCell: atlas "${info.id}" has no cell "${cellId}" (cells: ${Object.keys(info.cells).join(', ')}).`
    );
  }
  const remapped = source.userData.atlasCell as GeometryAtlasCell | undefined;
  if (remapped) {
    throw new Error(
      `remapUVsToAtlasCell: geometry "${geometryId}" is already remapped into atlas "${remapped.atlas}" cell "${remapped.cell}": remap its source instead.`
    );
  }
  const attr = source.getAttribute(attribute);
  if (!attr) {
    throw new Error(`remapUVsToAtlasCell: geometry "${geometryId}" has no "${attribute}".`);
  }
  if (attr.itemSize !== 2) {
    throw new Error(
      `remapUVsToAtlasCell: "${attribute}" of geometry "${geometryId}" has ${attr.itemSize} components, not 2.`
    );
  }

  const cloneId = id ?? `${geometryId}@${info.id}:${cellId}`;
  if (!inPlace) {
    const registered = getGeometryRegistry()[cloneId]?.resource;
    if (registered) {
      retagAssetOwner(registered);
      return registered;
    }
  }

  const inPlaceCheck = inPlace ? checkInPlaceAttribute(attr) : {};
  if (inPlaceCheck.error) {
    throw new Error(
      `remapUVsToAtlasCell: "${attribute}" of geometry "${geometryId}" ${inPlaceCheck.error}: remap a clone (no inPlace).`
    );
  }

  const [u0, v0, u1, v1] = cell.uv;
  const [cellW, cellH] = cell.size;
  // How far past the content a UV may reach, in the layout's px
  const allowedReach = info.padding / 2;
  const count = attr.count;
  const out = inPlace ? null : new Float32Array(count * 2);
  let tooFar = 0;
  let maxReach = 0;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < count; i++) {
    const u = attr.getX(i);
    const v = attr.getY(i);
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    const reach = Math.max(-u * cellW, (u - 1) * cellW, -v * cellH, (v - 1) * cellH);
    if (reach > allowedReach) tooFar++;
    if (reach > maxReach) maxReach = reach;
    const x = u0 + u * (u1 - u0);
    const y = v0 + v * (v1 - v0);
    if (out) {
      out[i * 2] = x;
      out[i * 2 + 1] = y;
    } else {
      attr.setXY(i, x, y);
    }
  }
  if (tooFar) {
    lwarn(
      `remapUVsToAtlasCell: ${tooFar} of ${count} UVs of geometry "${geometryId}" reach up to ${Math.round(maxReach)} px past cell "${cellId}" of atlas "${info.id}" (u ${minU.toFixed(3)}..${maxU.toFixed(3)}, v ${minV.toFixed(3)}..${maxV.toFixed(3)}), more than half its ${info.padding} px of padding: remapped, they sample its neighbours or the fill. A cell can't tile: keep the UVs in 0..1, or use a texture array layer.`
    );
  }
  if (inPlaceCheck.warning) {
    lwarn(
      `remapUVsToAtlasCell: "${attribute}" of geometry "${geometryId}" ${inPlaceCheck.warning}, too coarse for a cell rect in a ${info.size[0]}×${info.size[1]} atlas: remap a clone (float UVs) instead.`
    );
  }

  const atlasCell: GeometryAtlasCell = {
    atlas: info.id,
    cell: cellId,
    attribute,
    uv: [...cell.uv],
  };
  if (inPlace) {
    attr.needsUpdate = true;
    source.userData.atlasCell = atlasCell;
    return source;
  }

  const clone = source.clone();
  // copy() shares the source's userData object: the clone gets its own, without the source's
  // registry and LOD fields
  const userData: Record<string, unknown> = { ...source.userData, atlasCell };
  for (const key of ['id', 'props', 'debugData', 'lodOf', 'lodLevel']) delete userData[key];
  clone.userData = userData;
  const uvAttr = new THREE.BufferAttribute(out!, 2);
  uvAttr.name = attr.name;
  clone.setAttribute(attribute, uvAttr);
  const sourceName = getGeometryRegistry()[geometryId]?.debugData?.name || geometryId;
  return saveBufferGeometry(clone, {
    id: cloneId,
    debugData: {
      name: `${sourceName} @ ${info.id}:${cellId}`,
      description: `"${geometryId}" with its ${attribute} remapped into cell "${cellId}" of atlas "${info.id}"`,
    },
  });
};
