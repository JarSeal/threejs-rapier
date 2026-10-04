import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { PUBLIC_DIR, SRC_DIR, type AssetSource, type PackSource } from './sources';

/**
 * The pipeline's outputs (p300 DD3): `src/public/aek-assets/<logical path>.<content hash>.<ext>`,
 * served at `/aek-assets/…`. Committed, so a clone runs without the encoder. A name never
 * changes its content, so it can be cached forever and is only written once.
 */

export const AEK_ASSETS_DIR = path.join(PUBLIC_DIR, 'aek-assets');

const toPosix = (filePath: string) => filePath.split(path.sep).join('/');

/** The first 8 hex digits of the SHA-256: unique enough within one logical path */
export const getContentHash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 8);

/**
 * Where a source's outputs go inside `aek-assets/`, without the hash and extension: its path
 * under `src/` (under `src/public/` for a public one), eg. 'app/textures/source/rock'.
 */
export const getLogicalPath = (source: Extract<AssetSource, { file: string }>) => {
  const base = source.kind === 'public' ? PUBLIC_DIR : SRC_DIR;
  const relative = toPosix(path.relative(base, source.file));
  return relative.slice(0, relative.length - path.extname(relative).length);
};

/** A packed texture's logical path: its JSON's, eg. 'app/textures/rock.pack' for rock.texture.json */
export const getPackLogicalPath = (source: PackSource) =>
  `${toPosix(path.relative(SRC_DIR, source.jsonFile)).replace(/(\.[^./]+)?\.json$/, '')}.pack`;

export type PipelineOutput = {
  /** Absolute path on disk */
  file: string;
  /** Root-absolute URL, what the runtime loads */
  url: string;
  bytes: number;
};

/** Writes an output unless it exists (same name, same content). Atomic: temp file + rename. */
export const writeOutput = (
  logicalPath: string,
  ext: string,
  bytes: Uint8Array
): PipelineOutput => {
  const fileName = `${logicalPath}.${getContentHash(bytes)}${ext}`;
  const file = path.join(AEK_ASSETS_DIR, fileName);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, bytes);
    fs.renameSync(tempFile, file);
  }
  return { file, url: `/${toPosix(path.relative(PUBLIC_DIR, file))}`, bytes: bytes.byteLength };
};

/** A .gltf's buffers and images that are separate files: a copy of the .gltf alone loses them. */
const getExternalGLTFUris = (file: string) => {
  const gltf = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
  };
  return [...(gltf.buffers ?? []), ...(gltf.images ?? [])]
    .map((entry) => entry.uri)
    .filter((uri): uri is string => !!uri && !uri.startsWith('data:'));
};

/**
 * Passes a source through as it is (DD8): a relative one is copied, content-hashed, into
 * `aek-assets/` (the production build doesn't ship `src/`); a public one is already served, so
 * its own URL is the output. Throws for a missing relative source and for a relative .gltf with
 * external files.
 */
export const passThroughSource = (
  source: Extract<AssetSource, { file: string }>
): PipelineOutput & { isCopy: boolean } => {
  if (source.kind === 'public') {
    const bytes = fs.existsSync(source.file) ? fs.statSync(source.file).size : 0;
    const url = `/${toPosix(path.relative(PUBLIC_DIR, source.file))}`;
    return { file: source.file, url, bytes, isCopy: false };
  }
  const ext = path.extname(source.file);
  if (ext.toLowerCase() === '.gltf') {
    const uris = getExternalGLTFUris(source.file);
    if (uris.length) {
      throw new Error(
        `${source.repoPath} refers to external files (${uris.join(', ')}), which a copy would lose: export it as a .glb, or optimize it`
      );
    }
  }
  return {
    ...writeOutput(getLogicalPath(source), ext, fs.readFileSync(source.file)),
    isCopy: true,
  };
};
