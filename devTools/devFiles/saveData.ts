import fs from 'fs/promises';
import path from 'path';
import { ROOT } from '../assetPipeline/sources';
import { hasGatheredSaveData } from '../gatherAppData';
import { DevFilesError } from './http';
import type { DevFilePath } from './paths';
import { sha256 } from './stage';
import type {
  DevFilesSaveDataWrite,
  DevFilesSchemaIssues,
} from '../../src/_engine/debug/DevFilesProtocol';

/**
 * A commit's save entry write (p342 §2.6): `{ path, saveData: { sceneId, entry, historySize } }`
 * reads the asset JSON, puts `entry` first in its `__saveData[sceneId]` (the older entries after
 * it; the gatherer applies only the first) and stamps the entry's `__meta` with the three part
 * versions from `package.json` and, unless the entry has one, the date. The scene's list then
 * keeps its first `historySize` entries (-1: all; 0, saving off, is refused); the other scenes'
 * lists are left as they are. The commit validates and formats the result like any JSON write.
 * An entry equal to the scene's latest one (`__meta` aside) leaves the file `unchanged`, unless
 * the list is longer than `historySize`: then it's only trimmed.
 */

type JsonObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Throws BAD_REQUEST unless the write's `saveData` is `{ sceneId, entry }` */
export const checkSaveDataRequest = (writePath: string, saveData: unknown) => {
  if (!isPlainObject(saveData)) {
    throw new DevFilesError('BAD_REQUEST', `${writePath}: saveData must be { sceneId, entry }`);
  }
  if (typeof saveData.sceneId !== 'string' || !saveData.sceneId) {
    throw new DevFilesError('BAD_REQUEST', `${writePath}: saveData.sceneId must be a string`);
  }
  if (!isPlainObject(saveData.entry)) {
    throw new DevFilesError('BAD_REQUEST', `${writePath}: saveData.entry must be an object`);
  }
  if ('__meta' in saveData.entry && !isPlainObject(saveData.entry.__meta)) {
    throw new DevFilesError('BAD_REQUEST', `${writePath}: saveData.entry.__meta must be an object`);
  }
  const { historySize } = saveData;
  if (typeof historySize !== 'number' || !Number.isInteger(historySize) || historySize < -1) {
    throw new DevFilesError(
      'BAD_REQUEST',
      `${writePath}: saveData.historySize must be an integer, -1 (all) or more`
    );
  }
  if (historySize === 0) {
    throw new DevFilesError('SAVE_DATA_DISABLED', `${writePath}: saving is off (history size 0)`);
  }
  return saveData as DevFilesSaveDataWrite;
};

/** Read on every write, so a version bump while `yarn dev` runs is stamped at once */
const readPartVersions = async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf-8')) as {
    engine_metadata: { version: string };
    toolkit_metadata: { version: string };
    app_metadata: { version: string };
  };
  return {
    engineVersion: pkg.engine_metadata.version,
    toolkitVersion: pkg.toolkit_metadata.version,
    appVersion: pkg.app_metadata.version,
  };
};

/** JSON with every object's keys sorted: equal for equal values whatever their key order */
const canonicalJson = (value: unknown) =>
  JSON.stringify(value, (_key, nested: unknown) =>
    isPlainObject(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested
  );

const withoutMeta = (entry: unknown) => {
  if (!isPlainObject(entry)) return entry;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { __meta, ...rest } = entry;
  return rest;
};

const invalidFile = (repoPath: string, issuePath: string, message: string): never => {
  const details: DevFilesSchemaIssues = [
    { path: repoPath, issues: [{ path: issuePath, message }] },
  ];
  throw new DevFilesError('INVALID_SCHEMA', `Invalid ${repoPath}`, details);
};

export type SaveDataWriteResult =
  /** The file's new JSON value */
  | { json: JsonObject; currentHash: string }
  /** The entry is the scene's latest already: the file stays as it is */
  | { unchanged: Buffer; currentHash: string };

export const applySaveDataWrite = async (
  target: DevFilePath,
  saveData: DevFilesSaveDataWrite
): Promise<SaveDataWriteResult> => {
  const { repoPath } = target;
  if (!target.isJson || !hasGatheredSaveData(repoPath)) {
    throw new DevFilesError(
      'BAD_REQUEST',
      `${repoPath}: only a gathered asset JSON with __saveData takes a save entry`
    );
  }
  let current: Buffer;
  try {
    current = await fs.readFile(target.absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DevFilesError('NOT_FOUND', `${repoPath} doesn't exist`, { path: repoPath });
    }
    throw err;
  }
  const currentHash = sha256(current);
  let file: unknown;
  try {
    file = JSON.parse(current.toString('utf-8'));
  } catch (err) {
    throw new DevFilesError('INVALID_JSON', `${repoPath} isn't JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(file)) return invalidFile(repoPath, '', 'The file must be an object');
  const { sceneId, entry, historySize } = saveData;
  const keep = (list: unknown[]) => (historySize === -1 ? list : list.slice(0, historySize));
  if (file.__saveData !== undefined && !isPlainObject(file.__saveData)) {
    invalidFile(repoPath, '__saveData', 'Must be an object');
  }
  const allSaveData = (file.__saveData ?? {}) as JsonObject;
  const entries = allSaveData[sceneId] ?? [];
  if (!Array.isArray(entries)) {
    return invalidFile(repoPath, `__saveData.${sceneId}`, 'Must be a list');
  }

  if (
    entries.length &&
    canonicalJson(withoutMeta(entries[0])) === canonicalJson(withoutMeta(entry))
  ) {
    if (keep(entries).length === entries.length) return { unchanged: current, currentHash };
    // The same entry under a smaller history size: only the trim
    allSaveData[sceneId] = keep(entries);
    return { json: file, currentHash };
  }

  const { __meta, ...overrides } = entry;
  const meta = (__meta ?? {}) as JsonObject;
  const stamped = {
    __meta: { ...meta, date: meta.date ?? Date.now(), ...(await readPartVersions()) },
    ...overrides,
  };
  // In place: an existing `__saveData` and scene keep their places in the file
  allSaveData[sceneId] = keep([stamped, ...entries]);
  file.__saveData = allSaveData;
  return { json: file, currentHash };
};
