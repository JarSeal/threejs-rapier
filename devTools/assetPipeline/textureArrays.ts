import path from 'path';
import fs from 'fs';
import type { TextureAsset } from '../../src/_engine/schemas/textureSchema';
import { isTextureArrayLayerFile } from '../../src/_engine/schemas/textureArraySchema';
import {
  createPackSource,
  resolveAssetSource,
  toRepoPath,
  type AssetSource,
  type PackSource,
} from './sources';

/**
 * Build-time texture arrays (p299 D2): a `*.textureArray.json`'s layers resolved to what the
 * pipeline reads. A layer is a texture asset's source (its file, or its pack recipe; never its
 * output, and never a scene's override of it) or a source file of the array's own.
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

/**
 * Resolves an array's layers. Every problem is in `errors`, each naming its layer: a file that
 * doesn't resolve or can't be read as an image, an unknown texture id, a texture without a file
 * or pack (or a cube texture), and two layers with the same name.
 * @param jsonFile The array's JSON, absolute or relative to the repo root
 */
export const resolveTextureArrayLayers = (
  jsonFile: string,
  layers: string[],
  findTexture: TextureLookup
): { layers: TextureArrayLayer[]; errors: string[] } => {
  const resolved: TextureArrayLayer[] = [];
  const errors: string[] = [];
  const keys = new Map<string, number>();

  layers.forEach((layer, index) => {
    const label = `layers[${index}] ("${layer}")`;
    let entry: TextureArrayLayer | string;
    if (isTextureArrayLayerFile(layer)) {
      const source = resolveFileLayer(jsonFile, layer);
      entry =
        typeof source === 'string'
          ? source
          : { key: path.basename(layer, path.extname(layer)), source };
    } else if (/^[a-z][a-z\d+.-]*:/i.test(layer)) {
      entry = "a remote file isn't read: a layer is a texture id or a local file";
    } else {
      entry = resolveTextureLayer(layer, findTexture);
    }
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
