import path from 'path';
import type { AssetOptimize } from '../../src/_engine/schemas/assetsConfigSchema';
import { passThroughSource, type PipelineOutput } from './outputs';
import type { createSettingsResolver, ResolvedAssetSettings } from './settings';
import type { AssetSource } from './sources';

/**
 * One asset JSON's source through the pipeline (p300 §7): pass it through as it is (DD8), or
 * encode it (Phase 2 step 5; until then such an asset is `pending`).
 */

export type PipelineAsset = {
  type: 'texture' | 'importedAsset';
  id: string;
  /** The asset JSON, relative to the repo root */
  jsonFile: string;
  source: AssetSource;
  optimize?: AssetOptimize;
};

export type PipelineResult =
  | {
      status: 'passThrough';
      /** Why it isn't optimized */
      reason: string;
      /** A relative source copied into aek-assets/ (a public one is used where it is) */
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

/** Throws when a pass-through can't copy its source (see `passThroughSource`). */
export const processAsset = (
  asset: PipelineAsset,
  resolveSettings: ReturnType<typeof createSettingsResolver>
): PipelineResult => {
  if (asset.source.kind === 'remote') {
    return { status: 'skipped', reason: 'a remote file is loaded from where it is' };
  }
  const settings = resolveSettings({ sourcePath: asset.source.repoPath, optimize: asset.optimize });
  const reason = getPassThroughReason(asset, settings);
  if (reason) {
    const { isCopy, ...output } = passThroughSource(asset.source);
    return { status: 'passThrough', reason, isCopy, output, settings };
  }
  return { status: 'pending', reason: 'needs the encoder (p300 Phase 2 step 5)', settings };
};
