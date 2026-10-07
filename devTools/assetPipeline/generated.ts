import path from 'path';
import type {
  GeneratedAssetFields,
  TextureCodec,
} from '../../src/_engine/schemas/assetsConfigSchema';
import {
  getPipelineAssetKey,
  getTextureArrayAssetKey,
  getTextureAtlasSlotAssetKey,
  resolveAssetUse,
  type PipelineAssetType,
} from './assets';
import type { PipelineRun, PipelineRunResult } from './run';
import { PUBLIC_DIR, SRC_DIR, type AssetSource, type PackSource } from './sources';
import type { EncodedTexture } from './textures';

/**
 * What the gatherer writes into an asset's generated data from a pipeline run (p300 §5): the
 * output to load, the source for the dev-only "Load source files" override (DD8 level 3), and
 * the download and VRAM figures before and after, and a GLB's LOD chains
 * (`GeneratedAssetFieldsSchema`).
 */

/** Every generated key: a scene entry drops the asset's own before it gets its file's. */
export const GENERATED_FIELD_KEYS = [
  '__url',
  '__sourceUrl',
  '__bytes',
  '__vramBytes',
  '__codec',
  '__lodChain',
] as const satisfies readonly (keyof GeneratedAssetFields)[];

const toUrl = (base: string, file: string) =>
  `/${path.relative(base, file).split(path.sep).join('/')}`;

const getSourceUrl = (source: AssetSource | PackSource) => {
  if (source.kind === 'relative') return toUrl(SRC_DIR, source.file);
  if (source.kind === 'public') return toUrl(PUBLIC_DIR, source.file);
  return undefined;
};

/**
 * A texture's levels: `blockSize`² pixels per block of `blockBytes` (RGBA8 is 1 px, 4 B), at most
 * `levelCount` of them
 */
const getLevelsBytes = (
  width: number,
  height: number,
  blockSize: number,
  blockBytes: number,
  mipmaps: boolean,
  levelCount = Infinity
) => {
  let total = 0;
  let w = width;
  let h = height;
  for (let level = 1; ; level++) {
    total += Math.ceil(w / blockSize) * Math.ceil(h / blockSize) * blockBytes;
    if (!mipmaps || (w === 1 && h === 1) || level >= levelCount) return total;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
};

/**
 * Phase 1's estimate (1c), which equals three's figure on every backend it was run on (1e). A
 * PNG (`none`) is RGBA8 with the mips the runtime generates. KTX2 is counted at 1 B/px (BC7, ASTC
 * 4×4, RGBA ETC2): the most it takes on any device. ETC1S without alpha takes half of that on an
 * ETC2 device (phones). Phase 4's budgets use the same figure (§11 question 3).
 * @param levelCount A KTX2's mip levels when its chain is shorter (an atlas slot's, p299 D3)
 */
export const estimateVramBytes = (
  width: number,
  height: number,
  codec: TextureCodec,
  mipmaps: boolean,
  levelCount?: number
) =>
  codec === 'none'
    ? getLevelsBytes(width, height, 1, 4, true)
    : getLevelsBytes(width, height, 4, 16, mipmaps, levelCount);

/**
 * An array's (p299 D2) is every layer's: `in` as the runtime would assemble its sources (RGBA8).
 * An atlas slot's (p299 D3) counts its shortened chain; its `in` is the layout as one RGBA8 image.
 */
export const estimateTextureVramBytes = (texture: EncodedTexture) => {
  const layers = texture.layers ?? 1;
  const { width, height, codec, mipmaps, levels } = texture;
  return {
    in: estimateVramBytes(texture.source.width, texture.source.height, 'none', true) * layers,
    out: estimateVramBytes(width, height, codec, mipmaps, levels) * layers,
  };
};

/**
 * A result's download figure (`__bytes`) and, for an optimized one, its VRAM estimate
 * (`__vramBytes`). A GLB's VRAM is its textures (none when they were dropped) plus its geometry.
 * Null for a result without an output.
 */
export const getResultFigures = (result: PipelineRunResult) => {
  if (result.status !== 'optimized' && result.status !== 'passThrough') return null;
  const bytes = { in: result.sourceBytes ?? result.output.bytes, out: result.output.bytes };
  if (result.status === 'passThrough') return { bytes };
  const vramBytes = { in: result.geometryBytes?.in ?? 0, out: result.geometryBytes?.out ?? 0 };
  for (const texture of result.textures) {
    const textureVram = estimateTextureVramBytes(texture);
    vramBytes.in += textureVram.in;
    vramBytes.out += textureVram.out;
  }
  return { bytes, vramBytes };
};

/**
 * The run's result for an asset's data (the JSON, or merged with a scene's latest entry), for the
 * production gather's checks of what shipped scenes use. Null for data the run has no result for.
 * @param jsonFile The asset JSON, absolute or relative to the repo root
 */
export const getAssetResult = (
  run: PipelineRun,
  type: PipelineAssetType,
  jsonFile: string,
  data: Parameters<typeof resolveAssetUse>[1]
) => {
  const use = resolveAssetUse(jsonFile, data);
  if (!use || 'error' in use) return null;
  return run.results.get(getPipelineAssetKey(type, jsonFile, use)) ?? null;
};

/**
 * The run's result for a texture array (p299 D2), for the production gather's checks. Null when
 * the run has none (its layers don't resolve: the gatherer reports that).
 * @param jsonFile The array's JSON, absolute or relative to the repo root
 */
export const getTextureArrayResult = (run: PipelineRun, jsonFile: string) =>
  run.results.get(getTextureArrayAssetKey(jsonFile)) ?? null;

/**
 * The run's result for a texture atlas slot (p299 D3), for the production gather's checks. Null
 * when the run has none (the atlas's cells don't resolve or fit: the gatherer reports that).
 * @param jsonFile The atlas's JSON, absolute or relative to the repo root
 */
export const getTextureAtlasSlotResult = (run: PipelineRun, jsonFile: string, slot: string) =>
  run.results.get(getTextureAtlasSlotAssetKey(jsonFile, slot)) ?? null;

/** A texture array (p299 D2) or an atlas slot (D3): only ever a KTX2 output, never passed through */
export const isKtxOnlyAsset = (result: PipelineRunResult) =>
  result.asset.type === 'textureArray' || result.asset.type === 'textureAtlas';

/**
 * A result a production build can't ship (Phase 3 step 4): its source is local, but the run has
 * no output for it (`encoderMissing`, `error`), and production data has no `__sourceUrl` to fall
 * back to. A relative source or a pack wouldn't load at all, and a public one would load
 * unoptimized. A remote file, or a public file that doesn't exist, ships as it did before the
 * pipeline (`skipped`). A texture array or an atlas slot (p299) is its output alone, so a
 * `skipped` one (its textures side off) has nothing to ship either.
 */
export const isMissingOutput = (result: PipelineRunResult) =>
  result.status === 'encoderMissing' ||
  result.status === 'error' ||
  (result.status === 'skipped' && isKtxOnlyAsset(result));

/** An output's fields: none for a result without one */
const getOutputFields = (
  type: PipelineAssetType,
  result: PipelineRunResult | undefined
): GeneratedAssetFields => {
  const figures = result && getResultFigures(result);
  if (!result || !figures || (result.status !== 'optimized' && result.status !== 'passThrough')) {
    return {};
  }
  const fields: GeneratedAssetFields = { __url: result.output.url, __bytes: figures.bytes };
  if (result.status === 'passThrough') return fields;
  fields.__vramBytes = figures.vramBytes;
  if (type !== 'importedAsset' && result.textures[0]) fields.__codec = result.textures[0].codec;
  if (result.lodChains?.length) fields.__lodChain = result.lodChains;
  return fields;
};

/**
 * The generated fields of an asset's data (the JSON, or merged with a scene's latest entry)
 * from a run. None without a run; only the source's URL for data the run didn't optimize or
 * pass through.
 * @param jsonFile The asset JSON, absolute or relative to the repo root
 */
export const getGeneratedFields = (
  run: PipelineRun | undefined,
  type: PipelineAssetType,
  jsonFile: string,
  data: Parameters<typeof resolveAssetUse>[1],
  opts: { isProduction: boolean }
): GeneratedAssetFields => {
  if (!run) return {};
  const use = resolveAssetUse(jsonFile, data);
  if (!use || 'error' in use) return {};
  const sourceUrl = opts.isProduction ? undefined : getSourceUrl(use.source);
  return {
    ...(sourceUrl ? { __sourceUrl: sourceUrl } : {}),
    ...getOutputFields(type, run.results.get(getPipelineAssetKey(type, jsonFile, use))),
  };
};

/**
 * A texture array's generated fields (p299 D2): its output's `__url`, `__bytes`, `__vramBytes`
 * (every layer) and `__codec`. No `__sourceUrl`: its layers have no single file to load instead.
 * None without a run, or for an array the run has no output for.
 * @param jsonFile The array's JSON, absolute or relative to the repo root
 */
export const getTextureArrayGeneratedFields = (
  run: PipelineRun | undefined,
  jsonFile: string
): GeneratedAssetFields =>
  run ? getOutputFields('textureArray', run.results.get(getTextureArrayAssetKey(jsonFile))) : {};

/**
 * A texture atlas slot's generated fields (p299 D3): its output's `__url`, `__bytes`,
 * `__vramBytes` (its stored levels) and `__codec`. No `__sourceUrl`, like an array's. None
 * without a run, or for a slot the run has no output for.
 * @param jsonFile The atlas's JSON, absolute or relative to the repo root
 */
export const getTextureAtlasSlotGeneratedFields = (
  run: PipelineRun | undefined,
  jsonFile: string,
  slot: string
): GeneratedAssetFields =>
  run
    ? getOutputFields('textureAtlas', run.results.get(getTextureAtlasSlotAssetKey(jsonFile, slot)))
    : {};
