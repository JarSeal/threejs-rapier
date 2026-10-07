import * as THREE from 'three/webgpu';
import type { TextureArrayInfo } from '../TextureArray';

/** Pure helpers for the Assets debugger tab (_dbg__Assets.ts): counts, sizes and readable names. */

/** Max index/vertex entries for the on-demand unique edge count (it builds a Set of edge keys). */
export const UNIQUE_EDGES_MAX_ENTRIES = 3_000_000;

export const formatBytes = (bytes?: number) => {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
};

export const formatNumber = (n?: number) => (n === undefined ? '—' : n.toLocaleString('en-US'));

// --- Geometry ---

export const getVertexCount = (geometry: THREE.BufferGeometry) =>
  geometry.getAttribute('position')?.count ?? 0;

/** Triangles drawn (respects the draw range; non-indexed geometry = every 3 vertices). */
export const getTriangleCount = (geometry: THREE.BufferGeometry) => {
  const count = geometry.index ? geometry.index.count : getVertexCount(geometry);
  const drawCount = Number.isFinite(geometry.drawRange.count)
    ? Math.min(geometry.drawRange.count, count)
    : count;
  return Math.floor(drawCount / 3);
};

/** Bytes of all vertex attribute (+ morph attribute) and index buffers, ie. roughly what the
 * geometry takes in VRAM once uploaded. Interleaved buffers are counted once. */
export const getGeometryByteSize = (geometry: THREE.BufferGeometry) => {
  const counted = new Set<ArrayBufferLike | object>();
  let bytes = 0;
  const add = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const array =
      'isInterleavedBufferAttribute' in attribute && attribute.isInterleavedBufferAttribute
        ? attribute.data.array
        : (attribute as THREE.BufferAttribute).array;
    if (counted.has(array)) return;
    counted.add(array);
    bytes += array.byteLength;
  };
  for (const attribute of Object.values(geometry.attributes)) add(attribute);
  for (const list of Object.values(geometry.morphAttributes)) list.forEach(add);
  if (geometry.index) add(geometry.index);
  return bytes;
};

/** Unique edges of an indexed geometry (BufferGeometry has no edge topology; an edge shared by two
 * triangles counts once). Null when not indexed or over {@link UNIQUE_EDGES_MAX_ENTRIES}. */
export const computeUniqueEdgeCount = (geometry: THREE.BufferGeometry): number | null => {
  const index = geometry.index;
  if (!index || index.count > UNIQUE_EDGES_MAX_ENTRIES) return null;
  const edges = new Set<number>();
  // An edge packs into one number: u * vertexCount + v stays a safe integer for any real mesh
  const vertexCount = getVertexCount(geometry);
  for (let i = 0; i + 2 < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      edges.add(u < v ? u * vertexCount + v : v * vertexCount + u);
    }
  }
  return edges.size;
};

// --- Texture ---

const names = <T extends number>(entries: [T, string][]) => new Map<number, string>(entries);

const FORMAT_NAMES = names([
  [THREE.AlphaFormat, 'Alpha'],
  [THREE.RGBFormat, 'RGB'],
  [THREE.RGBAFormat, 'RGBA'],
  [THREE.DepthFormat, 'Depth'],
  [THREE.DepthStencilFormat, 'DepthStencil'],
  [THREE.RedFormat, 'Red'],
  [THREE.RedIntegerFormat, 'RedInteger'],
  [THREE.RGFormat, 'RG'],
  [THREE.RGIntegerFormat, 'RGInteger'],
  [THREE.RGBAIntegerFormat, 'RGBAInteger'],
]);

const TYPE_NAMES = names([
  [THREE.UnsignedByteType, 'UnsignedByte'],
  [THREE.ByteType, 'Byte'],
  [THREE.ShortType, 'Short'],
  [THREE.UnsignedShortType, 'UnsignedShort'],
  [THREE.IntType, 'Int'],
  [THREE.UnsignedIntType, 'UnsignedInt'],
  [THREE.FloatType, 'Float'],
  [THREE.HalfFloatType, 'HalfFloat'],
]);

const TYPE_BYTES = new Map<number, number>([
  [THREE.UnsignedByteType, 1],
  [THREE.ByteType, 1],
  [THREE.ShortType, 2],
  [THREE.UnsignedShortType, 2],
  [THREE.HalfFloatType, 2],
  [THREE.IntType, 4],
  [THREE.UnsignedIntType, 4],
  [THREE.FloatType, 4],
]);

const FORMAT_CHANNELS = new Map<number, number>([
  [THREE.AlphaFormat, 1],
  [THREE.RedFormat, 1],
  [THREE.RedIntegerFormat, 1],
  [THREE.RGFormat, 2],
  [THREE.RGIntegerFormat, 2],
  [THREE.RGBFormat, 3],
  [THREE.RGBAFormat, 4],
  [THREE.RGBAIntegerFormat, 4],
]);

const FILTER_NAMES = names([
  [THREE.NearestFilter, 'Nearest'],
  [THREE.NearestMipmapNearestFilter, 'NearestMipmapNearest'],
  [THREE.NearestMipmapLinearFilter, 'NearestMipmapLinear'],
  [THREE.LinearFilter, 'Linear'],
  [THREE.LinearMipmapNearestFilter, 'LinearMipmapNearest'],
  [THREE.LinearMipmapLinearFilter, 'LinearMipmapLinear'],
]);

const WRAP_NAMES = names([
  [THREE.RepeatWrapping, 'Repeat'],
  [THREE.ClampToEdgeWrapping, 'ClampToEdge'],
  [THREE.MirroredRepeatWrapping, 'MirroredRepeat'],
]);

const constName = (map: Map<number, string>, value: number) => map.get(value) ?? String(value);

/** Pixel dimensions of a texture's image (the first face of a cube texture). */
export const getTextureSize = (texture: THREE.Texture) => {
  const image = (Array.isArray(texture.image) ? texture.image[0] : texture.image) as
    | { width?: number; height?: number }
    | undefined;
  if (!image?.width || !image?.height) return null;
  return { width: image.width, height: image.height };
};

const isArrayTexture = (texture: THREE.Texture) =>
  Boolean(
    (texture as THREE.CompressedArrayTexture).isCompressedArrayTexture ||
      (texture as THREE.DataArrayTexture).isDataArrayTexture
  );

/** The layers of an array texture or the depth of a 3D texture (its image's depth), else 1. */
export const getTextureDepth = (texture: THREE.Texture) =>
  isArrayTexture(texture) || (texture as THREE.Data3DTexture).isData3DTexture
    ? (texture.image as { depth?: number } | null)?.depth ?? 1
    : 1;

type CompressedMips = { data?: ArrayBufferView }[] | undefined;

/**
 * A compressed texture's GPU memory: the bytes of every mip level it uploads, as transcoded (so
 * for the device's format, eg. BC7 or ETC2), every face of a cube and every layer of an array
 * (KTX2Loader concatenates a level's layers). Null for anything else, or when no level has data.
 */
export const getCompressedTextureByteSize = (texture: THREE.Texture) => {
  if (!('isCompressedTexture' in texture && texture.isCompressedTexture)) return null;
  // A CompressedCubeTexture keeps its levels per face, in its image
  const levelSets: CompressedMips[] = Array.isArray(texture.image)
    ? (texture.image as { mipmaps?: CompressedMips }[]).map((face) => face.mipmaps)
    : [texture.mipmaps as CompressedMips];
  let bytes = 0;
  for (const levels of levelSets) {
    for (const level of levels ?? []) bytes += level.data?.byteLength ?? 0;
  }
  return bytes || null;
};

/** Estimated GPU memory: width × height × bytes per pixel (× 6 faces for a cube texture, × its
 * layers or depth for an array or 3D texture), plus a third for the mipmap chain; a compressed
 * texture's uploaded bytes. Null for unknown formats. */
export const getTextureByteSize = (texture: THREE.Texture) => {
  if ('isCompressedTexture' in texture) {
    const array = texture.userData.textureArray as TextureArrayInfo | undefined;
    // A runtime array drops its CPU mip data after the upload (TextureArray.ts): from its layer
    // size, measured before that
    return (
      getCompressedTextureByteSize(texture) ??
      (array?.cpuDataReleased ? array.layerBytes * array.members.length : null)
    );
  }
  const size = getTextureSize(texture);
  const channels = FORMAT_CHANNELS.get(texture.format as number);
  const bytesPerChannel = TYPE_BYTES.get(texture.type);
  if (!size || !channels || !bytesPerChannel) return null;
  const faces = 'isCubeTexture' in texture && texture.isCubeTexture ? 6 : getTextureDepth(texture);
  const base = size.width * size.height * channels * bytesPerChannel * faces;
  return Math.round(texture.generateMipmaps ? (base * 4) / 3 : base);
};

/** Readable texture settings for the info window. */
export const describeTexture = (texture: THREE.Texture) => {
  const size = getTextureSize(texture);
  const isCube = 'isCubeTexture' in texture && texture.isCubeTexture;
  const isArray = isArrayTexture(texture);
  const is3D = (texture as THREE.Data3DTexture).isData3DTexture;
  const depth = getTextureDepth(texture);
  const isCompressed = 'isCompressedTexture' in texture && texture.isCompressedTexture;
  const levels = texture.mipmaps?.length ?? 0;
  return {
    kind: isCube
      ? 'Cube texture'
      : isArray
        ? isCompressed
          ? 'Compressed array texture'
          : 'Data array texture'
        : is3D
          ? '3D data texture'
          : 'isDataTexture' in texture && texture.isDataTexture
            ? 'Data texture'
            : isCompressed
              ? 'Compressed texture'
              : 'Texture',
    dimensions: size
      ? `${size.width} × ${size.height}${isCube ? ' (× 6 faces)' : isArray ? ` × ${depth} layer${depth === 1 ? '' : 's'}` : is3D ? ` × ${depth}` : ''}`
      : '—',
    colorSpace: texture.colorSpace || 'none (data)',
    format: constName(FORMAT_NAMES, texture.format as number),
    type: constName(TYPE_NAMES, texture.type),
    mipmaps: texture.generateMipmaps
      ? 'generated'
      : levels
        ? `provided, ${levels} level${levels === 1 ? '' : 's'}`
        : 'off',
    filtering: `min ${constName(FILTER_NAMES, texture.minFilter)}, mag ${constName(FILTER_NAMES, texture.magFilter)}`,
    wrap: `S ${constName(WRAP_NAMES, texture.wrapS)}, T ${constName(WRAP_NAMES, texture.wrapT)}`,
    anisotropy: String(texture.anisotropy),
    flipY: String(texture.flipY),
    gpuMemory: formatBytes(getTextureByteSize(texture) ?? undefined),
  };
};

/** The URL(s) a texture's image was loaded from, when the image element still knows it. */
export const getTextureImageSrc = (texture: THREE.Texture) => {
  const images = (Array.isArray(texture.image) ? texture.image : [texture.image]) as {
    src?: string;
    currentSrc?: string;
  }[];
  const srcs = images.map((image) => image?.currentSrc || image?.src).filter(Boolean) as string[];
  return srcs.length ? srcs : null;
};

/** File type from a file name/URL (its extension, upper-cased). */
export const getFileType = (fileName?: string) => {
  const extension = fileName?.split(/[?#]/)[0].split('.').pop();
  return extension && extension !== fileName ? extension.toUpperCase() : '—';
};
