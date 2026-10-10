// Moves a glTF texture across a thread boundary: its ImageBitmap (or a KTX2 texture's compressed
// mip levels) is transferred, its state is plain data. Used on both sides of the assets worker hop (worker: serialize, main thread:
// rebuild), so keep it free of imports that touch `window`/`document`.
import * as THREE from 'three/webgpu';

/** A texture's `offset`, `repeat` or `center` as plain data, for the worker hop. */
export type Vector2Like = { x: number; y: number };

/** A CompressedTexture's (eg. a KTX2 texture's) image: its size and its mip levels' block data. */
export type TransferableCompressedImage = {
  width: number;
  height: number;
  mipmaps: { data: Uint8Array; width: number; height: number }[];
};

/** A texture's image as it crosses the thread boundary. */
export type TransferableImage = ImageBitmap | TransferableCompressedImage;

/** A transferred image wrapped for the receiving side: the source textures sharing it share, plus
 * the mip levels a compressed texture keeps on itself (not on its source). */
export type TransferredSource = {
  source: THREE.TextureSource<unknown>;
  mipmaps?: TransferableCompressedImage['mipmaps'];
};

const isImageBitmap = (image: unknown): image is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;

/** Adds an image's transferable buffers (the bitmap itself, or its mip levels' buffers) to a
 * postMessage transfer list. */
export const collectImageTransferables = (
  image: TransferableImage,
  transfer: Set<Transferable>
) => {
  if (isImageBitmap(image)) transfer.add(image);
  else for (const mip of image.mipmaps) transfer.add(mip.data.buffer as ArrayBuffer);
};

/** Frees a transferred image nothing will use: closes an ImageBitmap (compressed data is left
 * to the garbage collector). */
export const releaseTransferableImage = (image: TransferableImage) => {
  if (isImageBitmap(image)) image.close();
};

/** Wraps transferred images for {@link deserializeTexture}, one per image. */
export const createTransferredSources = (images: TransferableImage[]): TransferredSource[] =>
  images.map((image) =>
    isImageBitmap(image)
      ? { source: new THREE.TextureSource(image) }
      : {
          source: new THREE.TextureSource({ width: image.width, height: image.height }),
          mipmaps: image.mipmaps,
        }
  );

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
 * Describes a texture as structured-clone-safe data. Its ImageBitmap (or, for a CompressedTexture
 * such as a KTX2 one, its mip levels) is added to `images` once per THREE.TextureSource
 * (GLTFLoader's clones for another UV channel or transform share their source), for the
 * postMessage transfer list. Throws for any other texture (eg. a compressed array or cube).
 * @param texture the texture to describe
 * @param images collects the ImageBitmaps to transfer
 * @param imageIndexBySource the image index per already collected source
 */
export const serializeTexture = (
  texture: THREE.Texture,
  images: TransferableImage[],
  imageIndexBySource: Map<THREE.TextureSource<unknown>, number>
): TransferableTexture => {
  let imageIndex = imageIndexBySource.get(texture.source);
  if (imageIndex === undefined) {
    const image = texture.source.data as unknown;
    if (isImageBitmap(image)) {
      imageIndex = images.push(image) - 1;
    } else if (
      (texture as THREE.CompressedTexture).isCompressedTexture &&
      !(texture as THREE.CompressedArrayTexture).isCompressedArrayTexture &&
      !(texture as THREE.CompressedCubeTexture).isCompressedCubeTexture
    ) {
      const { width, height } = image as { width: number; height: number };
      const mipmaps = (texture.mipmaps as TransferableCompressedImage['mipmaps']).map(
        ({ data, width, height }) => ({ data, width, height })
      );
      imageIndex = images.push({ width, height, mipmaps }) - 1;
    } else {
      throw new Error(
        `Texture "${texture.name}" has no ImageBitmap or compressed 2D image, it can't be transferred.`
      );
    }
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
 * (transferred) image: a Texture for an ImageBitmap, a CompressedTexture for compressed mip
 * levels. Textures sharing an image must be given the same source.
 * @param data {@link TransferableTexture}
 * @param transferred the {@link TransferredSource} for `data.imageIndex`
 * (from {@link createTransferredSources})
 */
export const deserializeTexture = (data: TransferableTexture, transferred: TransferredSource) => {
  const { source, mipmaps } = transferred;
  let texture: THREE.Texture;
  if (mipmaps) {
    const { width, height } = source.data as { width: number; height: number };
    texture = new THREE.CompressedTexture(
      mipmaps as unknown as ImageData[],
      width,
      height,
      data.format as THREE.CompressedPixelFormat,
      data.type
    );
  } else {
    texture = new THREE.Texture();
  }
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
