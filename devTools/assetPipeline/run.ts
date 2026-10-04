import type { PipelineCache } from './cache';
import { createKtxProvider, type KtxProvider } from './ktxEncode';
import { getSourceBytes, processAsset, type PipelineAsset, type PipelineResult } from './pipeline';
import type { createSettingsResolver } from './settings';

/**
 * Runs the pipeline over a list of assets (`collectPipelineAssets`), one at a time: `ktx` and
 * sharp use every core for one encode. One `ktx` setup for the whole run. The caller owns the
 * cache: it saves the lock, and only a full run prunes it (`yarn assets`, devTools/assets.ts).
 */

export type PipelineRunResult = (
  | PipelineResult
  /** `processAsset` threw (eg. a pack's source can't be read, `ktx create` failed) */
  | { status: 'error'; reason: string; durationMs: number }
) & {
  asset: PipelineAsset;
  /** What the runtime downloads without the pipeline (`__bytes.in`) */
  sourceBytes?: number;
};

export type PipelineRun = {
  /** By `getPipelineAssetKey` */
  results: Map<string, PipelineRunResult>;
};

export const runPipeline = async (
  assets: Map<string, PipelineAsset>,
  opts: {
    resolveSettings: ReturnType<typeof createSettingsResolver>;
    cache?: PipelineCache;
    getKtx?: KtxProvider;
    /**
     * The assets to build (a partial run); the others are only looked up in the cache, so the
     * run still has every output there is. Default: all.
     */
    isSelected?: (key: string, asset: PipelineAsset) => boolean;
    /** Before each asset, eg. for progress */
    onStart?: (key: string, asset: PipelineAsset) => void;
    /** After each asset */
    onResult?: (key: string, result: PipelineRunResult) => void;
  }
): Promise<PipelineRun> => {
  const getKtx = opts.getKtx ?? createKtxProvider();
  const results = new Map<string, PipelineRunResult>();
  for (const [key, asset] of assets) {
    opts.onStart?.(key, asset);
    const start = performance.now();
    let result: PipelineRunResult;
    try {
      const outcome = await processAsset(asset, opts.resolveSettings, {
        getKtx,
        cache: opts.cache,
        lookupOnly: opts.isSelected ? !opts.isSelected(key, asset) : false,
      });
      result = { ...outcome, asset, sourceBytes: getSourceBytes(asset) };
    } catch (error) {
      result = {
        status: 'error',
        reason: (error as Error).message,
        durationMs: Math.round(performance.now() - start),
        asset,
      };
    }
    results.set(key, result);
    opts.onResult?.(key, result);
  }
  return { results };
};
