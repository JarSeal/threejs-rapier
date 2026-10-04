import path from 'path';
import type { GeneratedAssetFields } from '../../src/_engine/schemas/assetsConfigSchema';
import { getPipelineAssetKey, resolveAssetUse, type PipelineAssetType } from './assets';
import type { PipelineRun } from './run';
import { PUBLIC_DIR, SRC_DIR, type AssetSource, type PackSource } from './sources';
import type { EncodedTexture } from './textures';

/**
 * What the gatherer writes into an asset's generated data from a pipeline run (p300 §5): the
 * output to load, the source for the dev-only "Load source files" override (DD8 level 3), and
 * the download and VRAM figures before and after (`GeneratedAssetFieldsSchema`).
 */

/** Every generated key: a scene entry drops the asset's own before it gets its file's. */
export const GENERATED_FIELD_KEYS = [
  '__url',
  '__sourceUrl',
  '__bytes',
  '__vramBytes',
  '__codec',
] as const satisfies readonly (keyof GeneratedAssetFields)[];

const toUrl = (base: string, file: string) =>
  `/${path.relative(base, file).split(path.sep).join('/')}`;

const getSourceUrl = (source: AssetSource | PackSource) => {
  if (source.kind === 'relative') return toUrl(SRC_DIR, source.file);
  if (source.kind === 'public') return toUrl(PUBLIC_DIR, source.file);
  return undefined;
};

/** A texture's levels: `blockSize`² pixels per block of `blockBytes` (RGBA8 is 1 px, 4 B) */
const getLevelsBytes = (
  width: number,
  height: number,
  blockSize: number,
  blockBytes: number,
  mipmaps: boolean
) => {
  let total = 0;
  let w = width;
  let h = height;
  for (;;) {
    total += Math.ceil(w / blockSize) * Math.ceil(h / blockSize) * blockBytes;
    if (!mipmaps || (w === 1 && h === 1)) return total;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
};

/**
 * Phase 1's estimate (1c), which equals three's figure on every backend it was run on (1e). A
 * PNG is RGBA8 with the mips the runtime generates. KTX2 is counted at 1 B/px (BC7, ASTC 4×4,
 * RGBA ETC2): the most it takes on any device. ETC1S without alpha takes half of that on an ETC2
 * device (phones), which is the figure Phase 4's budgets use too (§11 question 3).
 */
export const estimateTextureVramBytes = (texture: EncodedTexture) => ({
  in: getLevelsBytes(texture.source.width, texture.source.height, 1, 4, true),
  out:
    texture.codec === 'none'
      ? getLevelsBytes(texture.width, texture.height, 1, 4, true)
      : getLevelsBytes(texture.width, texture.height, 4, 16, texture.mipmaps),
});

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
  const fields: GeneratedAssetFields = sourceUrl ? { __sourceUrl: sourceUrl } : {};
  const result = run.results.get(getPipelineAssetKey(type, jsonFile, use));
  if (!result || (result.status !== 'optimized' && result.status !== 'passThrough')) {
    return fields;
  }

  fields.__url = result.output.url;
  fields.__bytes = { in: result.sourceBytes ?? result.output.bytes, out: result.output.bytes };
  if (result.status === 'passThrough') return fields;

  // A GLB's figure is its textures (none when they were dropped) plus its geometry
  const vram = { in: result.geometryBytes?.in ?? 0, out: result.geometryBytes?.out ?? 0 };
  for (const texture of result.textures) {
    const textureVram = estimateTextureVramBytes(texture);
    vram.in += textureVram.in;
    vram.out += textureVram.out;
  }
  fields.__vramBytes = vram;
  if (type === 'texture' && result.textures[0]) fields.__codec = result.textures[0].codec;
  return fields;
};
