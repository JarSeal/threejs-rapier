// Moves a glTF texture across a thread boundary: its ImageBitmap is transferred, its state is
// plain data. Used on both sides of the assets worker hop (worker: serialize, main thread:
// rebuild), so keep it free of imports that touch `window`/`document`.
import * as THREE from 'three/webgpu';

type Vector2Like = { x: number; y: number };

/** A texture's state (the fields Texture.copy() copies, minus source/mipmaps/render target), with
 * its image as an index into the message's transferred `images`. */
export type TransferableTexture = {
  imageIndex: number;
  name: string;
  mapping: THREE.AnyMapping;
  channel: number;
  wrapS: THREE.Wrapping;
  wrapT: THREE.Wrapping;
  magFilter: THREE.MagnificationTextureFilter;
  minFilter: THREE.MinificationTextureFilter;
  anisotropy: number;
  format: THREE.AnyPixelFormat;
  internalFormat: THREE.PixelFormatGPU | null;
  type: THREE.TextureDataType;
  offset: Vector2Like;
  repeat: Vector2Like;
  center: Vector2Like;
  rotation: number;
  matrixAutoUpdate: boolean;
  matrix: number[];
  generateMipmaps: boolean;
  premultiplyAlpha: boolean;
  flipY: boolean;
  unpackAlignment: number;
  colorSpace: string;
  userData: Record<string, unknown>;
};

const toVector2Like = (v: THREE.Vector2): Vector2Like => ({ x: v.x, y: v.y });

/**
 * Describes a texture as structured-clone-safe data. Its ImageBitmap is added to `images` once
 * per THREE.TextureSource (GLTFLoader's clones for another UV channel or transform share their
 * source), for the postMessage transfer list. Throws for a texture whose image isn't an ImageBitmap.
 * @param texture the texture to describe
 * @param images collects the ImageBitmaps to transfer
 * @param imageIndexBySource the image index per already collected source
 */
export const serializeTexture = (
  texture: THREE.Texture,
  images: ImageBitmap[],
  imageIndexBySource: Map<THREE.TextureSource<unknown>, number>
): TransferableTexture => {
  let imageIndex = imageIndexBySource.get(texture.source);
  if (imageIndex === undefined) {
    const image = texture.source.data as unknown;
    if (typeof ImageBitmap === 'undefined' || !(image instanceof ImageBitmap)) {
      throw new Error(
        `Texture "${texture.name}" has no ImageBitmap image, it can't be transferred.`
      );
    }
    imageIndex = images.push(image) - 1;
    imageIndexBySource.set(texture.source, imageIndex);
  }
  return {
    imageIndex,
    name: texture.name,
    mapping: texture.mapping,
    channel: texture.channel,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
    magFilter: texture.magFilter,
    minFilter: texture.minFilter,
    anisotropy: texture.anisotropy,
    format: texture.format,
    internalFormat: texture.internalFormat,
    type: texture.type,
    offset: toVector2Like(texture.offset),
    repeat: toVector2Like(texture.repeat),
    center: toVector2Like(texture.center),
    rotation: texture.rotation,
    matrixAutoUpdate: texture.matrixAutoUpdate,
    matrix: texture.matrix.toArray(),
    generateMipmaps: texture.generateMipmaps,
    premultiplyAlpha: texture.premultiplyAlpha,
    flipY: texture.flipY,
    unpackAlignment: texture.unpackAlignment,
    colorSpace: texture.colorSpace,
    userData: texture.userData,
  };
};

/**
 * Rebuilds a texture described by {@link serializeTexture} around a source holding its
 * (transferred) ImageBitmap. Textures sharing an image must be given the same source.
 * @param data {@link TransferableTexture}
 * @param source the THREE.TextureSource for `data.imageIndex`
 */
export const deserializeTexture = (
  data: TransferableTexture,
  source: THREE.TextureSource<unknown>
) => {
  const texture = new THREE.Texture();
  texture.source = source;
  texture.name = data.name;
  texture.mapping = data.mapping;
  texture.channel = data.channel;
  texture.wrapS = data.wrapS;
  texture.wrapT = data.wrapT;
  texture.magFilter = data.magFilter;
  texture.minFilter = data.minFilter;
  texture.anisotropy = data.anisotropy;
  texture.format = data.format;
  texture.internalFormat = data.internalFormat;
  texture.type = data.type;
  texture.offset.set(data.offset.x, data.offset.y);
  texture.repeat.set(data.repeat.x, data.repeat.y);
  texture.center.set(data.center.x, data.center.y);
  texture.rotation = data.rotation;
  texture.matrixAutoUpdate = data.matrixAutoUpdate;
  texture.matrix.fromArray(data.matrix);
  texture.generateMipmaps = data.generateMipmaps;
  texture.premultiplyAlpha = data.premultiplyAlpha;
  texture.flipY = data.flipY;
  texture.unpackAlignment = data.unpackAlignment;
  texture.colorSpace = data.colorSpace;
  texture.userData = data.userData;
  texture.needsUpdate = true;
  return texture;
};
