import type * as THREE from 'three/webgpu';
import type { TextureAtlasSlotInfo } from '../schemas/textureAtlasSchema';

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

/** A slot texture's cell table and layout (see {@link TextureAtlasInfo}), or undefined for other
 * textures. */
export const getTextureAtlasInfo = (texture: THREE.Texture) =>
  texture.userData.textureAtlas as TextureAtlasInfo | undefined;
