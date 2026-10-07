import fs from 'fs/promises';
import path from 'path';
import { ROOT } from '../assetPipeline/sources';
import { DevFilesError } from './http';

/**
 * The path policy (p342 §2.3): a path is repo-relative and `/`-separated, inside one of the roots
 * and none of the denied folders, with an image or JSON extension (never code: Vite would run a
 * written `.ts`), no dot segment and no `node_modules`. Its nearest existing folder's real path
 * must still be inside the root (no symlink out), and an existing target must be a plain file.
 */

export const DEV_FILES_ROOTS = ['src/app/', 'src/toolkit/', 'src/public/'];
/** The asset pipeline's outputs, and the decoders `copyDecoders` copies from three.js */
export const DEV_FILES_DENIED_ROOTS = [
  'src/public/aek-assets/',
  'src/public/draco/',
  'src/public/basis/',
];
export const DEV_FILES_EXTENSIONS = ['.json', '.png', '.jpg', '.jpeg', '.webp'];

export type DevFilePath = {
  /** Repo-relative, `/`-separated */
  repoPath: string;
  absPath: string;
  isJson: boolean;
};

const forbid = (repoPath: string, reason: string): never => {
  throw new DevFilesError('FORBIDDEN_PATH', `${repoPath}: ${reason}`, { path: repoPath });
};

const isInside = (dir: string, file: string) => file === dir || file.startsWith(dir + path.sep);

const toAbs = (repoPath: string) => path.join(ROOT, ...repoPath.split('/').filter(Boolean));

/** The nearest folder of `absPath` that exists, its own path included */
const findExistingAncestor = async (absPath: string): Promise<string> => {
  let dir = absPath;
  for (;;) {
    try {
      await fs.lstat(dir);
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return dir;
      dir = parent;
    }
  }
};

/** The path's checks without the file system (the extension, segments and roots) */
const checkPathString = (input: unknown) => {
  if (typeof input !== 'string' || !input) {
    throw new DevFilesError('BAD_REQUEST', 'A path must be a non-empty string');
  }
  if (input.includes('\\') || input.includes('\0')) forbid(input, 'only "/" separates folders');
  if (input.startsWith('/') || /^[a-z]:/i.test(input)) forbid(input, 'it must be repo-relative');
  const segments = input.split('/');
  if (segments.some((segment) => !segment)) forbid(input, 'it has an empty segment');
  if (segments.some((segment) => segment.startsWith('.'))) {
    forbid(input, 'no ".", ".." or dot folder or file');
  }
  if (segments.includes('node_modules')) forbid(input, 'nothing in node_modules');
  const root = DEV_FILES_ROOTS.find((dir) => input.startsWith(dir));
  if (!root) forbid(input, `it must be in ${DEV_FILES_ROOTS.join(', ')}`);
  const denied = DEV_FILES_DENIED_ROOTS.find((dir) => input.startsWith(dir));
  if (denied) forbid(input, `nothing in ${denied}`);
  const ext = path.posix.extname(input).toLowerCase();
  if (!DEV_FILES_EXTENSIONS.includes(ext)) {
    forbid(input, `the extension must be one of ${DEV_FILES_EXTENSIONS.join(', ')}`);
  }
  return { repoPath: input, root: root as string, isJson: ext === '.json' };
};

/** Resolves a path a route got, or throws FORBIDDEN_PATH (BAD_REQUEST when it isn't a string) */
export const resolveDevFilePath = async (input: unknown): Promise<DevFilePath> => {
  const { repoPath, root, isJson } = checkPathString(input);
  const absPath = toAbs(repoPath);

  // Symlinks: the nearest existing folder must really be inside the root, outside the denied ones
  const rootReal = await fs.realpath(toAbs(root)).catch(() => toAbs(root));
  const ancestor = await findExistingAncestor(path.dirname(absPath));
  const ancestorReal = await fs.realpath(ancestor);
  if (!isInside(rootReal, ancestorReal)) forbid(repoPath, `its folder leads out of ${root}`);
  for (const denied of DEV_FILES_DENIED_ROOTS) {
    const deniedReal = await fs.realpath(toAbs(denied)).catch(() => null);
    if (deniedReal && isInside(deniedReal, ancestorReal))
      forbid(repoPath, `it leads into ${denied}`);
  }

  const stat = await fs.lstat(absPath).catch(() => null);
  if (stat?.isSymbolicLink()) forbid(repoPath, 'it is a symlink');
  if (stat && !stat.isFile()) forbid(repoPath, 'it is not a file');
  return { repoPath, absPath, isJson };
};
