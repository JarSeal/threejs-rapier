import fs from 'fs';
import path from 'path';
import {
  GLTF_LOD_FORMAT_VERSION,
  LOD_SIMPLIFY_VERSION,
  type ResolvedLodChainOptions,
} from '../../src/_engine/core/Lod/LodChainOptions';
import type { AssetOptimize } from '../../src/_engine/schemas/assetsConfigSchema';
import { encodePng } from './images';
import {
  createKtxProvider,
  EncoderMissingError,
  type KtxProvider,
  type KtxSettings,
} from './ktxEncode';
import { getCacheKey, type CacheEntry, type CacheHit, type PipelineCache } from './cache';
import { hasColliderNodes, listExternalGLTFFiles, readGLTFJson, type GLTFJson } from './gltfJson';
import { KTX_VERSION } from './ktxTool';
import {
  getLogicalPath,
  getOutputFile,
  getPackLogicalPath,
  passThroughSource,
  writeOutput,
  type PipelineOutput,
} from './outputs';
import type { BuiltLodChain } from './lodChains';
import { buildPackedImage, listPackFiles } from './pack';
import type {
  createSettingsResolver,
  ResolvedAssetSettings,
  ResolvedTextureSettings,
} from './settings';
import { resolvePackFile, ROOT, type AssetSource, type PackSource } from './sources';
import {
  encodeTextureArray,
  getTextureArrayKeyParams,
  getTextureArraySlotSettings,
  listTextureArrayFiles,
  type ArraySource,
} from './textureArrays';
import {
  encodeTextureAtlasSlot,
  getTextureAtlasKeyParams,
  listTextureAtlasFiles,
  type AtlasSlotSource,
} from './textureAtlases';
import { encodeTextureAsset, type EncodedTexture } from './textures';

/**
 * One asset JSON's source through the pipeline (p300 §7): pass it through as it is (DD8), or
 * optimize it: a texture into KTX2 (or a PNG for `codec: "none"`), a GLB / glTF into a
 * compressed .glb, a texture array's layers into one KTX2 array (p299 D2), an atlas slot's cells
 * into one KTX2 (p299 D3). A packed texture (DD5) is built either way: passed through, it's
 * written as a PNG. An array or an atlas slot is never passed through: without its textures side,
 * it has no output.
 */

export type PipelineAsset = {
  type: 'texture' | 'importedAsset' | 'textureArray' | 'textureAtlas';
  /** An atlas slot's is its texture id, `<atlasId>.<slot>` */
  id: string;
  /** The asset JSON, relative to the repo root */
  jsonFile: string;
  /**
   * An array's is always an {@link ArraySource}, and only an array's is; the same for an atlas
   * slot and its {@link AtlasSlotSource}
   */
  source: AssetSource | PackSource | ArraySource | AtlasSlotSource;
  /** An atlas slot's is the slot's */
  optimize?: AssetOptimize;
  /** A texture (or an array, an atlas slot) whose `texOpts.colorSpace` is sRGB: its colour
   * channels are sRGB-encoded */
  isSrgb?: boolean;
  /**
   * An imported asset whose textures the runtime registers: `importTextures` in its JSON or in
   * a scene's latest entry that uses this file. Without it, an optimized GLB has no textures.
   */
  importTextures?: boolean;
  /**
   * An imported asset's LOD chain options (p347 Phase 3): the first use's that asks for one (its
   * JSON's own, then the scenes'). Its levels are built into the GLB.
   */
  lodChain?: ResolvedLodChainOptions;
  /** Another use asks for a chain with other options: the file has one chain, the first use's */
  hasLodChainConflict?: boolean;
};

/** How the cache (§7) answered: the output was there, was copied back from the store, or was encoded */
export type PipelineCacheStatus = 'hit' | 'restored' | 'miss';

export type PipelineOutcome =
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
      /** A GLB's LOD chains built into it (p347 Phase 3) */
      lodChains?: BuiltLodChain[];
      /** Worth a look, but not errors (eg. an aspect ratio changed by the rounding to 4) */
      warnings: string[];
      /** Unset without a cache */
      cache?: PipelineCacheStatus;
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
      /** A pack's PNG only: a copy is cheaper than its cache key */
      cache?: PipelineCacheStatus;
    }
  /** It needs `ktx`, and there is none (§8); nothing was written */
  | { status: 'encoderMissing'; reason: string; settings: ResolvedAssetSettings }
  | { status: 'skipped'; reason: string };

export type PipelineResult = PipelineOutcome & {
  /** Wall time, cache lookup included (the run's slowest assets, §5) */
  durationMs: number;
};

/** KTX2's UASTC / ETC1S are LDR formats: an HDR source keeps its own file. */
const HDR_EXTENSIONS = ['.hdr', '.exr'];

/** Already GPU-compressed: nothing to encode. */
const COMPRESSED_TEXTURE_EXTENSIONS = ['.ktx2', '.basis'];

const getPassThroughReason = (asset: PipelineAsset, settings: ResolvedAssetSettings) => {
  const { passThrough } = settings;
  if (asset.type === 'textureArray' || asset.type === 'textureAtlas') {
    return passThrough.textures ?? null;
  }
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
  /** The run's cache (§7); without one, nothing is cached and every call encodes */
  cache?: PipelineCache;
  /**
   * Only look the asset up, never encode or pack it: a cache miss is `skipped` (a plain
   * pass-through still runs, it's a copy). For the assets a partial run (`yarn assets --only`)
   * leaves out, so the generated data keeps their outputs.
   */
  lookupOnly?: boolean;
};

const NOT_BUILT_REASON = 'not built: outside this run (--only), and not in the cache';

type CacheKeyInput = Parameters<typeof getCacheKey>[0];

/** What a texture's encode reads: its file, or every file its pack reads */
const listTextureFiles = (source: Extract<AssetSource, { file: string }> | PackSource) =>
  source.kind === 'pack'
    ? listPackFiles(source.pack).map((src) => resolvePackFile(source.jsonFile, src))
    : [source.file];

/** What a GLB's encode reads: the file, and a .gltf's (or a .glb's) external buffers and images */
const listGLTFFiles = (file: string, json: GLTFJson) => [
  file,
  ...listExternalGLTFFiles(file, json),
];

/**
 * Every file an asset's encode reads: the file, every file a pack reads, a glTF with its
 * external files, or every file an array's layers (an atlas slot's cells) read. Empty for a
 * remote or missing source. Throws like `resolvePackFile` and `readGLTFJson`.
 */
export const listAssetSourceFiles = (asset: PipelineAsset) => {
  const { source } = asset;
  if (source.kind === 'remote') return [];
  if (source.kind === 'array') return listTextureArrayFiles(source);
  if (source.kind === 'atlas') return listTextureAtlasFiles(source);
  if (source.kind !== 'pack' && !fs.existsSync(source.file)) return [];
  return asset.type === 'importedAsset' && source.kind !== 'pack'
    ? listGLTFFiles(source.file, readGLTFJson(source.file))
    : listTextureFiles(source);
};

/**
 * The asset JSONs an asset is built from (absolute): its own and, for an array, its layers'
 * texture JSONs (their source or pack is the layer); for an atlas slot, its cells'.
 */
export const listAssetJsonFiles = (asset: PipelineAsset) => {
  const { source } = asset;
  const refs =
    source.kind === 'array'
      ? source.layers
      : source.kind === 'atlas'
        ? source.cells.flatMap((cell) => (cell.source ? [cell.source] : []))
        : [];
  return [
    path.resolve(ROOT, asset.jsonFile),
    ...refs.flatMap((ref) => (ref.texture ? [ref.texture.jsonFile] : [])),
  ];
};

/**
 * The bytes the runtime downloads without the pipeline: the file, every file a pack reads, a
 * glTF with its external files, or the files of an array's layers (an atlas slot's cells), each
 * once. Undefined for a remote or missing source.
 */
export const getSourceBytes = (asset: PipelineAsset) => {
  const files = new Set(listAssetSourceFiles(asset));
  if (!files.size) return undefined;
  return [...files].reduce(
    (sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0),
    0
  );
};

/** The entry a hit restores: the output and the result's metadata (the settings aren't kept). */
const toCacheEntry = (
  repoPath: string,
  result: Extract<PipelineOutcome, { status: 'optimized' | 'passThrough' }>,
  ktxVersion?: string
): CacheEntry => {
  const { url, bytes } = result.output;
  if (result.status === 'passThrough') return { source: repoPath, url, bytes };
  const { textures, droppedTextures, geometryBytes, lodChains, warnings } = result;
  return {
    source: repoPath,
    url,
    bytes,
    ...(textures.length ? { textures } : {}),
    ...(droppedTextures ? { droppedTextures } : {}),
    ...(geometryBytes ? { geometryBytes } : {}),
    ...(lodChains?.length ? { lodChains } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(ktxVersion ? { ktxVersion } : {}),
  };
};

const fromCacheEntry = ({ entry }: CacheHit) => ({
  output: { file: getOutputFile(entry.url), url: entry.url, bytes: entry.bytes },
  textures: entry.textures ?? [],
  ...(entry.droppedTextures !== undefined ? { droppedTextures: entry.droppedTextures } : {}),
  ...(entry.geometryBytes ? { geometryBytes: entry.geometryBytes } : {}),
  ...(entry.lodChains ? { lodChains: entry.lodChains } : {}),
  warnings: entry.warnings ?? [],
});

const getCacheStatus = (hit: CacheHit): PipelineCacheStatus =>
  hit.from === 'output' ? 'hit' : 'restored';

const runAsset = async (
  asset: PipelineAsset,
  resolveSettings: ReturnType<typeof createSettingsResolver>,
  opts: ProcessAssetOpts
): Promise<PipelineOutcome> => {
  const { source } = asset;
  const { cache } = opts;
  if (source.kind === 'remote') {
    return { status: 'skipped', reason: 'a remote file is loaded from where it is' };
  }
  let settings = resolveSettings({ sourcePath: source.repoPath, optimize: asset.optimize });
  const reason = getPassThroughReason(asset, settings);
  const isSrgb = !!asset.isSrgb;
  if (reason) {
    if (source.kind === 'array' || source.kind === 'atlas') {
      const what = source.kind === 'array' ? 'an array' : 'an atlas slot';
      return {
        status: 'skipped',
        reason: `${what} is only built as a KTX2 file, and textures are kept as they are: ${reason}`,
      };
    }
    if (source.kind !== 'pack') {
      const { isCopy, ...output } = passThroughSource(source);
      return { status: 'passThrough', reason, isCopy, output, settings };
    }
    const key =
      cache &&
      getCacheKey({
        type: 'texture',
        files: listTextureFiles(source),
        params: {
          kind: 'packPassThrough',
          pack: source.pack,
          isSrgb,
          output: getPackLogicalPath(source),
        },
      });
    const hit = key ? cache.get(key) : null;
    if (hit) {
      const { output } = fromCacheEntry(hit);
      return {
        status: 'passThrough',
        reason,
        isCopy: true,
        output,
        settings,
        cache: getCacheStatus(hit),
      };
    }
    if (opts.lookupOnly) return { status: 'skipped', reason: NOT_BUILT_REASON };
    const output = await passThroughPack(source, isSrgb);
    const result = { status: 'passThrough' as const, reason, isCopy: true, output, settings };
    if (key) cache.set(key, toCacheEntry(source.repoPath, result));
    return { ...result, ...(key ? { cache: 'miss' as const } : {}) };
  }
  // Only a public source can be missing (legacy, see `resolveAssetSource`): loaded as before
  if (source.kind === 'public' && !fs.existsSync(source.file)) {
    return { status: 'skipped', reason: `${source.repoPath} doesn't exist` };
  }

  // The settings are the cache key's: a GLB's collider default (DD6) is found before encoding
  let keyInput: CacheKeyInput;
  let slotSettings: ResolvedTextureSettings | undefined;
  let arraySettings: KtxSettings | undefined;
  if (source.kind === 'array' || source.kind === 'atlas') {
    // Not passed through, so its textures side is on
    arraySettings =
      getTextureArraySlotSettings(
        settings,
        source.kind === 'array' ? undefined : 'an atlas slot'
      ) ?? undefined;
    if (!arraySettings) throw new Error(`${asset.jsonFile}: no texture settings`);
    // A texture's tools: sharp reads the layers (the cells), ktx encodes them
    keyInput = {
      type: 'texture',
      files:
        source.kind === 'array' ? listTextureArrayFiles(source) : listTextureAtlasFiles(source),
      params:
        source.kind === 'array'
          ? {
              kind: 'textureArray',
              slot: settings.slot,
              settings: arraySettings,
              isSrgb,
              ...getTextureArrayKeyParams(source),
            }
          : {
              kind: 'textureAtlas',
              slot: settings.slot,
              settings: arraySettings,
              isSrgb,
              ...getTextureAtlasKeyParams(source),
            },
    };
  } else if (asset.type === 'texture') {
    // Not passed through, so its textures side is on
    slotSettings = (settings.textures && settings.textures[settings.slot]) || undefined;
    if (!slotSettings) throw new Error(`${asset.jsonFile}: no texture settings`);
    keyInput = {
      type: 'texture',
      files: listTextureFiles(source),
      params: {
        kind: 'texture',
        slot: settings.slot,
        settings: slotSettings,
        isSrgb,
        ...(source.kind === 'pack'
          ? { pack: source.pack, output: getPackLogicalPath(source) }
          : { output: getLogicalPath(source) }),
      },
    };
  } else {
    if (source.kind === 'pack') throw new Error('an imported asset has no pack');
    const json = readGLTFJson(source.file);
    if (hasColliderNodes(json)) {
      settings = resolveSettings({
        sourcePath: source.repoPath,
        optimize: asset.optimize,
        isColliderSource: true,
      });
    }
    const importTextures = !!asset.importTextures;
    // Only built with the mesh side on (else the runtime generates the chains), and only in the
    // key when set: the keys of the assets without one don't change. The simplifier is engine
    // code and the format is what the runtime reads, so both versions are in it too.
    const lodChain = settings.mesh ? asset.lodChain : undefined;
    keyInput = {
      type: 'importedAsset',
      files: listGLTFFiles(source.file, json),
      params: {
        kind: 'gltf',
        importTextures,
        // Without importTextures the textures are dropped, whatever their settings
        textures: importTextures ? settings.textures : null,
        mesh: settings.mesh,
        ...(lodChain
          ? {
              lodChain: {
                options: lodChain,
                simplifier: LOD_SIMPLIFY_VERSION,
                format: GLTF_LOD_FORMAT_VERSION,
              },
            }
          : {}),
        output: getLogicalPath(source),
      },
    };
  }
  const key = cache && getCacheKey(keyInput);
  const hit = key ? cache.get(key) : null;
  if (hit) {
    return { status: 'optimized', settings, ...fromCacheEntry(hit), cache: getCacheStatus(hit) };
  }
  if (opts.lookupOnly) return { status: 'skipped', reason: NOT_BUILT_REASON };

  const getKtx = opts.getKtx ?? createKtxProvider();
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  let result: Extract<PipelineOutcome, { status: 'optimized' }>;
  try {
    if (source.kind === 'array') {
      if (!arraySettings) throw new Error(`${asset.jsonFile}: no texture settings`);
      const { output, texture } = await encodeTextureArray(source, settings.slot, arraySettings, {
        isSrgb,
        getKtx,
        warn,
      });
      result = { status: 'optimized', output, settings, textures: [texture], warnings };
    } else if (source.kind === 'atlas') {
      if (!arraySettings) throw new Error(`${asset.jsonFile}: no texture settings`);
      const { output, texture } = await encodeTextureAtlasSlot(
        source,
        settings.slot,
        arraySettings,
        { isSrgb, getKtx, warn }
      );
      result = { status: 'optimized', output, settings, textures: [texture], warnings };
    } else if (slotSettings) {
      const { output, texture } = await encodeTextureAsset(source, settings.slot, slotSettings, {
        isSrgb,
        getKtx,
        warn,
      });
      result = { status: 'optimized', output, settings, textures: [texture], warnings };
    } else {
      if (source.kind === 'pack') throw new Error('an imported asset has no pack');
      // Loaded on first use: gltf-transform and the meshopt / Draco WASM codecs
      const { encodeGLTFAsset } = await import('./gltf');
      const encoded = await encodeGLTFAsset(source, settings, {
        importTextures: !!asset.importTextures,
        lodChain: settings.mesh ? asset.lodChain : undefined,
        getKtx,
        warn,
      });
      result = { status: 'optimized', ...encoded, settings, warnings };
    }
  } catch (error) {
    if (error instanceof EncoderMissingError) {
      return { status: 'encoderMissing', reason: error.message, settings };
    }
    throw error;
  }

  // The key has the pinned ktx; an encode by another version may differ from everyone else's
  let ktxVersion: string | undefined;
  if (result.textures.some((texture) => texture.codec !== 'none')) {
    ktxVersion = (await getKtx()).version;
    if (ktxVersion !== KTX_VERSION) {
      warn(
        `encoded with ktx ${ktxVersion}, not the pinned ${KTX_VERSION} (yarn setupAssetTools): its KTX2 may differ from other machines' encodes`
      );
    }
  }
  if (!key) return result;
  cache.set(key, toCacheEntry(source.repoPath, result, ktxVersion));
  return { ...result, cache: 'miss' };
};

/**
 * Passes an asset through, or optimizes it: from the cache when it has the output (§7), else by
 * encoding it (and caching the output). Throws when a pass-through can't copy its source (see
 * `passThroughSource`), a pack can't be built (see `buildPackedImage`), a source can't be read or
 * `ktx create` fails.
 */
export const processAsset = async (
  asset: PipelineAsset,
  resolveSettings: ReturnType<typeof createSettingsResolver>,
  opts: ProcessAssetOpts = {}
): Promise<PipelineResult> => {
  const start = performance.now();
  const outcome = await runAsset(asset, resolveSettings, opts);
  // Not cached: they're about the uses, not the encode
  if (outcome.status === 'optimized' && asset.lodChain) {
    const warnings: string[] = [];
    if (!outcome.settings.mesh) {
      warnings.push(
        `lodChain: the geometry is kept as it is (${outcome.settings.passThrough.mesh}), so its LOD chains are generated at runtime`
      );
    }
    if (asset.hasLodChainConflict) {
      warnings.push(
        "lodChain: the uses of this file ask for different options, and the file has one chain: the first use's (the JSON's own, then the scenes')"
      );
    }
    if (warnings.length) outcome.warnings = [...outcome.warnings, ...warnings];
  }
  return { ...outcome, durationMs: Math.round(performance.now() - start) };
};
