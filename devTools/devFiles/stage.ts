import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { ROOT } from '../assetPipeline/sources';
import { DevFilesError } from './http';
import type { DevFilesStageBody } from '../../src/_engine/debug/DevFilesProtocol';

/**
 * Staged files (p342 §2.1): a binary body (a PNG) is sent raw with `PUT stage` and named by its
 * `stageId` in a commit. They live in `.cache/dev-files/stage/`, which every server start
 * empties, and expire after 10 minutes. A commit that fails keeps them, so it can be retried; one
 * that lands removes them.
 */

export const DEV_FILES_CACHE_DIR = path.join(ROOT, '.cache', 'dev-files');
const STAGE_DIR = path.join(DEV_FILES_CACHE_DIR, 'stage');
const STAGE_TTL_MS = 10 * 60 * 1000;

export type StagedFile = { file: string; bytes: number; sha256: string; expiresAt: number };

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export const createStage = () => {
  const staged = new Map<string, StagedFile>();
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });

  const remove = (stageId: string) => {
    const entry = staged.get(stageId);
    if (!entry) return;
    staged.delete(stageId);
    fs.rmSync(entry.file, { force: true });
  };

  const sweep = () => {
    const now = Date.now();
    for (const [stageId, entry] of staged) {
      if (entry.expiresAt <= now) remove(stageId);
    }
  };
  const sweepTimer = setInterval(sweep, 60 * 1000);
  sweepTimer.unref();

  return {
    add: async (data: Buffer): Promise<DevFilesStageBody> => {
      sweep();
      await fs.promises.mkdir(STAGE_DIR, { recursive: true });
      const stageId = randomBytes(16).toString('hex');
      const file = path.join(STAGE_DIR, stageId);
      await fs.promises.writeFile(file, data);
      const entry = {
        file,
        bytes: data.length,
        sha256: sha256(data),
        expiresAt: Date.now() + STAGE_TTL_MS,
      };
      staged.set(stageId, entry);
      return { stageId, bytes: entry.bytes, sha256: entry.sha256 };
    },
    /** The staged file, or STAGE_EXPIRED */
    get: (stageId: string) => {
      sweep();
      const entry = staged.get(stageId);
      if (!entry) {
        throw new DevFilesError('STAGE_EXPIRED', `No staged file ${stageId} (expired or unknown)`, {
          stageId,
        });
      }
      return entry;
    },
    remove,
    dispose: () => clearInterval(sweepTimer),
  };
};

export type DevFilesStage = ReturnType<typeof createStage>;
