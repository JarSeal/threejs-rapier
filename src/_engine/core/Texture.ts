import * as THREE from 'three/webgpu';
import { lerror, lwarn } from '../utils/Logger';
import { HDRLoader } from 'three/examples/jsm/Addons.js';
import { isHDR, isKTX2 } from '../utils/helpers';
import {
  loadHDRTextureInWorker,
  loadTextureInWorker,
  recordAssetLoadReport,
  runAssetTask,
} from './Assets/AssetsAPI';
import type { AssetLoadReport } from './Assets/AssetsAPITypes';
import { recordAssetOwner, retagAssetOwner } from './Assets/AssetOwners';
import { resolveAssetUrl, type GeneratedAssetUrls } from './Assets/AssetUrl';
import { loadKTX2Texture } from './Import/KTX2';
import type { TextureArrayInfo } from './TextureArray';
import type { TextureAtlasInfo } from './TextureAtlas';
import type { TextureAtlasSlotInfo } from '../schemas/textureAtlasSchema';

export type TexOpts = {
  image?: TexImageSource | OffscreenCanvas;
  mapping?: THREE.Mapping;
  wrapS?: THREE.Wrapping;
  wrapT?: THREE.Wrapping;
  magFilter?: THREE.MagnificationTextureFilter;
  minFilter?: THREE.MinificationTextureFilter;
  format?: THREE.PixelFormat;
  type?: THREE.TextureDataType;
  anisotropy?: number;
  colorSpace?: THREE.ColorSpace;
};

export type TextureProps = {
  id?: string;
  fileName?: string | string[];
  path?: string;
  useHDRLoader?: boolean;
  texOpts?: TexOpts;
  throwOnError?: boolean;
  isPersistent?: boolean;
  userData?: Record<string, unknown>;
  debugData?: { name?: string; description?: string };
  /**
   * A texture array asset's (`*.textureArray.json`, p299 D2) layer names by layer index, baked in
   * by gatherAppData: its `__url` is one KTX2 array file, loaded as a `CompressedArrayTexture`.
   */
  __layers?: string[];
  /**
   * A texture atlas slot's (`*.textureAtlas.json`, p299 D3) layout and cell table, baked in by
   * gatherAppData: its `__url` is the slot's KTX2 output, with a mip chain cut where the layout
   * stops keeping the cells apart.
   */
  __atlas?: TextureAtlasSlotInfo;
} & GeneratedAssetUrls;

const textures: {
  [id: string]: {
    resource: THREE.Texture;
    count: number;
    persistent?: boolean;
  };
} = {};

/** Textures whose image is an ImageBitmap decoded in the assets worker: nothing else holds it,
 * so it is closed when the texture is disposed. (Not flagged in userData: setTextureOpts replaces
 * it, and a `.clone()` copies it while sharing the bitmap.) */
const workerBitmapTextures = new WeakSet<THREE.Texture>();

/** Disposes a registered texture, and closes its ImageBitmap if it was decoded in the assets
 * worker. */
const disposeTextureResource = (texture: THREE.Texture) => {
  texture.dispose();
  if (workerBitmapTextures.has(texture)) (texture.image as ImageBitmap).close();
};

/** Resolves a file name the way three's loaders do (`path + fileName`, then against the
 * document), so the worker fetches exactly the same URL. */
const toLoaderUrl = (fileName: string, path?: string) =>
  new URL((path || './') + fileName, document.baseURI).href;

/** A texture from an assets-worker ImageBitmap, in the state TextureLoader leaves a texture in,
 * except flipY: the flip is already baked into the bitmap. */
const createTextureFromWorkerBitmap = (bitmap: ImageBitmap) => {
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  texture.needsUpdate = true;
  workerBitmapTextures.add(texture);
  return texture;
};

/** A DataTexture from assets-worker HDR data, in the state HDRLoader.load() (DataTextureLoader
 * plus its own onLoad) leaves a HalfFloatType texture in. */
const createHDRTextureFromWorkerData = ({
  width,
  height,
  data,
}: {
  width: number;
  height: number;
  data: Uint16Array;
}) => {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.anisotropy = 1;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.generateMipmaps = false;
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
};

/** Registers a freshly loaded texture. If a parallel load registered the same id first, the
 * fresh one is disposed and the registered one returned, so only one instance is ever used. */
const saveLoadedTexture = <T extends THREE.Texture>(
  texture: T,
  id: string | undefined,
  isPersistent?: boolean
): T => {
  const saved = saveTexture(texture, id || texture.uuid, isPersistent);
  if (saved !== texture) disposeTextureResource(texture);
  return saved;
};

/** saveLoadedTexture() plus the load's report (with the file's URL) for the debug tooling, kept
 * only when this load's texture is the one registered. */
const saveAndReport = <T extends THREE.Texture>(
  texture: T,
  id: string | undefined,
  isPersistent: boolean | undefined,
  report: AssetLoadReport,
  sourceUrl: string
): T => {
  const saved = saveLoadedTexture(texture, id, isPersistent);
  if (saved === texture) {
    recordAssetLoadReport(`texture:${saved.userData.id}`, { ...report, sourceUrl });
  }
  return saved;
};

export const incTextureRef = (id: string) => {
  if (textures[id]) {
    textures[id].count++;
  }
};

export const decTextureRef = (id: string) => {
  const entry = textures[id];
  if (!entry) return;

  entry.count--;

  if (entry.count <= 0 && !entry.persistent) {
    disposeTextureResource(entry.resource);
    delete textures[id];
  }
};

export const setTexturePersistence = (id: string, state: boolean) => {
  const entry = textures[id];
  if (!entry) return;
  entry.persistent = state;

  if (!state && entry.count === 0) {
    disposeTextureResource(entry.resource);
    delete textures[id];
  }
};

/**
 * Applies texOpts to a texture and replaces its userData (with `userData`, or an empty object),
 * plus debugData's name and description.
 */
export const setTextureOpts = (
  texture: THREE.Texture | THREE.DataTexture | THREE.CubeTexture,
  texOpts?: TexOpts,
  userData?: Record<string, unknown>,
  debugData?: { name?: string; description?: string }
) => {
  if (texOpts?.mapping) texture.mapping = texOpts.mapping;
  if (texOpts?.wrapS) texture.wrapS = texOpts.wrapS;
  if (texOpts?.wrapT) texture.wrapT = texOpts.wrapT;
  if (texOpts?.magFilter) texture.magFilter = texOpts.magFilter;
  if (texOpts?.minFilter) texture.minFilter = texOpts.minFilter;
  if (texOpts?.format) texture.format = texOpts.format;
  if (texOpts?.type) texture.type = texOpts.type;
  if (texOpts?.anisotropy) texture.anisotropy = texOpts.anisotropy;
  if (texOpts?.colorSpace) texture.colorSpace = texOpts.colorSpace;
  texture.userData = userData || {};
  if (debugData) {
    texture.name = debugData.name || texture.name;
    texture.userData.name = debugData.name;
    texture.userData.description = debugData.description;
  }
  return texture;
};

const getNoFileTexture = (texOpts?: TexOpts, isCubeTexture?: boolean) =>
  isCubeTexture
    ? new THREE.CubeTexture(
        undefined,
        undefined,
        texOpts?.wrapS,
        texOpts?.wrapT,
        texOpts?.magFilter,
        texOpts?.minFilter,
        texOpts?.format,
        texOpts?.type,
        texOpts?.anisotropy,
        texOpts?.colorSpace
      )
    : new THREE.Texture(
        texOpts?.image,
        texOpts?.mapping,
        texOpts?.wrapS,
        texOpts?.wrapT,
        texOpts?.magFilter,
        texOpts?.minFilter,
        texOpts?.format,
        texOpts?.type,
        texOpts?.anisotropy,
        texOpts?.colorSpace
      );

const createTexture = (
  id?: string,
  fileName?: string,
  texOpts?: TexOpts,
  throwOnError?: boolean,
  userData?: Record<string, unknown>,
  debugData?: { name?: string; description?: string },
  isPersistent?: boolean
) => {
  if (id && textures[id]) {
    retagAssetOwner(textures[id].resource);
    return textures[id].resource;
  }

  if (!fileName) return getNoFileTexture(texOpts);

  if (isKTX2(fileName)) {
    const errorMsg = `KTX2 textures can only be loaded with loadTextureAsync (id: "${id}", fileName: "${fileName}")`;
    lerror(errorMsg);
    if (throwOnError) throw new Error(errorMsg);
    return getNoFileTexture(texOpts);
  }

  if (isHDR(fileName)) {
    const loader = new HDRLoader();
    const texture = setTextureOpts(
      loader.setDataType(THREE.HalfFloatType).load(
        fileName,
        (texture) => texture,
        undefined,
        (err) => {
          const errorMsg = `Could not load HDR texture in createTexture (id: "${id}", fileName: "${fileName}")`;
          lerror(errorMsg, err);
          if (throwOnError) throw new Error(errorMsg);
          return new THREE.Texture();
        }
      ),
      texOpts
    );
    saveTexture(texture, id, isPersistent);
    return texture;
  }

  const loader = new THREE.TextureLoader();
  const texture = setTextureOpts(
    loader.load(
      fileName,
      (texture) => texture,
      undefined,
      (err) => {
        const errorMsg = `Could not load texture in createTexture (id: "${id}", fileName: "${fileName}")`;
        lerror(errorMsg, err);
        if (throwOnError) throw new Error(errorMsg);
        return new THREE.Texture();
      }
    ),
    texOpts
  );
  texture.userData = userData || {};
  if (debugData) {
    texture.name = debugData.name || texture.name;
    texture.userData.name = debugData.name;
    texture.userData.description = debugData.description;
  }
  saveTexture(texture, id, isPersistent);
  return texture;
};

/**
 * Loads one or more textures in the background.
 * @param texData array of objects: { id?: string; fileName?: string; texOpts?: {@link TexOpts} }[]
 * @param updateStatusFn optional status update function
 * @param onErrorAction optional on error action
 */
export const loadTextures = (
  texData: {
    id?: string;
    fileName?: string;
    texOpts?: TexOpts;
    isPersistent?: boolean;
    userData?: Record<string, unknown>;
    debugData?: { name?: string; description?: string };
  }[],
  updateStatusFn?: (
    loadedTextures: { [id: string]: THREE.Texture },
    loadedCount: number,
    totalCount: number
  ) => void,
  onErrorAction?: 'NO_TEXTURE' | 'EMPTY_TEXTURE' | 'THROW_ERROR'
) => {
  const totalCount = texData.length;
  let loadedCount = 0;
  if (!totalCount) {
    throw new Error('Could not load textures, "texData" array was empty.');
  }

  const batchTextures: { [id: string]: THREE.Texture } = {};

  const loadOneBatchTexture = (index: number) => {
    const { id, fileName, texOpts, isPersistent, userData, debugData } = texData[index];
    const loader = new THREE.TextureLoader();

    if (id && textures[id]) {
      retagAssetOwner(textures[id].resource);
      batchTextures[id] = textures[id].resource;
      loadedCount++;
      if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
      return;
    }

    if (fileName && isKTX2(fileName)) {
      lerror(
        `KTX2 textures can only be loaded with loadTextureAsync, skipped in loadTextures (id: ${id}, fileName: ${fileName})`
      );
      if (onErrorAction === 'THROW_ERROR') {
        throw new Error(`KTX2 texture in loadTextures (id: ${id}, fileName: ${fileName})`);
      }
      if (onErrorAction === 'EMPTY_TEXTURE') {
        const texture = createTexture(
          id,
          undefined,
          texOpts,
          false,
          userData,
          debugData,
          isPersistent
        );
        batchTextures[id || texture.uuid] = texture;
      }
      loadedCount++;
      if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
    } else if (fileName) {
      loader.load(
        fileName,
        (texture) => {
          const texId = id || texture.uuid;
          setTextureOpts(texture, texOpts, userData, debugData);
          saveTexture(texture, texId, isPersistent);
          batchTextures[texId] = texture;
          loadedCount++;
          if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
        },
        undefined,
        (err) => {
          const errorMsg = `Could not load texture in loadTextures (id: ${id}, fileName: ${fileName})`;
          lerror(errorMsg, err);
          if (onErrorAction === 'THROW_ERROR') {
            throw new Error(errorMsg);
          }
          if (onErrorAction === 'EMPTY_TEXTURE') {
            const texture = createTexture(
              id,
              undefined,
              texOpts,
              false,
              userData,
              debugData,
              isPersistent
            );
            const texId = id || texture.uuid;
            batchTextures[texId] = texture;
          }
          loadedCount++;
          if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
        }
      );
    } else {
      const texture = createTexture(
        id,
        undefined,
        texOpts,
        false,
        userData,
        debugData,
        isPersistent
      );
      const texId = id || texture.uuid;
      batchTextures[texId] = texture;
      loadedCount++;
      if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);
    }
  };

  // Call once before loading
  if (updateStatusFn) updateStatusFn(batchTextures, loadedCount, totalCount);

  for (let i = 0; i < totalCount; i++) {
    loadOneBatchTexture(i);
  }
};

/**
 * Creates or retrieves a texture to be used without async loading logic.
 */
export const loadTexture = ({
  id,
  fileName,
  texOpts,
  throwOnError,
  isPersistent,
  userData,
  debugData,
}: {
  id?: string;
  fileName?: string;
  texOpts?: TexOpts;
  throwOnError?: boolean;
  isPersistent?: boolean;
  userData?: Record<string, unknown>;
  debugData?: { name?: string; description?: string };
}) => {
  const cached = (id && getTexture(id)) || (fileName && getTexture(fileName));
  if (cached) {
    retagAssetOwner(cached);
    return cached;
  }
  const texture = createTexture(
    id,
    fileName,
    texOpts,
    throwOnError,
    userData,
    debugData,
    isPersistent
  );
  saveTexture(texture, id || fileName || texture.uuid, isPersistent);
  return texture;
};

/**
 * The URL loadTextureAsync loads a single-file texture from: the asset pipeline's output, or its
 * `fileName` resolved like three's loaders do (see resolveAssetUrl).
 */
export const resolveTextureUrl = ({
  id,
  fileName,
  path,
  __url,
  __sourceUrl,
}: Omit<TextureProps, 'fileName'> & { fileName?: string }) =>
  resolveAssetUrl({ id, fileName, __url, __sourceUrl }, (name) => toLoaderUrl(name, path));

type TextureFileLoaderType = 'KTX2Loader' | 'HDRLoader' | 'TextureLoader';

const getTextureFileLoaderType = (url: string, useHDRLoader?: boolean): TextureFileLoaderType =>
  isKTX2(url) ? 'KTX2Loader' : useHDRLoader && isHDR(url) ? 'HDRLoader' : 'TextureLoader';

/**
 * Loads one texture file without registering it (loadTextureAsync registers what this returns),
 * with the loader its URL calls for: a KTX2 file gives a CompressedTexture (a
 * CompressedArrayTexture for an array file) with its flip and mip chain baked in, an HDR file
 * (with `useHDRLoader`) a HalfFloat DataTexture, anything else a Texture. Standard and HDR files
 * load where AppConfig.assets targets textures. A Texture decoded in the assets worker holds an
 * ImageBitmap with its flip baked in (`flipY` false); one the caller doesn't register is the
 * caller's to close.
 * @param url the file's URL, as resolveAssetUrl returns it
 * @param useHDRLoader load an `.hdr` file as HDR data
 */
export const loadTextureFileAsync = async (
  url: string,
  useHDRLoader?: boolean
): Promise<{ texture: THREE.Texture; report: AssetLoadReport }> => {
  const loaderType = getTextureFileLoaderType(url, useHDRLoader);
  if (loaderType === 'KTX2Loader') {
    // Compressed texture: flipY and mipmaps are baked into the file (see loadKTX2Texture)
    const startedAt = performance.now();
    const texture = await loadKTX2Texture(url);
    const report: AssetLoadReport = {
      target: 'MAIN_THREAD',
      loadedOn: 'MAIN_THREAD',
      durationMs: performance.now() - startedAt,
    };
    return { texture, report };
  }
  if (loaderType === 'HDRLoader') {
    const { result, report } = await runAssetTask<THREE.DataTexture>(
      'TEXTURE',
      async () => createHDRTextureFromWorkerData(await loadHDRTextureInWorker(url)),
      () => new HDRLoader().loadAsync(url),
      null // HDR parsing is plain JS, no worker capability needed
    );
    return { texture: result, report };
  }
  if (useHDRLoader) {
    lwarn(
      `[Aekasha Texture Pipeline] useHDRLoader override ignored for non-HDR file extension: ${url}`
    );
  }
  const { result, report } = await runAssetTask<THREE.Texture>(
    'TEXTURE',
    async () => createTextureFromWorkerBitmap(await loadTextureInWorker(url)),
    () => new THREE.TextureLoader().loadAsync(url)
  );
  return { texture: result, report };
};

/** A texture array asset's stand-in when it can't load: one black texel per layer. */
const getNoFileArrayTexture = (layers: number, texOpts?: TexOpts) => {
  const texture = new THREE.DataArrayTexture(new Uint8Array(4 * layers), 1, 1, layers);
  texture.needsUpdate = true;
  return setTextureOpts(texture, texOpts);
};

/**
 * A loaded texture array file as a `CompressedArrayTexture` with `layers.length` layers. `ktx
 * create --layers 1` writes `layerCount: 1`, which KTX2Loader loads as a plain
 * `CompressedTexture`: that one is wrapped. Throws when the file has another layer count.
 */
const toCompressedArrayTexture = (texture: THREE.Texture, layers: string[]) => {
  const compressed = texture as THREE.CompressedTexture;
  if (!compressed.isCompressedTexture) throw new Error('its output is not a KTX2 file');
  const isArray = (texture as THREE.CompressedArrayTexture).isCompressedArrayTexture;
  const depth = isArray ? (texture.image as { depth: number }).depth : 1;
  if (depth !== layers.length) {
    throw new Error(
      `its output has ${depth} layer(s) and its generated data names ${layers.length} (__layers): run "yarn gatherAppData"`
    );
  }
  if (isArray) return texture as THREE.CompressedArrayTexture;
  const { width, height } = compressed.image as { width: number; height: number };
  const array = new THREE.CompressedArrayTexture(
    compressed.mipmaps as unknown as ImageData[],
    width,
    height,
    1,
    compressed.format,
    compressed.type
  );
  array.colorSpace = compressed.colorSpace;
  array.premultiplyAlpha = compressed.premultiplyAlpha;
  array.wrapS = compressed.wrapS;
  array.wrapT = compressed.wrapT;
  array.minFilter = compressed.minFilter;
  array.magFilter = compressed.magFilter;
  array.anisotropy = compressed.anisotropy;
  array.generateMipmaps = false;
  array.needsUpdate = true;
  compressed.dispose(); // Never uploaded
  return array;
};

/**
 * loadTextureAsync for a texture array asset (`__layers`, p299 D2): its KTX2 output, or (without
 * `throwOnError`) an empty array texture with the same layer count when there is none or it
 * fails. It has no source file to fall back to. Its `userData.textureArray` describes it like a
 * runtime array's (`getTextureArrayInfo`).
 */
const loadTextureArrayAssetAsync = async ({
  id,
  texOpts,
  throwOnError,
  isPersistent,
  userData,
  debugData,
  __url,
  __layers: layers,
}: TextureProps & { __layers: string[] }) => {
  let url: string | undefined;
  try {
    if (!__url) {
      throw new Error(
        'the asset pipeline has no output for it (encoder missing, the encode failed, its textures side is off, or not built yet; see the dev server\'s log, or run "yarn assets"): an array loads only from its KTX2 output'
      );
    }
    url = resolveTextureUrl({ id, __url });
    const { texture, report } = await loadTextureFileAsync(url);
    const array = toCompressedArrayTexture(texture, layers);
    setTextureOpts(array, texOpts, userData, debugData);
    const mipmaps = array.mipmaps as unknown as { data: ArrayBufferView }[];
    const info: TextureArrayInfo = {
      origin: 'BUILD',
      members: [...layers],
      kind: 'COMPRESSED',
      width: array.image.width,
      height: array.image.height,
      levels: mipmaps.length,
      layerBytes: mipmaps.reduce((sum, mip) => sum + mip.data.byteLength, 0) / layers.length,
      swappable: false,
      cpuDataReleased: false,
    };
    array.userData.textureArray = info;
    return saveAndReport(array, id, isPersistent, report, url);
  } catch (err) {
    const errorMsg = `Could not load texture array "${id}" in loadTextureAsync${url ? ` (url: "${url}")` : ''}: ${(err as Error).message}`;
    lerror(errorMsg);
    if (throwOnError) throw new Error(errorMsg);
    return getNoFileArrayTexture(layers.length, texOpts);
  }
};

/**
 * A loaded atlas slot file's {@link TextureAtlasInfo}. Throws when the file doesn't fit its
 * layout: its size must be the layout's halved per dropped top level, and those levels plus the
 * stored ones at most the layout's `levels` (with `mipChain: 'FULL'`, its full chain's).
 */
const getAtlasSlotInfo = (texture: THREE.Texture, atlas: TextureAtlasSlotInfo) => {
  const compressed = texture as THREE.CompressedTexture;
  if (!compressed.isCompressedTexture) throw new Error('its output is not a KTX2 file');
  const { width, height } = compressed.image as { width: number; height: number };
  const [layoutWidth, layoutHeight] = atlas.size;
  const dropped = Math.log2(layoutWidth / width);
  if (!Number.isInteger(dropped) || dropped < 0 || layoutHeight / height !== 2 ** dropped) {
    throw new Error(
      `its output is ${width}×${height} and its layout ${layoutWidth}×${layoutHeight} (__atlas.size): run "yarn gatherAppData"`
    );
  }
  const storedLevels = compressed.mipmaps.length;
  // A full chain goes down to 1×1 (the schema's getFullMipLevelCount; core imports no zod)
  const maxLevels =
    atlas.mipChain === 'FULL'
      ? Math.floor(Math.log2(Math.max(layoutWidth, layoutHeight))) + 1
      : atlas.levels;
  if (dropped + storedLevels > maxLevels) {
    throw new Error(
      `its output has ${storedLevels} mip level(s)${dropped ? ` below ${dropped} dropped one(s)` : ''} and its layout ${atlas.mipChain === 'FULL' ? `has a full chain of ${maxLevels}` : `keeps ${maxLevels} apart (__atlas.levels)`}: run "yarn gatherAppData"`
    );
  }
  const info: TextureAtlasInfo = {
    ...structuredClone(atlas),
    width,
    height,
    storedLevels,
  };
  return info;
};

/**
 * loadTextureAsync for a texture atlas slot (`__atlas`, p299 D3): its KTX2 output, or (without
 * `throwOnError`) an empty texture when there is none or it fails. A slot has no source file to
 * fall back to. Its `userData.textureAtlas` has the cell table (`getTextureAtlasInfo`).
 */
const loadTextureAtlasSlotAsync = async ({
  id,
  texOpts,
  throwOnError,
  isPersistent,
  userData,
  debugData,
  __url,
  __atlas: atlas,
}: TextureProps & { __atlas: TextureAtlasSlotInfo }) => {
  let url: string | undefined;
  try {
    if (!__url) {
      throw new Error(
        'the asset pipeline has no output for it (encoder missing, the encode failed, its textures side is off, or not built yet; see the dev server\'s log, or run "yarn assets"): an atlas slot loads only from its KTX2 output'
      );
    }
    url = resolveTextureUrl({ id, __url });
    const { texture, report } = await loadTextureFileAsync(url);
    const info = getAtlasSlotInfo(texture, atlas);
    setTextureOpts(texture, texOpts, userData, debugData);
    texture.userData.textureAtlas = info;
    return saveAndReport(texture, id, isPersistent, report, url);
  } catch (err) {
    const errorMsg = `Could not load texture atlas slot "${id}" in loadTextureAsync${url ? ` (url: "${url}")` : ''}: ${(err as Error).message}`;
    lerror(errorMsg);
    if (throwOnError) throw new Error(errorMsg);
    return getNoFileTexture(texOpts);
  }
};

/**
 * Loads a texture asynchronously supporting standard textures, HDR data textures, KTX2 compressed
 * textures and CubeTextures. Standard and HDR textures load where AppConfig.assets targets
 * textures (main thread or the assets worker, with the same result either way). KTX2 textures
 * are transcoded in the KTX2 loader's own worker pool, from the main thread (it needs the
 * renderer), and cube textures always load on the main thread.
 *
 * A texture from generated data (a `*.texture.json`) loads the asset pipeline's output (`__url`)
 * instead of its `fileName`, see resolveAssetUrl. The loader is picked by the loaded URL. A
 * texture array asset (`*.textureArray.json`, p299 D2) loads its KTX2 output as a
 * `CompressedArrayTexture`, a one-layer array too. A texture atlas slot (`*.textureAtlas.json`,
 * p299 D3) loads its KTX2 output with its cell table on `userData.textureAtlas`.
 */
export const loadTextureAsync = async (props: TextureProps) => {
  const {
    id,
    fileName,
    path,
    useHDRLoader,
    texOpts,
    throwOnError,
    isPersistent,
    userData,
    debugData,
    __url,
    __sourceUrl,
    __layers,
    __atlas,
  } = props;
  if (id && textures[id]) {
    retagAssetOwner(textures[id].resource);
    return textures[id].resource;
  }
  if (__layers) return loadTextureArrayAssetAsync({ ...props, __layers });
  if (__atlas) return loadTextureAtlasSlotAsync({ ...props, __atlas });

  // A packed texture (p300 DD5) has no fileName, only its output
  if (!fileName && !__url) return getNoFileTexture(texOpts);

  let loaderType = '';
  let url: string | undefined;

  try {
    if (!Array.isArray(fileName)) {
      url = resolveTextureUrl({ id, fileName, path, __url, __sourceUrl });
      loaderType = getTextureFileLoaderType(url, useHDRLoader);
      const { texture: result, report } = await loadTextureFileAsync(url, useHDRLoader);
      const loadedTexture = setTextureOpts(result, texOpts, userData, debugData);
      return saveAndReport(loadedTexture, id, isPersistent, report, url);
    } else {
      // Cube texture (always loaded on the main thread)
      if (fileName.length !== 6) {
        throw new Error(
          `Cube texture has to have exactly 6 images in an array (found ${fileName.length} images).`
        );
      }
      loaderType = 'CubeTextureLoader';
      const loader = new THREE.CubeTextureLoader();
      const loadedTexture = setTextureOpts(
        await loader.setPath(path || './').loadAsync(fileName),
        texOpts,
        userData,
        debugData
      );
      return saveLoadedTexture(loadedTexture, id, isPersistent) as THREE.CubeTexture;
    }
  } catch (err) {
    const errorMsg = `Could not load texture in loadTextureAsync (id: "${id}", fileName: "${Array.isArray(fileName) ? fileName.join(', ') : fileName ?? ''}", ${path ? `path: "${path}", ` : ''}${url ? `url: "${url}", ` : ''}loaderType: "${loaderType}")`;
    lerror(errorMsg, err);
    if (throwOnError) throw new Error(errorMsg);
    if (Array.isArray(fileName)) return getNoFileTexture(texOpts, true) as THREE.CubeTexture;
    return getNoFileTexture(texOpts) as THREE.Texture;
  }
};

/**
 * Returns a texture or undefined based on the id.
 */
export const getTexture = (id: string) => textures[id]?.resource;

/**
 * Returns multiple textures based on an array of ids.
 */
export const getTextures = (ids: string[]) =>
  ids.map((id) => textures[id]?.resource).filter(Boolean) as THREE.Texture[];

/**
 * Returns a flat map object of all existing texture resources.
 */
export const getAllTextures = () => {
  const flatMap: { [id: string]: THREE.Texture } = {};
  Object.keys(textures).forEach((key) => {
    flatMap[key] = textures[key].resource;
  });
  return flatMap;
};

export const getTextureRegistry = () => textures;

/**
 * Checks whether a texture with a specific id exists in memory cache.
 */
export const doesTextureExist = (id: string) => Boolean(textures[id]);

/**
 * Forcefully disposes and removes one or multiple textures from memory cache.
 */
export const deleteTexture = (id: string | string[]) => {
  const targetIds = Array.isArray(id) ? id : [id];
  const idsDeleted: string[] = [];

  for (const texId of targetIds) {
    const entry = textures[texId];
    if (!entry) continue;

    disposeTextureResource(entry.resource);
    delete textures[texId];
    idsDeleted.push(texId);
  }

  if (!idsDeleted.length) {
    lwarn(
      `None of the textures with ids "${targetIds.join(', ')}" could be found and could not be deleted.`
    );
    return;
  }

  const idsNotDeleted = targetIds.filter((texId) => !idsDeleted.includes(texId));
  if (idsNotDeleted.length) {
    lwarn(`Textures with ids "${idsNotDeleted.join(', ')}" could not be found or deleted.`);
  }
};

/**
 * Saves a texture instance inside the engine tracking registry.
 */
export const saveTexture = <T extends THREE.Texture = THREE.Texture>(
  texture: T,
  givenId?: string,
  isPersistent?: boolean
): T => {
  const id = givenId || texture.uuid;
  if (textures[id]) {
    retagAssetOwner(textures[id].resource);
    return textures[id].resource as T;
  }

  texture.userData.id = id;
  textures[id] = {
    resource: texture,
    count: 0,
    ...(isPersistent ? { persistent: true } : {}),
  };
  recordAssetOwner(texture);
  return texture;
};
