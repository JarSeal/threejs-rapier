import fs from 'fs';
import path from 'path';
import type { AssetOptimize } from '../../src/_engine/schemas/assetsConfigSchema';
import { encodePng } from './images';
import { createKtxProvider, EncoderMissingError, type KtxProvider } from './ktxEncode';
import { getPackLogicalPath, passThroughSource, writeOutput, type PipelineOutput } from './outputs';
import { buildPackedImage } from './pack';
import type { createSettingsResolver, ResolvedAssetSettings } from './settings';
import { resolvePackFile, type AssetSource, type PackSource } from './sources';
import { encodeTextureAsset, type EncodedTexture } from './textures';

/**
 * One asset JSON's source through the pipeline (p300 §7): pass it through as it is (DD8), or
 * optimize it: a texture into KTX2 (or a PNG for `codec: "none"`), a GLB / glTF into a
 * compressed .glb. A packed texture (DD5) is built either way: passed through, it's written as
 * a PNG.
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
  /**
   * An imported asset whose textures the runtime registers: `importTextures` in its JSON or in
   * a scene's latest entry that uses this file. Without it, an optimized GLB has no textures.
   */
  importTextures?: boolean;
};

export type PipelineResult =
  | {
      status: 'optimized';
      output: PipelineOutput;
      settings: ResolvedAssetSettings;
      /** A standalone texture's one entry, or a GLB's textures (none when its textures are off) */
      textures: EncodedTexture[];
      /** A GLB's textures dropped because the runtime doesn't import them */
      droppedTextures?: number;
      /** A GLB's vertex and index bytes, before and after */
      geometryBytes?: { in: number; out: number };
      /** Worth a look, but not errors (eg. an aspect ratio changed by the rounding to 4) */
      warnings: string[];
    }
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
  /** It needs `ktx`, and there is none (§8); nothing was written */
  | { status: 'encoderMissing'; reason: string; settings: ResolvedAssetSettings }
  | { status: 'skipped'; reason: string };

/** KTX2's UASTC / ETC1S are LDR formats: an HDR source keeps its own file. */
const HDR_EXTENSIONS = ['.hdr', '.exr'];

/** Already GPU-compressed: nothing to encode. */
const COMPRESSED_TEXTURE_EXTENSIONS = ['.ktx2', '.basis'];

const getPassThroughReason = (asset: PipelineAsset, settings: ResolvedAssetSettings) => {
  const { passThrough } = settings;
  if (asset.type === 'texture') {
    if (passThrough.textures) return passThrough.textures;
    const ext = 'file' in asset.source ? path.extname(asset.source.file).toLowerCase() : '';
    if (HDR_EXTENSIONS.includes(ext)) return `an HDR source (${ext}) isn't encoded`;
    if (COMPRESSED_TEXTURE_EXTENSIONS.includes(ext)) return `the source is already ${ext}`;
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

export type ProcessAssetOpts = {
  /** The run's `ktx` (one setup per run); default: one for this asset */
  getKtx?: KtxProvider;
};

/**
 * Throws when a pass-through can't copy its source (see `passThroughSource`), a pack can't be
 * built (see `buildPackedImage`), a source can't be read or `ktx create` fails.
 */
export const processAsset = async (
  asset: PipelineAsset,
  resolveSettings: ReturnType<typeof createSettingsResolver>,
  opts: ProcessAssetOpts = {}
): Promise<PipelineResult> => {
  const { source } = asset;
  if (source.kind === 'remote') {
    return { status: 'skipped', reason: 'a remote file is loaded from where it is' };
  }
  const settings = resolveSettings({ sourcePath: source.repoPath, optimize: asset.optimize });
  const reason = getPassThroughReason(asset, settings);
  if (reason) {
    if (source.kind === 'pack') {
      const output = await passThroughPack(source, !!asset.isSrgb);
      return { status: 'passThrough', reason, isCopy: true, output, settings };
    }
    const { isCopy, ...output } = passThroughSource(source);
    return { status: 'passThrough', reason, isCopy, output, settings };
  }
  // Only a public source can be missing (legacy, see `resolveAssetSource`): loaded as before
  if (source.kind === 'public' && !fs.existsSync(source.file)) {
    return { status: 'skipped', reason: `${source.repoPath} doesn't exist` };
  }

  const getKtx = opts.getKtx ?? createKtxProvider();
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  try {
    if (asset.type === 'texture') {
      // Not passed through, so its textures side is on
      const slotSettings = settings.textures && settings.textures[settings.slot];
      if (!slotSettings) throw new Error(`${asset.jsonFile}: no texture settings`);
      const { output, texture } = await encodeTextureAsset(source, settings.slot, slotSettings, {
        isSrgb: !!asset.isSrgb,
        getKtx,
        warn,
      });
      return { status: 'optimized', output, settings, textures: [texture], warnings };
    }
    if (source.kind === 'pack') throw new Error('an imported asset has no pack');
    // Loaded on first use: gltf-transform and the meshopt / Draco WASM codecs
    const { encodeGLTFAsset } = await import('./gltf');
    const result = await encodeGLTFAsset(
      source,
      (isColliderSource) =>
        resolveSettings({
          sourcePath: source.repoPath,
          optimize: asset.optimize,
          isColliderSource,
        }),
      { importTextures: !!asset.importTextures, getKtx, warn }
    );
    return { status: 'optimized', ...result, warnings };
  } catch (error) {
    if (error instanceof EncoderMissingError) {
      return { status: 'encoderMissing', reason: error.message, settings };
    }
    throw error;
  }
};
