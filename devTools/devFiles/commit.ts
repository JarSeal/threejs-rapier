import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { format, resolveConfig } from 'prettier';
import { validateGatheredJson } from '../gatherAppData';
import { DevFilesError } from './http';
import { resolveDevFilePath, type DevFilePath } from './paths';
import { applySaveDataWrite, checkSaveDataRequest } from './saveData';
import type {
  DevFilesCommitBody,
  DevFilesConflicts,
  DevFilesSaveDataWrite,
  DevFilesSchemaIssues,
  DevFilesWriteStatus,
} from '../../src/_engine/debug/DevFilesProtocol';
import { DEV_FILES_CACHE_DIR, sha256, type DevFilesStage } from './stage';

/**
 * `POST commit` (p342 §2.3): a batch of writes that all land or none does.
 * 1. Every write is checked before anything is written: its path, its content (a JSON value is
 *    validated against its gathered schema and formatted with Prettier; a staged file must not
 *    have expired; a save entry is put into the file's JSON, `devFiles/saveData.ts`, which is
 *    then a JSON value), the sizes and the `expectedHash`es. A write whose bytes equal the
 *    file's is `unchanged` and isn't written (no file event, no gather).
 * 2. Each write goes to a temporary file next to its target, then each existing target is copied
 *    to `.cache/dev-files/backup/<commit>/`, then the temporaries are renamed into place. A
 *    failure before the renames removes the temporaries and the folders the batch created; one
 *    during them also restores the renamed targets from the backups (or removes the new ones).
 * The backups of the last BACKUPS_KEPT commits are kept, for undoing a write by hand.
 */

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_BATCH_BYTES = 128 * 1024 * 1024;
const BACKUP_DIR = path.join(DEV_FILES_CACHE_DIR, 'backup');
const BACKUPS_KEPT = 20;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Test faults (`AEK_DEV_FILES_FAULTS=true`, the self-check): the rename at this index throws */
export type CommitFaults = { failRenameAt?: number };

type PlannedWrite = {
  target: DevFilePath;
  data: Buffer;
  sha256: string;
  /** The file on disk now, null when there is none */
  currentHash: string | null;
  status: DevFilesWriteStatus;
  stageId?: string;
};

type RequestedWrite = {
  path: string;
  expectedHash?: string | null;
  json?: unknown;
  hasJson: boolean;
  stageId?: string;
  saveData?: DevFilesSaveDataWrite;
};

const badRequest = (message: string): never => {
  throw new DevFilesError('BAD_REQUEST', message);
};

const parseRequest = (body: unknown): RequestedWrite[] => {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { writes?: unknown }).writes)) {
    badRequest('The body must be { writes: [...] }');
  }
  const writes = (body as { writes: unknown[] }).writes;
  if (!writes.length) badRequest('The batch has no writes');
  const paths = new Set<string>();
  return writes.map((write, index) => {
    if (!write || typeof write !== 'object') badRequest(`Write ${index} isn't an object`);
    const w = write as Record<string, unknown>;
    if (typeof w.path !== 'string') badRequest(`Write ${index} has no path`);
    const writePath = w.path as string;
    if (paths.has(writePath)) badRequest(`${writePath} is in the batch twice`);
    paths.add(writePath);
    const hasJson = 'json' in w;
    const hasStage = 'stageId' in w;
    const hasSaveData = 'saveData' in w;
    if (Number(hasJson) + Number(hasStage) + Number(hasSaveData) !== 1) {
      badRequest(`${writePath}: give one of json, stageId or saveData`);
    }
    if (hasStage && typeof w.stageId !== 'string') badRequest(`${writePath}: bad stageId`);
    const expectedHash = w.expectedHash;
    if (
      expectedHash !== undefined &&
      expectedHash !== null &&
      !(typeof expectedHash === 'string' && HASH_PATTERN.test(expectedHash))
    ) {
      badRequest(`${writePath}: expectedHash must be a sha256 hex string or null`);
    }
    return {
      path: writePath,
      expectedHash: expectedHash as string | null | undefined,
      json: w.json,
      hasJson,
      stageId: w.stageId as string | undefined,
      saveData: hasSaveData ? checkSaveDataRequest(writePath, w.saveData) : undefined,
    };
  });
};

const readHash = async (file: string) => {
  try {
    return sha256(await fs.readFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

/** The JSON as the file gets it: Prettier-formatted with the target's config */
const formatJson = async (value: unknown, absPath: string) => {
  const options = (await resolveConfig(absPath)) ?? {};
  return format(JSON.stringify(value, null, 2), { ...options, filepath: absPath });
};

const planWrites = async (requested: RequestedWrite[], stage: DevFilesStage) => {
  const targets = await Promise.all(requested.map((write) => resolveDevFilePath(write.path)));

  const schemaIssues: DevFilesSchemaIssues = [];
  /** `currentHash`: a save entry's file as it was read (else it's read for the conflict check) */
  const contents: { data: Buffer; stageId?: string; currentHash?: string }[] = [];
  for (let i = 0; i < requested.length; i++) {
    const write = requested[i];
    const target = targets[i];
    let json = write.json;
    let currentHash: string | undefined;
    if (write.saveData) {
      const result = await applySaveDataWrite(target, write.saveData);
      currentHash = result.currentHash;
      if ('unchanged' in result) {
        contents.push({ data: result.unchanged, currentHash });
        continue;
      }
      json = result.json;
    } else if (write.hasJson !== target.isJson) {
      badRequest(`${target.repoPath}: a .json file takes json or saveData, any other a stageId`);
    }
    if (write.hasJson || write.saveData) {
      const issues = validateGatheredJson(target.repoPath, json);
      if (issues) schemaIssues.push({ path: target.repoPath, issues });
      contents.push({ data: Buffer.from(await formatJson(json, target.absPath)), currentHash });
    } else {
      const entry = stage.get(write.stageId as string);
      contents.push({ data: await fs.readFile(entry.file), stageId: write.stageId });
    }
  }

  let batchBytes = 0;
  for (let i = 0; i < contents.length; i++) {
    const bytes = contents[i].data.length;
    if (bytes > MAX_FILE_BYTES) {
      throw new DevFilesError(
        'TOO_LARGE',
        `${targets[i].repoPath} is over ${MAX_FILE_BYTES} bytes`
      );
    }
    batchBytes += bytes;
  }
  if (batchBytes > MAX_BATCH_BYTES) {
    throw new DevFilesError('TOO_LARGE', `The batch is over ${MAX_BATCH_BYTES} bytes`);
  }

  if (schemaIssues.length) {
    throw new DevFilesError(
      'INVALID_SCHEMA',
      `Invalid ${schemaIssues.map((file) => file.path).join(', ')}`,
      schemaIssues
    );
  }

  const conflicts: DevFilesConflicts = [];
  const planned: PlannedWrite[] = [];
  for (let i = 0; i < requested.length; i++) {
    const target = targets[i];
    const { data, stageId } = contents[i];
    const currentHash = contents[i].currentHash ?? (await readHash(target.absPath));
    const expected = requested[i].expectedHash;
    if (expected !== undefined && expected !== currentHash) {
      conflicts.push({ path: target.repoPath, currentHash });
    }
    const hash = sha256(data);
    const status: DevFilesWriteStatus =
      currentHash === null ? 'created' : currentHash === hash ? 'unchanged' : 'updated';
    planned.push({ target, data, sha256: hash, currentHash, status, stageId });
  }
  if (conflicts.length) {
    throw new DevFilesError(
      'CONFLICT',
      `Changed on disk: ${conflicts.map((conflict) => conflict.path).join(', ')}`,
      conflicts
    );
  }
  return planned;
};

/** A commit's temporary files end with this (the scene gatherer ignores them) */
export const DEV_FILES_TEMP_SUFFIX = '.aek-tmp';

const tempFileFor = (absPath: string) =>
  path.join(
    path.dirname(absPath),
    `${path.basename(absPath)}.${randomBytes(6).toString('hex')}${DEV_FILES_TEMP_SUFFIX}`
  );

const removeQuietly = async (file: string) => {
  await fs.rm(file, { recursive: true, force: true }).catch(() => undefined);
};

const pruneBackups = async () => {
  const dirs = (await fs.readdir(BACKUP_DIR).catch(() => [] as string[])).sort();
  for (const dir of dirs.slice(0, Math.max(0, dirs.length - BACKUPS_KEPT))) {
    await removeQuietly(path.join(BACKUP_DIR, dir));
  }
};

const writeFailed = (message: string, err: unknown, details?: unknown): never => {
  throw new DevFilesError('WRITE_FAILED', `${message}: ${(err as Error).message}`, details);
};

/**
 * Writes the batch's changed files, all or none.
 * @returns the files written into a folder the batch created
 */
const applyWrites = async (writes: PlannedWrite[], faults: CommitFaults) => {
  const commitId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const backupDir = path.join(BACKUP_DIR, commitId);
  /** The top folder each mkdir created, removed on a failure */
  const createdDirs: string[] = [];
  const temps: string[] = [];

  const cleanUp = async () => {
    for (const temp of temps) await removeQuietly(temp);
    for (const dir of createdDirs.reverse()) await removeQuietly(dir);
  };

  try {
    for (const write of writes) {
      const created = await fs.mkdir(path.dirname(write.target.absPath), { recursive: true });
      if (created) createdDirs.push(created);
      const temp = tempFileFor(write.target.absPath);
      temps.push(temp);
      await fs.writeFile(temp, write.data, { flag: 'wx' });
    }
    for (const write of writes) {
      if (write.currentHash === null) continue;
      const backup = path.join(backupDir, ...write.target.repoPath.split('/'));
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(write.target.absPath, backup);
    }
  } catch (err) {
    await cleanUp();
    await removeQuietly(backupDir);
    writeFailed('The batch could not be prepared, nothing was written', err);
  }

  let renamed = 0;
  try {
    for (; renamed < writes.length; renamed++) {
      if (faults.failRenameAt === renamed) throw new Error('Test fault (AEK_DEV_FILES_FAULTS)');
      await fs.rename(temps[renamed], writes[renamed].target.absPath);
    }
  } catch (err) {
    // Restore the renamed targets: the backups of the files there were, nothing for new ones
    const unrestored: string[] = [];
    for (const write of writes.slice(0, renamed).reverse()) {
      try {
        if (write.currentHash === null) {
          await fs.rm(write.target.absPath, { force: true });
        } else {
          const backup = path.join(backupDir, ...write.target.repoPath.split('/'));
          await fs.copyFile(backup, write.target.absPath);
        }
      } catch {
        unrestored.push(write.target.repoPath);
      }
    }
    temps.splice(0, renamed);
    await cleanUp();
    if (unrestored.length) {
      writeFailed(
        `The batch failed and ${unrestored.join(', ')} could not be restored (backups in ${backupDir})`,
        err,
        { unrestored, backupDir }
      );
    }
    await removeQuietly(backupDir);
    writeFailed('The batch failed, every file was restored', err);
  }
  await pruneBackups();
  return writes
    .map((write) => write.target.absPath)
    .filter((file) => createdDirs.some((dir) => file.startsWith(dir + path.sep)));
};

/** One commit at a time: two batches never interleave their checks and renames */
let queue: Promise<unknown> = Promise.resolve();

export type DevFilesCommitOutcome = {
  body: DevFilesCommitBody;
  /**
   * The files written into a folder the batch created (absolute). The file watcher may never
   * report them: chokidar reads a new folder before it watches it, and a rename in between is
   * missed (it saw the temporary file). The plugin reports them itself.
   */
  filesInNewFolders: string[];
};

export const commitDevFiles = (
  body: unknown,
  opts: { stage: DevFilesStage; faults?: CommitFaults }
): Promise<DevFilesCommitOutcome> => {
  const run = async () => {
    const planned = await planWrites(parseRequest(body), opts.stage);
    const changed = planned.filter((write) => write.status !== 'unchanged');
    const filesInNewFolders = changed.length ? await applyWrites(changed, opts.faults ?? {}) : [];
    for (const write of planned) {
      if (write.stageId) opts.stage.remove(write.stageId);
    }
    return {
      body: {
        results: planned.map((write) => ({
          path: write.target.repoPath,
          sha256: write.sha256,
          status: write.status,
        })),
      },
      filesInNewFolders,
    };
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
};

/** `GET read`: the file's bytes and hash */
export const readDevFile = async (input: unknown) => {
  const target = await resolveDevFilePath(input);
  let data: Buffer;
  try {
    data = await fs.readFile(target.absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DevFilesError('NOT_FOUND', `${target.repoPath} doesn't exist`, {
        path: target.repoPath,
      });
    }
    throw err;
  }
  return { target, data, sha256: sha256(data) };
};
