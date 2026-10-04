import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isJsonRelativeFileName } from '../../src/_engine/schemas/assetsConfigSchema';

/**
 * Where an asset JSON's `fileName` points (p300 DD3):
 * - `relative`: `./` or `../`, relative to the JSON file. Must stay inside `src/` (the Vite root),
 *   so the dev server can serve it as a source (DD8 level 3).
 * - `public`: a URL path served from `src/public` (after the texture's `path`), resolved the way
 *   the runtime's loaders resolve it. The file may be missing (legacy: no error).
 * - `remote`: a URL with a scheme (or `//host`). Never optimized.
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SRC_DIR = path.join(ROOT, 'src');
export const PUBLIC_DIR = path.join(SRC_DIR, 'public');

export type AssetSource =
  | {
      kind: 'relative' | 'public';
      /** Absolute path on disk */
      file: string;
      /** '/'-separated, relative to the repo root: what config rule globs match */
      repoPath: string;
    }
  | { kind: 'remote'; url: string };

export const toRepoPath = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

const isRemoteUrl = (fileName: string) => /^([a-z][a-z\d+.-]*:|\/\/)/i.test(fileName);

/**
 * Resolves an asset JSON's `fileName` (and a texture's `path`). Returns `{ error }` for a relative
 * file name that is combined with `path`, leaves `src/` or doesn't exist.
 * @param jsonFile The asset JSON, absolute or relative to the repo root
 */
export const resolveAssetSource = (params: {
  jsonFile: string;
  fileName: string;
  path?: string;
}): AssetSource | { error: string } => {
  const { fileName, path: urlPath } = params;
  if (isJsonRelativeFileName(fileName)) {
    if (urlPath) {
      return {
        error: `"path" can't be combined with a file name relative to the JSON ("${fileName}")`,
      };
    }
    const file = path.resolve(ROOT, path.dirname(params.jsonFile), fileName);
    if (!file.startsWith(SRC_DIR + path.sep)) {
      return {
        error: `"${fileName}" resolves outside src/ (${toRepoPath(file)}), which the dev server doesn't serve`,
      };
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return { error: `source file "${fileName}" not found (expected at ${toRepoPath(file)})` };
    }
    return { kind: 'relative', file, repoPath: toRepoPath(file) };
  }

  if (isRemoteUrl(fileName) || isRemoteUrl(urlPath || '')) return { kind: 'remote', url: fileName };

  // Like `new URL((path || './') + fileName, document.baseURI)` at the site root (Texture.ts)
  const { pathname } = new URL((urlPath || './') + fileName, 'http://aek.local/');
  const file = path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  return { kind: 'public', file, repoPath: toRepoPath(file) };
};

/** Bytes on disk, or undefined for a remote or missing file */
export const getAssetSourceFileSize = (source: AssetSource) =>
  'file' in source && fs.existsSync(source.file) ? fs.statSync(source.file).size : undefined;
