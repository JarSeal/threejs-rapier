import path from 'path';
import type { AssetOptimize } from '../../src/_engine/schemas/assetsConfigSchema';
import { encodePng } from './images';
import { getPackLogicalPath, passThroughSource, writeOutput, type PipelineOutput } from './outputs';
import { buildPackedImage } from './pack';
import type { createSettingsResolver, ResolvedAssetSettings } from './settings';
import { resolvePackFile, type AssetSource, type PackSource } from './sources';

/**
 * One asset JSON's source through the pipeline (p300 §7): pass it through as it is (DD8), or
 * encode it (Phase 2 step 5; until then such an asset is `pending`). A packed texture (DD5) is
 * built either way: passed through, it's written as a PNG.
 */

export type PipelineAsset = {
  type: 'texture' | 'importedAsset';
  id: string;
  /** The asset JSON, relative to the repo root */
  jsonFile: string;
  source: AssetSource | PackSource;
  optimize?: AssetOptimize;
  /** A texture whose `texOpts.colorSpace` is sRGB: its colour channels are sRGB-encoded */
  isSrgb?: boolean;
};

export type PipelineResult =
  | {
      status: 'passThrough';
      /** Why it isn't optimized */
      reason: string;
      /** Written into aek-assets/: a relative source's copy, or a pack's PNG (a public source is
       * used where it is) */
      isCopy: boolean;
      output: PipelineOutput;
      settings: ResolvedAssetSettings;
    }
  | { status: 'pending'; reason: string; settings: ResolvedAssetSettings }
  | { status: 'skipped'; reason: string };

/** KTX2's UASTC / ETC1S are LDR formats: an HDR source keeps its own file. */
const HDR_EXTENSIONS = ['.hdr', '.exr'];

const getPassThroughReason = (asset: PipelineAsset, settings: ResolvedAssetSettings) => {
  const { passThrough } = settings;
  if (asset.type === 'texture') {
    if (passThrough.textures) return passThrough.textures;
    const ext = 'file' in asset.source ? path.extname(asset.source.file).toLowerCase() : '';
    if (HDR_EXTENSIONS.includes(ext)) return `an HDR source (${ext}) isn't encoded`;
    return null;
  }
  // A GLB with one side kept as it is still goes through gltf-transform for the other side
  if (!passThrough.textures || !passThrough.mesh) return null;
  return passThrough.textures === passThrough.mesh
    ? passThrough.textures
    : `${passThrough.textures}; ${passThrough.mesh}`;
};

/** A pack passed through: built at its own size, unflipped, as the runtime loads a PNG. */
const passThroughPack = async (source: PackSource, isSrgb: boolean) => {
  const image = await buildPackedImage(source.pack, {
    resolveFile: (src) => resolvePackFile(source.jsonFile, src),
    isSrgb,
  });
  return writeOutput(getPackLogicalPath(source), '.png', await encodePng(image, isSrgb));
};

/**
 * Throws when a pass-through can't copy its source (see `passThroughSource`) or a pack can't be
 * built (see `buildPackedImage`).
 */
export const processAsset = async (
  asset: PipelineAsset,
  resolveSettings: ReturnType<typeof createSettingsResolver>
): Promise<PipelineResult> => {
  if (asset.source.kind === 'remote') {
    return { status: 'skipped', reason: 'a remote file is loaded from where it is' };
  }
  const settings = resolveSettings({ sourcePath: asset.source.repoPath, optimize: asset.optimize });
  const reason = getPassThroughReason(asset, settings);
  if (reason) {
    if (asset.source.kind === 'pack') {
      const output = await passThroughPack(asset.source, !!asset.isSrgb);
      return { status: 'passThrough', reason, isCopy: true, output, settings };
    }
    const { isCopy, ...output } = passThroughSource(asset.source);
    return { status: 'passThrough', reason, isCopy, output, settings };
  }
  return { status: 'pending', reason: 'needs the encoder (p300 Phase 2 step 5)', settings };
};
