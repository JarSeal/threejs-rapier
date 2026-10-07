import type * as THREE from 'three/webgpu';
import { clamp, mix, texture, vec2, vec4 } from 'three/tsl';
import type { TextureAtlasCellInfo, TextureAtlasSlotInfo } from '../schemas/textureAtlasSchema';
import { getTexture, getTextureRegistry } from './Texture';

/**
 * 2D texture atlases (p299 D3): cells of any size packed into one layout by the asset pipeline
 * (`*.textureAtlas.json`), one KTX2 output per map slot. At runtime each slot is an ordinary
 * registered texture, id `<atlasId>.<slot>`, loaded by loadTextureAsync from its output, with the
 * cell table on its `userData.textureAtlas` ({@link getTextureAtlasInfo}). A scene lists the atlas
 * id in its `textures` for every slot, or a slot's id for that one.
 *
 * The mip chain stops at the last level the layout keeps apart (`levels`), so a cell sampled at
 * any level the texture has never reads its neighbour.
 */

/** A slot texture's cell table and layout, on its `userData.textureAtlas`. */
export type TextureAtlasInfo = TextureAtlasSlotInfo & {
  /** The loaded file's size: the layout's (`size`), halved once per top level its maxSize
   * dropped */
  width: number;
  height: number;
  /** Mip levels in the file: `levels` less the top levels its maxSize dropped, or 1 with
   * `mipmaps: false` */
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
