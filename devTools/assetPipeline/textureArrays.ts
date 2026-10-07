import path from 'path';
import fs from 'fs';
import type { TextureSlot } from '../../src/_engine/schemas/assetsConfigSchema';
import type { TextureAsset } from '../../src/_engine/schemas/textureSchema';
import { isTextureArrayLayerFile } from '../../src/_engine/schemas/textureArraySchema';
import {
  flipY,
  readImageFile,
  readImageInfo,
  readImageSizeSync,
  resizeImage,
  type Img,
} from './images';
import { encodeKtx2Layers, type KtxProvider, type KtxSettings } from './ktxEncode';
import { getArrayLogicalPath, writeOutput, type PipelineOutput } from './outputs';
import { buildPackedImage, getPackChannelCount, listPackFiles } from './pack';
import type { ResolvedAssetSettings } from './settings';
import {
  createPackSource,
  resolveAssetSource,
  resolvePackFile,
  toRepoPath,
  type AssetSource,
  type PackSource,
} from './sources';
import { describeEncodedTexture, fitTextureSize, type EncodedTexture } from './textures';

/**
 * Build-time texture arrays (p299 D2): a `*.textureArray.json`'s layers resolved to what the
 * pipeline reads, and encoded as one KTX2 array. A layer is a texture asset's source (its file,
 * or its pack recipe; never its output, its `optimize`, nor a scene's override of it) or a source
 * file of the array's own. The array's `optimize` applies to every layer.
 */

/** An array is read as 8-bit images: these can't be */
const UNREADABLE_LAYER_EXTENSIONS = ['.hdr', '.exr', '.ktx2', '.basis'];

export type TextureArrayLayer = {
  /** Its name in `__layers`: the texture's id, or the file's name without its extension */
  key: string;
  source: Extract<AssetSource, { file: string }> | PackSource;
  /** A texture asset's layer: its id, JSON (absolute) and colour space */
  texture?: { id: string; jsonFile: string; isSrgb: boolean };
};

/** A texture asset by id, as the pipeline or the gatherer has it */
export type TextureLookup = (
  id: string
) =>
  | { jsonFile: string; data: Pick<TextureAsset, 'fileName' | 'path' | 'pack' | 'texOpts'> }
  | undefined;

const resolveFileLayer = (
  jsonFile: string,
  fileName: string,
  urlPath?: string
): Extract<AssetSource, { file: string }> | string => {
  const source = resolveAssetSource({ jsonFile, fileName, path: urlPath });
  if ('error' in source) return source.error;
  if (source.kind === 'remote') return `"${fileName}" is remote, which isn't read`;
  if (!fs.existsSync(source.file) || !fs.statSync(source.file).isFile()) {
    return `source file "${fileName}" not found (expected at ${source.repoPath})`;
  }
  const ext = path.extname(source.file).toLowerCase();
  if (UNREADABLE_LAYER_EXTENSIONS.includes(ext)) {
    return `a layer is read as an 8-bit image, and a ${ext} file isn't one (${source.repoPath})`;
  }
  return source;
};

/** A texture asset's layer: its file or pack, or why it can't be one */
const resolveTextureLayer = (
  id: string,
  findTexture: TextureLookup
): TextureArrayLayer | string => {
  const found = findTexture(id);
  if (!found) {
    return `"${id}" is neither a texture asset's id (*.texture.json) nor a file path (starting with ./, ../ or /)`;
  }
  const { jsonFile, data } = found;
  const texture = { id, jsonFile, isSrgb: data.texOpts?.colorSpace === 'srgb' };
  if (data.pack) return { key: id, source: createPackSource(jsonFile, data.pack), texture };
  if (Array.isArray(data.fileName)) return `the texture "${id}" is a cube texture`;
  if (!data.fileName) return `the texture "${id}" has neither a fileName nor a pack`;
  const source = resolveFileLayer(jsonFile, data.fileName, data.path);
  return typeof source === 'string'
    ? `the texture "${id}" (${toRepoPath(jsonFile)}): ${source}`
    : { key: id, source, texture };
};

const getColorSpaceName = (isSrgb: boolean) => (isSrgb ? 'sRGB' : 'linear');

/**
 * Resolves a source image named in an array's `layers` or an atlas cell's `sources` (p299 D3):
 * a texture asset's id or a file. Returns why it can't be one: a file that doesn't resolve or
 * can't be read as an image, an unknown texture id, a texture without a file or pack (or a cube
 * texture), or a packed texture in another colour space than the target's (its recipe decodes and
 * multiplies in its own).
 * @param jsonFile The array's or atlas's JSON, absolute or relative to the repo root
 * @param opts.isSrgb The target (the array, the atlas slot) is sRGB: the source's pixels are read
 * as that, whatever its texture's `colorSpace` says
 * @param opts.target Names the target in the colour space error, eg. 'the array'
 */
export const resolveTextureSourceRef = (
  jsonFile: string,
  ref: string,
  findTexture: TextureLookup,
  opts: { isSrgb: boolean; target: string }
): TextureArrayLayer | string => {
  if (isTextureArrayLayerFile(ref)) {
    const source = resolveFileLayer(jsonFile, ref);
    return typeof source === 'string'
      ? source
      : { key: path.basename(ref, path.extname(ref)), source };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(ref)) {
    return "a remote file isn't read: a source is a texture id or a local file";
  }
  const entry = resolveTextureLayer(ref, findTexture);
  if (
    typeof entry !== 'string' &&
    entry.source.kind === 'pack' &&
    entry.texture?.isSrgb !== opts.isSrgb
  ) {
    return `the texture's pack is built for a ${getColorSpaceName(!!entry.texture?.isSrgb)} texture and ${opts.target} is ${getColorSpaceName(opts.isSrgb)} (texOpts.colorSpace): its channels would decode and multiply in another colour space`;
  }
  return entry;
};

/**
 * A source's size from its file headers, synchronously (`readImageSizeSync`): a pack's `size`,
 * else its first file's. Null when the format's header isn't read (see `readImageSizeSync`).
 */
export const readTextureSourceSizeSync = ({ source }: TextureArrayLayer) => {
  if (source.kind !== 'pack') return readImageSizeSync(source.file);
  if (source.pack.size) return { width: source.pack.size[0], height: source.pack.size[1] };
  const [first] = listPackFiles(source.pack);
  return first ? readImageSizeSync(resolvePackFile(source.jsonFile, first)) : null;
};

/**
 * Resolves an array's layers. Every problem is in `errors`, each naming its layer: those of
 * {@link resolveTextureSourceRef}, and two layers with the same name.
 * @param jsonFile The array's JSON, absolute or relative to the repo root
 * @param opts.isSrgb The array's `texOpts.colorSpace` is sRGB: every layer's pixels are read as
 * that, whatever its texture's `colorSpace` says
 */
export const resolveTextureArrayLayers = (
  jsonFile: string,
  layers: string[],
  findTexture: TextureLookup,
  opts: { isSrgb: boolean }
): { layers: TextureArrayLayer[]; errors: string[] } => {
  const resolved: TextureArrayLayer[] = [];
  const errors: string[] = [];
  const keys = new Map<string, number>();

  layers.forEach((layer, index) => {
    const label = `layers[${index}] ("${layer}")`;
    const entry = resolveTextureSourceRef(jsonFile, layer, findTexture, {
      isSrgb: opts.isSrgb,
      target: 'the array',
    });
    if (typeof entry === 'string') {
      errors.push(`${label}: ${entry}`);
      return;
    }
    const other = keys.get(entry.key);
    if (other !== undefined) {
      errors.push(
        `${label}: layers[${other}] has the same name, "${entry.key}" (a layer's name is its texture id or file name, and names its layer in __layers)`
      );
      return;
    }
    keys.set(entry.key, index);
    resolved.push(entry);
  });
  return { layers: resolved, errors };
};

/**
 * A texture array as the pipeline builds it: like a pack, it has no single source file, so its
 * rules match, and its output is named after, its JSON.
 */
export type ArraySource = {
  kind: 'array';
  /** The array's JSON, absolute */
  jsonFile: string;
  /** The array's JSON, '/'-separated, relative to the repo root */
  repoPath: string;
  layers: TextureArrayLayer[];
  /** The JSON's `size`; unset: the layers' own, which must agree */
  size?: [number, number];
};

export const createArraySource = (
  jsonFile: string,
  layers: TextureArrayLayer[],
  size?: [number, number]
): ArraySource => {
  const file = path.resolve(jsonFile);
  return { kind: 'array', jsonFile: file, repoPath: toRepoPath(file), layers, size };
};

/** Every file a layer's (or an atlas cell's) source reads: its file, or a pack's in its order */
export const listTextureSourceFiles = ({ source }: TextureArrayLayer) =>
  source.kind === 'pack'
    ? listPackFiles(source.pack).map((src) => resolvePackFile(source.jsonFile, src))
    : [source.file];

/** What a layer's (or an atlas cell's) source is in a cache key, besides its files' bytes */
export const getTextureSourceKeyParam = ({ source }: TextureArrayLayer) =>
  source.kind === 'pack' ? { pack: source.pack } : 'file';

/**
 * Every file an array's encode reads, layer by layer (a pack's files in its order). A file two
 * layers read is listed twice: the cache key hashes the files in this order.
 */
export const listTextureArrayFiles = (source: ArraySource) =>
  source.layers.flatMap(listTextureSourceFiles);

/**
 * The cache key's inputs (besides the files, the settings and the colour space): what each
 * layer is (a file, or a pack's recipe), the size and the output's name.
 */
export const getTextureArrayKeyParams = (source: ArraySource) => ({
  size: source.size ?? null,
  layers: source.layers.map(getTextureSourceKeyParam),
  output: getArrayLogicalPath(source.jsonFile),
});

/**
 * The array's (or an atlas slot's, p299 D3) slot settings, or null when its textures side is off
 * (a rule's `textures: false`, the project switches): then it has no output. Throws when the slot
 * resolves to `codec: "none"` (eg. the `data` slot's default): an array, or an atlas slot with its
 * shortened mip chain, is only ever a KTX2 file.
 * @param what Names it in the error (default 'an array')
 */
export const getTextureArraySlotSettings = (
  settings: ResolvedAssetSettings,
  what = 'an array'
): KtxSettings | null => {
  if (!settings.textures) return null;
  const slotSettings = settings.textures[settings.slot];
  if (slotSettings.codec === 'none') {
    throw new Error(
      `the slot "${settings.slot}" resolves to codec "none", and ${what} is a KTX2 file: set its codec ("optimize": { "textures": { "${settings.slot}": { "codec": "uastc" } } }), or use another slot`
    );
  }
  return slotSettings;
};

const getLayerLabel = (source: ArraySource, index: number) =>
  `layers[${index}] ("${source.layers[index].key}")`;

/**
 * A layer's (or an atlas cell's) source size and whether it has alpha, from the file headers (no
 * pixels are decoded). A normal map's alpha isn't read.
 */
export const probeTextureSource = async (layer: TextureArrayLayer, isNormal: boolean) => {
  const { source } = layer;
  if (source.kind === 'pack') {
    const hasAlpha = getPackChannelCount(source.pack) === 4;
    if (source.pack.size) {
      const [width, height] = source.pack.size;
      return { width, height, hasAlpha };
    }
    // Sources of different sizes without a `size` fail when the pack is built
    const [first] = listPackFiles(source.pack);
    if (!first) throw new Error('a pack of constants only needs a "size"');
    const { width, height } = await readImageInfo(resolvePackFile(source.jsonFile, first));
    return { width, height, hasAlpha };
  }
  const { width, height, channels } = await readImageInfo(source.file);
  // A normal map is read as XYZ (`rgbOnly`), as a texture's is
  return { width, height, hasAlpha: !isNormal && (channels === 2 || channels === 4) };
};

/**
 * A layer's (or an atlas cell's) source as linear channels at `size`, top row first: a pack built
 * at it, a file resized to it (a normal map as XYZ, renormalized).
 */
export const readTextureSource = async (
  layer: TextureArrayLayer,
  size: { width: number; height: number },
  opts: { isSrgb: boolean; isNormal: boolean }
): Promise<Img> => {
  const { source } = layer;
  if (source.kind === 'pack') {
    return buildPackedImage(source.pack, {
      resolveFile: (src) => resolvePackFile(source.jsonFile, src),
      isSrgb: opts.isSrgb,
      getSize: () => size,
    });
  }
  const read = await readImageFile(source.file, { isSrgb: opts.isSrgb, rgbOnly: opts.isNormal });
  return read.width === size.width && read.height === size.height
    ? read
    : resizeImage(read, size.width, size.height, opts.isNormal);
};

/**
 * Encodes an array (p299 D2): every layer resized to the array's size (its `size`, else the
 * layers' common size; then fit to `maxSize` and multiples of 4, like a texture), as one KTX2
 * with `ktx create --layers`. Layers with alpha make the whole array RGBA. Warns for a layer
 * that is upscaled or stretched. Throws, naming the layer, for one that can't be read, and for
 * layers of different sizes without `size`.
 */
export const encodeTextureArray = async (
  source: ArraySource,
  slot: TextureSlot,
  settings: KtxSettings,
  opts: { isSrgb: boolean; getKtx: KtxProvider; warn: (message: string) => void }
): Promise<{ output: PipelineOutput; texture: EncodedTexture }> => {
  const isNormal = slot === 'normal';
  const withLabel = async <T>(index: number, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      throw new Error(`${getLayerLabel(source, index)}: ${(error as Error).message}`);
    }
  };

  const probes: Awaited<ReturnType<typeof probeTextureSource>>[] = [];
  for (let index = 0; index < source.layers.length; index++) {
    probes.push(await withLabel(index, () => probeTextureSource(source.layers[index], isNormal)));
  }
  let base = probes[0];
  if (source.size) {
    base = { width: source.size[0], height: source.size[1], hasAlpha: false };
  } else {
    const other = probes.findIndex((p) => p.width !== base.width || p.height !== base.height);
    if (other >= 0) {
      throw new Error(
        `the layers differ in size (${getLayerLabel(source, 0)} is ${base.width}×${base.height}, ${getLayerLabel(source, other)} ${probes[other].width}×${probes[other].height}): set "size"`
      );
    }
  }
  const size = fitTextureSize(base.width, base.height, settings, opts.warn);
  probes.forEach((probe, index) => {
    const changes: string[] = [];
    if (probe.width < size.width || probe.height < size.height) changes.push('upscaled');
    const stretch = Math.abs(probe.width / probe.height / (base.width / base.height) - 1);
    if (stretch > 1e-6) {
      changes.push(`stretched (its aspect ratio changes by ${(stretch * 100).toFixed(2)}%)`);
    }
    if (changes.length) {
      opts.warn(
        `${getLayerLabel(source, index)}: ${probe.width}×${probe.height} is ${changes.join(' and ')} to ${size.width}×${size.height}`
      );
    }
  });

  const channels = probes.some((probe) => probe.hasAlpha) ? 4 : 3;
  const bytes = await encodeKtx2Layers(
    source.layers.length,
    // Flipped as stored, like a texture's KTX2
    (index) =>
      withLabel(index, async () =>
        flipY(
          await readTextureSource(source.layers[index], size, { isSrgb: opts.isSrgb, isNormal })
        )
      ),
    settings,
    { channels, isSrgb: opts.isSrgb, isNormal, getKtx: opts.getKtx }
  );
  const output = writeOutput(getArrayLogicalPath(source.jsonFile), '.ktx2', bytes);
  const sourceBytes = [...new Set(listTextureArrayFiles(source))].reduce(
    (sum, file) => sum + fs.statSync(file).size,
    0
  );
  const texture: EncodedTexture = {
    ...describeEncodedTexture({ ...size, channels }, settings, {
      slot,
      bytes: output.bytes,
      source: { width: base.width, height: base.height, bytes: sourceBytes },
    }),
    layers: source.layers.length,
  };
  return { output, texture };
};
