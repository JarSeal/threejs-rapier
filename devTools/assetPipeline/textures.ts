import fs from 'fs';
import type { TextureCodec, TextureSlot } from '../../src/_engine/schemas/assetsConfigSchema';
import { getFullMipLevelCount } from '../../src/_engine/schemas/textureAtlasSchema';
import { measureAlphaCoverage, resolveCoverageCut, scaleAlphaForCoverage } from './alphaCoverage';
import {
  encodePng,
  flipY,
  getNextMipLevel,
  getOutputSize,
  readImageFile,
  resizeImage,
  type Img,
} from './images';
import { encodeKtx2, encodeKtx2Levels, type KtxProvider, type KtxSettings } from './ktxEncode';
import {
  getLogicalPath,
  getPackLogicalPath,
  passThroughSource,
  writeOutput,
  type PipelineOutput,
} from './outputs';
import { buildPackedImage, getPackChannelCount, listPackFiles } from './pack';
import type { ResolvedTextureSettings } from './settings';
import { resolvePackFile, type AssetSource, type PackSource } from './sources';

/**
 * Texture encoding (p300 Phase 2 step 5): fit to `maxSize` (multiples of 4 for a
 * block-compressed codec, §4), resize as linear values, then KTX2 through `ktx`, or a PNG for
 * `codec: "none"`. Standalone textures are stored flipped in KTX2: they load with flipY, which
 * a compressed texture can't apply (§6). A PNG output is stored as it is, since the runtime
 * flips it. A glTF's textures are never flipped.
 */

/** What one encoded texture became; step 7 derives `__bytes` / `__vramBytes` from it. */
export type EncodedTexture = {
  /** A glTF texture's name (or image URI); unset for a standalone texture */
  name?: string;
  slot: TextureSlot;
  codec: TextureCodec;
  /** As stored (after `maxSize` and the rounding to multiples of 4) */
  width: number;
  height: number;
  hasAlpha: boolean;
  mipmaps: boolean;
  normalMode: boolean;
  bytes: number;
  /** An array's (p299 D2): its size is the size before `maxSize`, its bytes every layer's files */
  source: { width: number; height: number; bytes: number };
  /** A texture array's layer count (p299 D2); unset for a texture */
  layers?: number;
  /**
   * The mip levels stored, when the chain is shorter than a full one: an atlas slot's (p299 D3)
   * stops at the level its layout keeps apart. Unset: a full chain (with `mipmaps`) or one level.
   */
  levels?: number;
};

export type TextureImageOpts = {
  isSrgb: boolean;
  /** A normal map: resized as unit vectors, and `ktx --normalize` */
  isNormal: boolean;
  /** Store KTX2 flipped (standalone textures) */
  flip: boolean;
  getKtx: KtxProvider;
};

/** The size a texture is stored at; warns when the rounding to multiples of 4 stretched it. */
export const fitTextureSize = (
  width: number,
  height: number,
  settings: ResolvedTextureSettings,
  warn: (message: string) => void
) => {
  const size = getOutputSize(width, height, {
    maxSize: settings.maxSize,
    isBlockCompressed: settings.codec !== 'none',
  });
  if (size.stretch > 1e-6) {
    warn(
      `${width}×${height} is stored at ${size.width}×${size.height} (block-compressed sizes are multiples of 4): the aspect ratio changes by ${(size.stretch * 100).toFixed(2)}%`
    );
  }
  return size;
};

/** Encodes linear channels at their stored size: KTX2, or a PNG for `codec: "none"`. */
export const encodeTextureImage = async (
  img: Img,
  settings: ResolvedTextureSettings,
  opts: TextureImageOpts
): Promise<{ bytes: Uint8Array; ext: '.ktx2' | '.png' }> => {
  if (settings.codec === 'none') {
    return { bytes: new Uint8Array(await encodePng(img, opts.isSrgb)), ext: '.png' };
  }
  const bytes = await encodeKtx2(opts.flip ? flipY(img) : img, settings, opts);
  return { bytes, ext: '.ktx2' };
};

export const describeEncodedTexture = (
  img: Pick<Img, 'width' | 'height' | 'channels'>,
  settings: ResolvedTextureSettings,
  rest: Pick<EncodedTexture, 'name' | 'slot' | 'bytes' | 'source'>
): EncodedTexture => ({
  ...rest,
  codec: settings.codec,
  width: img.width,
  height: img.height,
  hasAlpha: img.channels === 4,
  mipmaps: settings.codec !== 'none' && settings.mipmaps,
  normalMode: settings.codec !== 'none' && settings.normalMode,
});

const getFileSize = (file: string) => fs.statSync(file).size;

/**
 * A texture's full chain with each level's alpha scaled to `sourceImg`'s coverage at `cut` (p341):
 * the levels built here (`getNextMipLevel`, the atlases' box chain) instead of by `ktx
 * --generate-mipmap`, each halved from the unscaled one before it, so the scales don't compound.
 * `img` is level 0 as stored; when `maxSize` resized it from `sourceImg` (another object), it is
 * scaled too.
 */
const encodeCoverageLevels = async (
  sourceImg: Img,
  img: Img,
  cut: number,
  settings: KtxSettings,
  opts: TextureImageOpts
) => {
  const target = measureAlphaCoverage(sourceImg, cut);
  let level: Img | null = null;
  return encodeKtx2Levels(
    getFullMipLevelCount(img.width, img.height),
    async (index) => {
      level = level ? getNextMipLevel(level, opts.isNormal) : img;
      const stored =
        index === 0 && img === sourceImg
          ? level
          : scaleAlphaForCoverage(level, cut, [target]).image;
      return opts.flip ? flipY(stored) : stored;
    },
    settings,
    { channels: 4, isSrgb: opts.isSrgb, isNormal: opts.isNormal, getKtx: opts.getKtx }
  );
};

/**
 * Encodes a `*.texture.json`'s source (a file or a pack) with the settings of its slot.
 * A `codec: "none"` file that needs no resize is kept as it is (`passThroughSource`). With
 * `alphaCoverage` (p341) each mip level keeps the source's coverage at that cut (see
 * {@link encodeCoverageLevels}); a pack is then built at its own size and resized after, so its
 * coverage is measured before `maxSize`, like a file's.
 */
export const encodeTextureAsset = async (
  source: Extract<AssetSource, { file: string }> | PackSource,
  slot: TextureSlot,
  slotSettings: ResolvedTextureSettings,
  opts: {
    isSrgb: boolean;
    /** The JSON's `optimize.alphaCoverage` */
    alphaCoverage?: number;
    getKtx: KtxProvider;
    warn: (message: string) => void;
  }
): Promise<{ output: PipelineOutput; texture: EncodedTexture }> => {
  const isNormal = slot === 'normal';
  const imageOpts: TextureImageOpts = {
    isSrgb: opts.isSrgb,
    isNormal,
    flip: true,
    getKtx: opts.getKtx,
  };
  const getCoverageCut = (hasAlpha: boolean) =>
    resolveCoverageCut(opts.alphaCoverage, {
      label: 'optimize.alphaCoverage',
      slot,
      settings: slotSettings,
      hasAlpha,
      warn: opts.warn,
    });

  // Level 0 as stored, and (with a cut) before maxSize, what the coverage is measured on.
  // `resizeImage` returns the image itself when the size stays, so then they're one.
  let img: Img;
  let sourceImg: Img;
  let sourceInfo: EncodedTexture['source'];
  let logicalPath: string;
  let cut: number | undefined;
  if (source.kind === 'pack') {
    cut = getCoverageCut(getPackChannelCount(source.pack) === 4);
    let packSize = { width: 0, height: 0 };
    let size = packSize;
    sourceImg = await buildPackedImage(source.pack, {
      resolveFile: (src) => resolvePackFile(source.jsonFile, src),
      isSrgb: opts.isSrgb,
      getSize: (width, height) => {
        packSize = { width, height };
        size = fitTextureSize(width, height, slotSettings, opts.warn);
        return cut === undefined ? size : packSize;
      },
    });
    img = resizeImage(sourceImg, size.width, size.height, isNormal);
    const files = listPackFiles(source.pack).map((src) => resolvePackFile(source.jsonFile, src));
    sourceInfo = { ...packSize, bytes: files.reduce((sum, file) => sum + getFileSize(file), 0) };
    logicalPath = getPackLogicalPath(source);
  } else {
    sourceImg = await readImageFile(source.file, { isSrgb: opts.isSrgb, rgbOnly: isNormal });
    cut = getCoverageCut(sourceImg.channels === 4);
    sourceInfo = {
      width: sourceImg.width,
      height: sourceImg.height,
      bytes: getFileSize(source.file),
    };
    const size = fitTextureSize(sourceImg.width, sourceImg.height, slotSettings, opts.warn);
    const isResized = size.width !== sourceImg.width || size.height !== sourceImg.height;
    if (slotSettings.codec === 'none' && !isResized) {
      const { file, url, bytes } = passThroughSource(source);
      const output = { file, url, bytes };
      const texture = describeEncodedTexture(sourceImg, slotSettings, {
        slot,
        bytes: output.bytes,
        source: sourceInfo,
      });
      return { output, texture };
    }
    img = resizeImage(sourceImg, size.width, size.height, isNormal);
    logicalPath = getLogicalPath(source);
  }

  // `resolveCoverageCut` returns no cut for codec "none"
  const { bytes, ext } =
    cut !== undefined && slotSettings.codec !== 'none'
      ? {
          bytes: await encodeCoverageLevels(sourceImg, img, cut, slotSettings, imageOpts),
          ext: '.ktx2' as const,
        }
      : await encodeTextureImage(img, slotSettings, imageOpts);
  const output = writeOutput(logicalPath, ext, bytes);
  const texture = describeEncodedTexture(img, slotSettings, {
    slot,
    bytes: output.bytes,
    source: sourceInfo,
  });
  return { output, texture };
};
