import * as THREE from 'three/webgpu';
import { retagAssetOwner } from './Assets/AssetOwners';
import { getRenderer } from './Renderer';
import { getGeneratedAppData } from './Scene';
import {
  getTexture,
  loadTextureFileAsync,
  resolveTextureUrl,
  saveTexture,
  setTextureOpts,
  type TexOpts,
  type TextureProps,
} from './Texture';

/**
 * Runtime texture arrays (p299 D1): many same-sized textures as the layers of one array texture,
 * one binding in a shader (`texture(array, uv).depth(layer)`). Each layer wraps and mips on its
 * own, so tiling textures work, unlike in an atlas.
 *
 * KTX2 members are concatenated level by level into a `CompressedArrayTexture`, uploaded once.
 * Uncompressed members (a source image, while the asset pipeline has no output for it or the
 * "Load source files" override is on) make a `DataArrayTexture` with GPU mipmaps.
 */

export type TextureArray = THREE.CompressedArrayTexture | THREE.DataArrayTexture;

/**
 * A layer's texture: a registered texture's id (used as it is, and kept), a texture asset's id
 * (`*.texture.json`) or the props of a file to load. Assets and files are loaded for the array
 * alone: never registered nor uploaded, and dropped once their data is in the array.
 */
export type TextureArrayMember = string | TextureProps;

export type BuildTextureArrayProps = {
  /** Registry id. Default: derived from the members, colorSpace and texOpts (`arr:<hash>`), so
   * two builds of the same array share one, or a unique id for a swappable array. */
  id?: string;
  /** Layer `i` is `members[i]`. All of them must have the same size, mip count and format. */
  members: TextureArrayMember[];
  /** Default: the members' own, which must agree (a KTX2 file carries its colour space). */
  colorSpace?: THREE.ColorSpace;
  /** The array's sampler state. Default: the first member's (wrap, filters, anisotropy). */
  texOpts?: TexOpts;
  /** Keeps the array's CPU copy of its data, for {@link setTextureArrayLayer}. Without it the copy
   * is dropped once the array is on the GPU. */
  swappable?: boolean;
  isPersistent?: boolean;
  debugData?: { name?: string; description?: string };
};

/** What an array was built from, on its `userData.textureArray`. */
export type TextureArrayInfo = {
  /** The member per layer (an id, or a file member's id or file name) */
  members: string[];
  kind: 'COMPRESSED' | 'UNCOMPRESSED';
  width: number;
  height: number;
  /** Mip levels in the data (an uncompressed array's mips are generated on the GPU: 1) */
  levels: number;
  /** One layer's bytes, every level */
  layerBytes: number;
  swappable: boolean;
  /** The CPU copy was dropped after the upload (not swappable) */
  cpuDataReleased: boolean;
};

type MipLevel = { data: Uint8Array | Uint16Array; width: number; height: number };

type LoadedMember = {
  key: string;
  texture: THREE.Texture;
  /** A registered texture: the array reads it and leaves it alone */
  isBorrowed: boolean;
};

/** The layout every layer of an array shares, from its first member. */
type LayerSpec = {
  kind: TextureArrayInfo['kind'];
  width: number;
  height: number;
  levels: number;
  format: THREE.AnyPixelFormat;
  type: THREE.TextureDataType;
  colorSpace: string;
};

const EMPTY_DATA = new Uint8Array(0);

const pendingBuilds = new Map<string, Promise<TextureArray>>();
/** Layer swaps run in call order per array, so the last call wins. */
const swapQueues = new WeakMap<TextureArray, Promise<void>>();

/** FNV-1a, 32 bits, base 36: the derived ids only need to tell member lists apart. */
const hashString = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const getMemberKey = (member: TextureArrayMember) =>
  typeof member === 'string'
    ? member
    : member.id || (Array.isArray(member.fileName) ? '' : member.fileName) || member.__url || '';

const isArrayTexture = (texture: THREE.Texture) =>
  Boolean(
    (texture as THREE.CompressedArrayTexture).isCompressedArrayTexture ||
      (texture as THREE.DataArrayTexture).isDataArrayTexture
  );

const loadMember = async (member: TextureArrayMember): Promise<LoadedMember> => {
  const key = getMemberKey(member);
  if (!key) throw new Error('A texture array member has no id, file name or URL.');
  const registered = typeof member === 'string' || member.id ? getTexture(key) : undefined;
  if (registered) return { key, texture: registered, isBorrowed: true };

  // Production data has only the scenes, no texture registry
  const props =
    typeof member === 'string'
      ? (
          getGeneratedAppData() as unknown as {
            textures?: Record<string, TextureProps | undefined>;
          }
        ).textures?.[member]
      : member;
  if (!props) {
    throw new Error(
      `Texture array member "${key}" is neither a registered texture nor a texture asset (*.texture.json).`
    );
  }
  if (Array.isArray(props.fileName)) {
    throw new Error(`Texture array member "${key}" is a cube texture.`);
  }
  const url = resolveTextureUrl({ ...props, fileName: props.fileName });
  const { texture } = await loadTextureFileAsync(url);
  // As loadTextureAsync would: the first member's sampler state is the array's default
  setTextureOpts(texture, props.texOpts);
  return { key, texture, isBorrowed: false };
};

/** Frees what a member loaded for the array alone holds (a worker-decoded ImageBitmap). */
const releaseMember = ({ texture, isBorrowed }: LoadedMember) => {
  if (isBorrowed) return;
  if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) {
    texture.image.close();
  }
  texture.dispose();
};

type DrawableImage = Exclude<CanvasImageSource, VideoFrame | SVGImageElement>;

const getLayerSpec = (member: LoadedMember): LayerSpec => {
  const { texture } = member;
  if (isArrayTexture(texture)) {
    throw new Error(`Texture array member "${member.key}" is an array texture itself.`);
  }
  if ((texture as THREE.CompressedTexture).isCompressedTexture) {
    const mips = texture.mipmaps as unknown as MipLevel[];
    const { width, height } = texture.image as { width: number; height: number };
    return {
      kind: 'COMPRESSED',
      width,
      height,
      levels: mips.length,
      format: texture.format,
      type: texture.type,
      colorSpace: texture.colorSpace,
    };
  }
  const image = texture.image as DrawableImage | null;
  const width = (image as { width?: number } | null)?.width;
  const height = (image as { height?: number } | null)?.height;
  if (!image || (texture as THREE.DataTexture).isDataTexture || !width || !height) {
    throw new Error(
      `Texture array member "${member.key}" is neither a KTX2 texture nor an image texture.`
    );
  }
  return {
    kind: 'UNCOMPRESSED',
    width,
    height,
    levels: 1,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: texture.colorSpace,
  };
};

/** Throws when a member doesn't fit the array's layout, naming the member and the value. */
const checkLayerSpec = (
  arrayId: string,
  spec: LayerSpec,
  specOf: string,
  member: LoadedMember,
  layer: number,
  checkColorSpace: boolean
) => {
  const own = getLayerSpec(member);
  const prefix = `Texture array "${arrayId}": member "${member.key}" (layer ${layer})`;
  if (own.kind !== spec.kind) {
    const describe = (kind: LayerSpec['kind']) =>
      kind === 'COMPRESSED' ? 'a KTX2 texture' : 'an uncompressed image';
    throw new Error(
      `${prefix} is ${describe(own.kind)}, ${specOf} is ${describe(spec.kind)}. A texture asset without asset pipeline output loads its source image: run \`yarn assets\`.`
    );
  }
  if (own.width !== spec.width || own.height !== spec.height) {
    throw new Error(
      `${prefix} is ${own.width} × ${own.height}, ${specOf} is ${spec.width} × ${spec.height}.`
    );
  }
  if (own.levels !== spec.levels) {
    throw new Error(`${prefix} has ${own.levels} mip levels, ${specOf} has ${spec.levels}.`);
  }
  if (own.format !== spec.format || own.type !== spec.type) {
    throw new Error(
      `${prefix} transcodes to format ${own.format}, ${specOf} to ${spec.format}: encode every member of an array with the same codec.`
    );
  }
  if (checkColorSpace && own.colorSpace !== spec.colorSpace) {
    throw new Error(
      `${prefix} has colour space "${own.colorSpace}", ${specOf} "${spec.colorSpace}": encode them alike, or give the array a colorSpace.`
    );
  }
};

/** Draws an image member into one layer of RGBA8 data, top row first (its flip applied). */
const drawLayer = (
  context: OffscreenCanvasRenderingContext2D,
  texture: THREE.Texture,
  target: Uint8Array,
  layer: number
) => {
  const { width, height } = context.canvas;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  // An uploaded texture with flipY shows its image upside down; the array's data is stored as
  // it is sampled (a worker-decoded bitmap has the flip baked in, flipY false)
  if (texture.flipY) context.setTransform(1, 0, 0, -1, 0, height);
  context.drawImage(texture.image as DrawableImage, 0, 0);
  target.set(context.getImageData(0, 0, width, height).data, layer * width * height * 4);
};

const create2DContext = (width: number, height: number) => {
  const context = new OffscreenCanvas(width, height).getContext('2d', {
    willReadFrequently: true,
  });
  if (!context) throw new Error('Texture arrays need an OffscreenCanvas 2D context.');
  return context;
};

const assembleCompressed = (members: LoadedMember[], spec: LayerSpec) => {
  const first = members[0].texture;
  const mipmaps = (first.mipmaps as unknown as MipLevel[]).map(({ data, width, height }, level) => {
    const out = new (data.constructor as Uint8ArrayConstructor)(data.length * members.length);
    for (let i = 0; i < members.length; i++) {
      out.set((members[i].texture.mipmaps as unknown as MipLevel[])[level].data, i * data.length);
    }
    return { data: out, width, height };
  });
  const array = new THREE.CompressedArrayTexture(
    mipmaps as unknown as ImageData[],
    spec.width,
    spec.height,
    members.length,
    spec.format as THREE.CompressedPixelFormat,
    spec.type
  );
  array.premultiplyAlpha = first.premultiplyAlpha;
  array.generateMipmaps = false;
  return array;
};

const assembleUncompressed = (members: LoadedMember[], spec: LayerSpec) => {
  const data = new Uint8Array(spec.width * spec.height * 4 * members.length);
  const context = create2DContext(spec.width, spec.height);
  members.forEach((member, i) => drawLayer(context, member.texture, data, i));
  const array = new THREE.DataArrayTexture(data, spec.width, spec.height, members.length);
  array.generateMipmaps = true;
  array.minFilter = THREE.LinearMipmapLinearFilter;
  array.magFilter = THREE.LinearFilter;
  array.flipY = false;
  return array;
};

const getLayerBytes = (array: TextureArray, kind: LayerSpec['kind'], layers: number) =>
  kind === 'COMPRESSED'
    ? (array.mipmaps as unknown as MipLevel[]).reduce((sum, mip) => sum + mip.data.byteLength, 0) /
      layers
    : array.image.width * array.image.height * 4;

/** Drops the array's CPU copy once it is on the GPU: a non-swappable array never reads it again. */
const releaseCpuData = (array: TextureArray) => {
  const info = array.userData.textureArray as TextureArrayInfo;
  if (info.kind === 'COMPRESSED') {
    array.mipmaps = (array.mipmaps as unknown as MipLevel[]).map(({ width, height }) => ({
      data: EMPTY_DATA,
      width,
      height,
    })) as unknown as THREE.CompressedTextureMipmap[];
  } else {
    (array.image as { data: Uint8Array }).data = EMPTY_DATA;
  }
  info.cpuDataReleased = true;
};

const deriveId = (props: BuildTextureArrayProps, keys: string[]) =>
  props.swappable
    ? `arr:${THREE.MathUtils.generateUUID()}`
    : `arr:${hashString(JSON.stringify([keys, props.colorSpace ?? null, props.texOpts ?? null]))}`;

/** Returns the registered array with the id, re-tagged to the current scene, or undefined. */
const getRegisteredArray = (id: string) => {
  const existing = getTexture(id);
  if (!existing) return undefined;
  if (!isArrayTexture(existing)) {
    throw new Error(`Texture "${id}" is registered, and it isn't a texture array.`);
  }
  retagAssetOwner(existing);
  return existing as TextureArray;
};

const build = async (id: string, props: BuildTextureArrayProps, keys: string[]) => {
  const members = await Promise.all(props.members.map(loadMember));
  try {
    const spec = getLayerSpec(members[0]);
    if (props.colorSpace) spec.colorSpace = props.colorSpace;
    for (let i = 1; i < members.length; i++) {
      checkLayerSpec(id, spec, `layer 0 ("${keys[0]}")`, members[i], i, !props.colorSpace);
    }

    const array =
      spec.kind === 'COMPRESSED'
        ? assembleCompressed(members, spec)
        : assembleUncompressed(members, spec);
    const first = members[0].texture;
    array.wrapS = first.wrapS;
    array.wrapT = first.wrapT;
    array.anisotropy = first.anisotropy;
    if (spec.kind === 'COMPRESSED') {
      array.minFilter = first.minFilter;
      array.magFilter = first.magFilter;
    }
    array.colorSpace = spec.colorSpace;
    const info: TextureArrayInfo = {
      members: keys,
      kind: spec.kind,
      width: spec.width,
      height: spec.height,
      levels: spec.levels,
      layerBytes: getLayerBytes(array, spec.kind, members.length),
      swappable: Boolean(props.swappable),
      cpuDataReleased: false,
    };
    setTextureOpts(array, props.texOpts, { textureArray: info }, props.debugData);
    array.needsUpdate = true;

    const saved = saveTexture(array, id, props.isPersistent);
    if (saved !== array) {
      array.dispose();
      return saved as TextureArray;
    }
    if (!props.swappable) {
      array.onUpdate = () => {
        array.onUpdate = null;
        // After the upload call returns: three sizes the texture from its data after onUpdate
        queueMicrotask(() => releaseCpuData(array));
      };
    }
    // Upload now: the load pays for it, not the first frame that draws the array
    const renderer = getRenderer();
    if (renderer?.hasInitialized()) renderer.initTexture(array);
    return array;
  } finally {
    members.forEach(releaseMember);
  }
};

/**
 * Builds an array texture from same-sized textures, layer `i` from `members[i]`, and registers
 * it. Throws when a member can't be loaded or doesn't match the first one (size, mip count,
 * transcoded format, colour space), naming the member and the value: encode every member of an
 * array with the same codec and size.
 *
 * Arrays are registered textures: owned by the scene that built them (a build of a registered id
 * re-tags it), released with it unless a material holds them, deleted with deleteTexture. The
 * array holds a copy of its members' data, so the members' own lifecycles don't touch it.
 * @param props {@link BuildTextureArrayProps}
 */
export const buildTextureArray = async (props: BuildTextureArrayProps): Promise<TextureArray> => {
  if (!props.members.length) throw new Error('A texture array needs at least one member.');
  const keys = props.members.map(getMemberKey);
  const id = props.id || deriveId(props, keys);
  const registered = getRegisteredArray(id);
  if (registered) return registered;

  let pending = pendingBuilds.get(id);
  if (!pending) {
    pending = build(id, props, keys).finally(() => pendingBuilds.delete(id));
    pendingBuilds.set(id, pending);
  }
  return pending;
};

/** The registered array texture with the id, or undefined. */
export const getTextureArray = (id: string) => {
  const texture = getTexture(id);
  return texture && isArrayTexture(texture) ? (texture as TextureArray) : undefined;
};

/** What an array was built from (see {@link TextureArrayInfo}), or undefined for other textures. */
export const getTextureArrayInfo = (texture: THREE.Texture) =>
  texture.userData.textureArray as TextureArrayInfo | undefined;

const swapLayer = async (array: TextureArray, layer: number, member: TextureArrayMember) => {
  const info = getTextureArrayInfo(array)!;
  const loaded = await loadMember(member);
  try {
    const spec: LayerSpec = {
      kind: info.kind,
      width: info.width,
      height: info.height,
      levels: info.levels,
      format: array.format,
      type: array.type,
      colorSpace: array.colorSpace,
    };
    // A KTX2 member's colour space is in its file; an image member takes the array's
    checkLayerSpec(array.userData.id, spec, 'the array', loaded, layer, false);
    if (info.kind === 'COMPRESSED') {
      const memberMips = loaded.texture.mipmaps as unknown as MipLevel[];
      (array.mipmaps as unknown as MipLevel[]).forEach((mip, level) => {
        mip.data.set(memberMips[level].data, layer * memberMips[level].data.length);
      });
    } else {
      const context = create2DContext(info.width, info.height);
      drawLayer(context, loaded.texture, (array.image as { data: Uint8Array }).data, layer);
    }
    array.addLayerUpdate(layer);
    array.needsUpdate = true;
    info.members[layer] = loaded.key;
  } finally {
    releaseMember(loaded);
  }
};

/**
 * Replaces one layer of a swappable array (built with `swappable: true`) with another member,
 * re-uploading that layer only. The member must match the array's size, mip count and format.
 * Swaps of one array run in call order.
 * @param id the array's registry id
 * @param layer the layer index
 * @param member the new layer's {@link TextureArrayMember}
 */
export const setTextureArrayLayer = (id: string, layer: number, member: TextureArrayMember) => {
  const array = getTextureArray(id);
  const info = array && getTextureArrayInfo(array);
  if (!array || !info) throw new Error(`No texture array "${id}" is registered.`);
  if (!info.swappable) {
    throw new Error(
      `Texture array "${id}" isn't swappable: build it with \`swappable: true\` to replace its layers.`
    );
  }
  if (!Number.isInteger(layer) || layer < 0 || layer >= info.members.length) {
    throw new Error(`Texture array "${id}" has layers 0-${info.members.length - 1}, not ${layer}.`);
  }
  const queued = (swapQueues.get(array) ?? Promise.resolve())
    .catch(() => {})
    .then(() => swapLayer(array, layer, member));
  swapQueues.set(array, queued);
  return queued;
};
