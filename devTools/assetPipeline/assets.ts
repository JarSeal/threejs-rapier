import fs from 'fs';
import path from 'path';
import { TextureAssetSchema, type TextureAsset } from '../../src/_engine/schemas/textureSchema';
import {
  ImportedAssetSchema,
  type ImportedAsset,
} from '../../src/_engine/schemas/importedAssetSchema';
import {
  TextureArrayAssetSchema,
  type TextureArrayAsset,
} from '../../src/_engine/schemas/textureArraySchema';
import {
  resolveLodChainOptions,
  type ResolvedLodChainOptions,
} from '../../src/_engine/core/Lod/LodChainOptions';
import type { PipelineAsset } from './pipeline';
import { createArraySource, resolveTextureArrayLayers, type TextureLookup } from './textureArrays';
import {
  createPackSource,
  resolveAssetSource,
  ROOT,
  SRC_DIR,
  toRepoPath,
  type AssetSource,
  type PackSource,
} from './sources';

/**
 * The pipeline's asset list (p300 Phase 2 step 7): every source file a `*.texture.json` or
 * `*.importedAsset.json` loads, its own and each scene's latest save entry's (step 2's decision:
 * a scene's file is optimized with the asset's one `optimize`), and every `*.textureArray.json`
 * (p299 D2). One {@link PipelineAsset} per distinct encode, and a key both the run and the
 * gatherer compute the same way, so the gatherer finds each scene entry's output.
 */

export type PipelineAssetType = PipelineAsset['type'];

/** What decides an asset's source and encode: the JSON's keys, with a scene's entry merged over */
type AssetData = {
  fileName?: string;
  path?: string;
  pack?: TextureAsset['pack'];
  texOpts?: TextureAsset['texOpts'];
  importTextures?: ImportedAsset['importTextures'];
  lodChain?: ImportedAsset['lodChain'];
  __saveData?: Record<string, object[] | undefined>;
};

/** One use of an asset: the JSON as it is, or merged with a scene's latest save entry. */
type AssetUse = {
  source: AssetSource | PackSource;
  isSrgb: boolean;
  importTextures: boolean;
  /** An imported asset's `lodChain`, resolved (p347 Phase 3) */
  lodChain: ResolvedLodChainOptions | null;
};

/**
 * The source and the encode inputs of an asset's data, as the gatherer merges it for a scene
 * (`{ ...asset, ...latestEntry }`, shallow: an entry's `texOpts` replaces the JSON's). Returns
 * `{ error }` like `resolveAssetSource`, or null when there's no file at all.
 * @param jsonFile The asset JSON, absolute or relative to the repo root
 */
export const resolveAssetUse = (
  jsonFile: string,
  data: AssetData
): AssetUse | { error: string } | null => {
  const isSrgb = data.texOpts?.colorSpace === 'srgb';
  const importTextures = !!data.importTextures;
  const lodChain = data.lodChain
    ? resolveLodChainOptions(data.lodChain === true ? undefined : data.lodChain)
    : null;
  if (data.pack) {
    return { source: createPackSource(jsonFile, data.pack), isSrgb, importTextures, lodChain };
  }
  if (!data.fileName) return null;
  const source = resolveAssetSource({ jsonFile, fileName: data.fileName, path: data.path });
  return 'error' in source ? source : { source, isSrgb, importTextures, lodChain };
};

/**
 * The key of an encode: the JSON (its `optimize` applies), the source and, for a texture, its
 * colour space. A GLB's `importTextures` and `lodChain` aren't part of it: every use of a file
 * shares one output, with its textures when any use imports them (step 5), and with LOD chains
 * when any use asks for them (p347 Phase 3, the first use's options).
 */
export const getPipelineAssetKey = (type: PipelineAssetType, jsonFile: string, use: AssetUse) => {
  const source = use.source.kind === 'remote' ? use.source.url : use.source.repoPath;
  const kind = use.source.kind === 'pack' ? 'pack' : 'file';
  const colorSpace = type === 'texture' ? (use.isSrgb ? ':srgb' : ':linear') : '';
  return `${type}:${toRepoPath(path.resolve(ROOT, jsonFile))}:${kind}:${source}${colorSpace}`;
};

/** The asset's own data and each scene's latest save entry merged over it */
const listAssetUses = (data: AssetData) => [
  data,
  ...Object.values(data.__saveData ?? {}).flatMap((entries) =>
    entries?.[0] ? [{ ...data, ...entries[0] }] : []
  ),
];

/**
 * A texture array's key (p299 D2): its JSON. It has one use, with no scene entries.
 * @param jsonFile The array's JSON, absolute or relative to the repo root
 */
export const getTextureArrayAssetKey = (jsonFile: string) =>
  `textureArray:${toRepoPath(path.resolve(ROOT, jsonFile))}`;

type AssetJsonBase = {
  id: string;
  /** Absolute */
  jsonFile: string;
};

export type AssetJson =
  | (AssetJsonBase & { type: 'texture'; data: TextureAsset })
  | (AssetJsonBase & { type: 'importedAsset'; data: ImportedAsset })
  | (AssetJsonBase & { type: 'textureArray'; data: TextureArrayAsset });

const ASSET_SCHEMAS = {
  texture: { suffix: '.texture.json', schema: TextureAssetSchema },
  importedAsset: { suffix: '.importedAsset.json', schema: ImportedAssetSchema },
  textureArray: { suffix: '.textureArray.json', schema: TextureArrayAssetSchema },
} as const;

/**
 * Reads every `*.texture.json`, `*.importedAsset.json` and `*.textureArray.json` under `src/`.
 * An invalid one is skipped: the gatherer reports it.
 */
export const readAssetJsons = (srcDir = SRC_DIR): AssetJson[] => {
  const files = fs
    .readdirSync(srcDir, { recursive: true })
    .filter((file): file is string => typeof file === 'string')
    .sort();
  const assets: AssetJson[] = [];
  for (const type of ['texture', 'importedAsset', 'textureArray'] as const) {
    const { suffix, schema } = ASSET_SCHEMAS[type];
    for (const file of files.filter((f) => f.endsWith(suffix))) {
      const jsonFile = path.join(srcDir, file);
      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
      } catch {
        continue;
      }
      const validation = schema.safeParse(json);
      if (!validation.success) continue;
      const data = validation.data;
      const id = data.id || path.basename(file, suffix);
      assets.push({ type, id, jsonFile, data } as AssetJson);
    }
  }
  return assets;
};

/** An array's encode, or null when its layers don't resolve (the gatherer reports it) */
const collectTextureArray = (
  { id, jsonFile, data }: Extract<AssetJson, { type: 'textureArray' }>,
  findTexture: TextureLookup
): PipelineAsset | null => {
  const isSrgb = data.texOpts?.colorSpace === 'srgb';
  const { layers, errors } = resolveTextureArrayLayers(jsonFile, data.layers, findTexture, {
    isSrgb,
  });
  if (errors.length) return null;
  return {
    type: 'textureArray',
    id,
    jsonFile: toRepoPath(jsonFile),
    source: createArraySource(jsonFile, layers, data.size),
    ...(data.optimize !== undefined ? { optimize: data.optimize } : {}),
    isSrgb,
  };
};

/**
 * Every encode the asset JSONs need, one per key ({@link getPipelineAssetKey},
 * {@link getTextureArrayAssetKey}). A use whose source doesn't resolve is left out (the gatherer
 * reports it).
 */
export const collectPipelineAssets = (assetJsons: AssetJson[]) => {
  const assets = new Map<string, PipelineAsset>();
  const textures = new Map(
    assetJsons.flatMap((asset) => (asset.type === 'texture' ? [[asset.id, asset] as const] : []))
  );
  const findTexture: TextureLookup = (id) => textures.get(id);
  for (const assetJson of assetJsons) {
    if (assetJson.type === 'textureArray') {
      const asset = collectTextureArray(assetJson, findTexture);
      if (asset) assets.set(getTextureArrayAssetKey(assetJson.jsonFile), asset);
      continue;
    }
    const { type, id, jsonFile, data } = assetJson;
    for (const useData of listAssetUses(data)) {
      const use = resolveAssetUse(jsonFile, useData);
      if (!use || 'error' in use) continue;
      const key = getPipelineAssetKey(type, jsonFile, use);
      const existing = assets.get(key);
      if (existing) {
        if (use.importTextures) existing.importTextures = true;
        if (use.lodChain && !existing.lodChain) {
          existing.lodChain = use.lodChain;
        } else if (
          use.lodChain &&
          JSON.stringify(use.lodChain) !== JSON.stringify(existing.lodChain)
        ) {
          existing.hasLodChainConflict = true;
        }
        continue;
      }
      assets.set(key, {
        type,
        id,
        jsonFile: toRepoPath(jsonFile),
        source: use.source,
        ...(data.optimize !== undefined ? { optimize: data.optimize } : {}),
        ...(type === 'texture'
          ? { isSrgb: use.isSrgb }
          : {
              importTextures: use.importTextures,
              ...(use.lodChain ? { lodChain: use.lodChain } : {}),
            }),
      });
    }
  }
  return assets;
};
