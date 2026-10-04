import fs from 'fs';
import path from 'path';
import { getResultFigures } from './generated';
import type { PipelineRun, PipelineRunResult } from './run';
import { ROOT } from './sources';

/**
 * A run's stats (p300 §5): what each asset became, the download and VRAM totals before and
 * after, the cache hit rate and the slowest assets. `yarn assets` prints it and writes it to
 * `.cache/asset-pipeline/last-run.json` (gitignored).
 */

export const LAST_RUN_FILE = path.join(ROOT, '.cache', 'asset-pipeline', 'last-run.json');

/** Decimal units, like the budgets (§11) */
export const formatBytes = (bytes: number) => {
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${(bytes / 1e6).toFixed(2)} MB`;
};

/** How many of the slowest assets the summary lists */
const SLOWEST_COUNT = 5;

type InOut = { in: number; out: number };

export type RunSummaryAsset = {
  key: string;
  id: string;
  type: PipelineRunResult['asset']['type'];
  json: string;
  /** The source file, or a pack's JSON; a remote one's URL */
  source: string;
  status: PipelineRunResult['status'];
  cache?: 'hit' | 'restored' | 'miss';
  url?: string;
  bytes?: InOut;
  vramBytes?: InOut;
  /** A standalone texture's codec */
  codec?: string;
  /** Why it was passed through, skipped or not encoded, or what failed */
  reason?: string;
  warnings?: string[];
  /** Why it is over its budget (`getBudgetViolations`) */
  overBudget?: string[];
  durationMs: number;
};

export type RunSummary = ReturnType<typeof summarizeRun>;

const getSourceLabel = (result: PipelineRunResult) => {
  const { source } = result.asset;
  return source.kind === 'remote' ? source.url : source.repoPath;
};

const addInOut = (total: InOut, value?: InOut) => {
  if (!value) return;
  total.in += value.in;
  total.out += value.out;
};

/**
 * @param opts.only The `--only` patterns of a partial run (its other assets were only looked up)
 * @param opts.overBudget By result key, why each asset over its budget is (`getBudgetViolations`)
 */
export const summarizeRun = (
  run: PipelineRun,
  opts: {
    only: string[];
    durationMs: number;
    staleOutputsRemoved: string[];
    overBudget: Map<string, string[]>;
  }
) => {
  const assets: RunSummaryAsset[] = [];
  const statuses: Partial<Record<RunSummaryAsset['status'], number>> = {};
  const cache = { hit: 0, restored: 0, miss: 0 };
  const bytes = { in: 0, out: 0 };
  // VRAM has no figure for a pass-through (its image isn't read), so it totals the optimized ones
  const vramBytes = { in: 0, out: 0 };

  for (const [key, result] of run.results) {
    const figures = getResultFigures(result);
    addInOut(bytes, figures?.bytes);
    addInOut(vramBytes, figures?.vramBytes);
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    const cacheStatus = 'cache' in result ? result.cache : undefined;
    if (cacheStatus) cache[cacheStatus]++;
    const isTexture = result.asset.type === 'texture';
    assets.push({
      key,
      id: result.asset.id,
      type: result.asset.type,
      json: result.asset.jsonFile,
      source: getSourceLabel(result),
      status: result.status,
      ...(cacheStatus ? { cache: cacheStatus } : {}),
      ...('output' in result ? { url: result.output.url } : {}),
      ...(figures?.bytes ? { bytes: figures.bytes } : {}),
      ...(figures?.vramBytes ? { vramBytes: figures.vramBytes } : {}),
      ...(result.status === 'optimized' && isTexture && result.textures[0]
        ? { codec: result.textures[0].codec }
        : {}),
      ...('reason' in result ? { reason: result.reason } : {}),
      ...('warnings' in result && result.warnings.length ? { warnings: result.warnings } : {}),
      ...(opts.overBudget.has(key) ? { overBudget: opts.overBudget.get(key) } : {}),
      durationMs: result.durationMs,
    });
  }

  const lookups = cache.hit + cache.restored + cache.miss;
  return {
    date: new Date().toISOString(),
    only: opts.only,
    durationMs: opts.durationMs,
    statuses,
    overBudget: opts.overBudget.size,
    cache: { ...cache, hitRate: lookups ? (cache.hit + cache.restored) / lookups : null },
    totals: { bytes, vramBytes },
    slowest: [...assets]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, SLOWEST_COUNT)
      .map(({ key, id, durationMs }) => ({ key, id, durationMs })),
    staleOutputsRemoved: opts.staleOutputsRemoved,
    assets,
  };
};

export const writeRunSummary = (summary: RunSummary, file = LAST_RUN_FILE) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
};
