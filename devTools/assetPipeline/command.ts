/* eslint-disable no-console */
import path from 'path';
import { collectPipelineAssets, readAssetJsons } from './assets';
import { BUDGET_FIX, getBudgetViolations } from './budgets';
import { createPipelineCache } from './cache';
import { getResultFigures, isKtxOnlyAsset } from './generated';
import { createKtxProvider } from './ktxEncode';
import { KTX_FIX } from './ktxTool';
import { removeStaleOutputs } from './outputs';
import type { PipelineAsset } from './pipeline';
import {
  formatBytes,
  LAST_RUN_FILE,
  summarizeRun,
  writeRunSummary,
  type RunSummary,
} from './report';
import { runPipeline, type PipelineRun, type PipelineRunResult } from './run';
import { createSettingsResolver, loadAssetsConfig } from './settings';
import { ROOT } from './sources';
import { ALLOW_UNOPTIMIZED_ENV_KEY, ENV_KEY, type ProjectOptOut } from './switches';

/**
 * One pipeline run as a command (p300): collects the assets, runs them through the cache, saves
 * the lock, prints the results and writes the stats (§5). Shared by `yarn assets`, `yarn
 * gatherAppData` and the dev server's gatherer plugin, which differ in what they build, what
 * they print and whether they remove stale outputs.
 */

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const formatInOut = (value: { in: number; out: number }) =>
  `${formatBytes(value.in)} → ${formatBytes(value.out)}`;

const formatDuration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const getAssetLabel = (asset: PipelineAsset) => {
  const source = asset.source.kind === 'remote' ? asset.source.url : asset.source.repoPath;
  const count = (n: number, noun: string) => `, ${n} ${noun}${n === 1 ? '' : 's'}`;
  const parts =
    asset.source.kind === 'array'
      ? count(asset.source.layers.length, 'layer')
      : asset.source.kind === 'atlas'
        ? asset.source.image
          ? `${count(asset.source.cells.length, 'cell')} in an image`
          : count(asset.source.cells.filter((cell) => cell.source).length, 'cell')
        : '';
  const fullChain = asset.source.kind === 'atlas' && asset.source.mipChain ? ', full chain' : '';
  const alphaCoverage =
    asset.source.kind === 'atlas' && asset.source.alphaCoverage !== undefined
      ? `, alpha coverage ${asset.source.alphaCoverage}`
      : '';
  const colorSpace = asset.type !== 'importedAsset' && asset.isSrgb ? ', sRGB' : '';
  return `${asset.id} ${DIM}(${source}${parts}${fullChain}${alphaCoverage}${colorSpace})${RESET}`;
};

const STATUS_LABELS: Record<PipelineRunResult['status'], string> = {
  optimized: `${GREEN}✓${RESET}`,
  passThrough: `${GREEN}→${RESET}`,
  skipped: `${DIM}·${RESET}`,
  encoderMissing: `${YELLOW}!${RESET}`,
  error: `${RED}✗${RESET}`,
};

/**
 * @param projectReasons The project switches' reasons, printed once instead of per asset
 * @param isBudgetError Over budget fails this command (`yarn assets`), else it's a warning
 */
const formatResult = (
  result: PipelineRunResult,
  projectReasons: Set<string>,
  isBudgetError: boolean
) => {
  const figures = getResultFigures(result);
  const details: string[] = [];
  if (result.status === 'optimized') {
    const { mesh } = result.settings;
    const codecs = [
      ...(result.asset.type === 'importedAsset'
        ? [
            !mesh
              ? 'mesh as is'
              : mesh.codec === 'meshopt' && !mesh.quantize
                ? 'meshopt lossless'
                : mesh.codec,
          ]
        : []),
      ...new Set(result.textures.map((texture) => texture.codec)),
    ];
    details.push(codecs.join(' + '));
  } else if (result.status === 'passThrough') {
    details.push('passed through');
  }
  if ('cache' in result && result.cache) {
    details.push(result.cache === 'miss' ? 'built' : `cache ${result.cache}`);
  }
  if (figures) details.push(formatInOut(figures.bytes));
  if (figures?.vramBytes) details.push(`VRAM ${formatInOut(figures.vramBytes)}`);
  details.push(formatDuration(result.durationMs));
  const lines = [
    `  ${STATUS_LABELS[result.status]} ${getAssetLabel(result.asset)}  ${details.join(', ')}`,
  ];
  // A run's assets share one `ktx` setup, so its reason is printed once (`getEncoderMissingReason`)
  if (
    'reason' in result &&
    !projectReasons.has(result.reason) &&
    result.status !== 'encoderMissing'
  ) {
    lines.push(`      ${result.status === 'error' ? RED : DIM}${result.reason}${RESET}`);
  }
  if ('warnings' in result) {
    for (const warning of result.warnings) lines.push(`      ${YELLOW}⚠ ${warning}${RESET}`);
  }
  const [mark, color] = isBudgetError ? ['✗', RED] : ['⚠', YELLOW];
  for (const violation of getBudgetViolations(result)) {
    lines.push(`      ${color}${mark} over budget: ${violation}${RESET}`);
  }
  return lines.join('\n');
};

/** Did the run do something with it, or does it need a look: not a plain lookup or copy */
const isNotable = (result: PipelineRunResult) =>
  result.status === 'error' ||
  result.status === 'encoderMissing' ||
  ('cache' in result && (result.cache === 'miss' || result.cache === 'restored'));

/** Why the run has no `ktx`: one setup per run, so every `encoderMissing` result has this reason */
const getEncoderMissingReason = (results: Iterable<PipelineRunResult>) => {
  for (const result of results) if (result.status === 'encoderMissing') return result.reason;
  return null;
};

const STATUS_NAMES: Record<PipelineRunResult['status'], string> = {
  optimized: 'optimized',
  passThrough: 'passed through',
  skipped: 'skipped',
  encoderMissing: 'encoder missing',
  error: 'failed',
};

const printProjectOptOut = (projectOptOut: ProjectOptOut) => {
  if (projectOptOut.textures === projectOptOut.mesh && projectOptOut.textures) {
    console.log(`  ${DIM}Optimization is off: ${projectOptOut.textures}${RESET}`);
    return;
  }
  if (projectOptOut.textures) {
    console.log(`  ${DIM}Textures are off: ${projectOptOut.textures}${RESET}`);
  }
  if (projectOptOut.mesh) console.log(`  ${DIM}Meshes are off: ${projectOptOut.mesh}${RESET}`);
};

const printSummary = (
  summary: RunSummary,
  opts: {
    selectedCount: number;
    isPartial: boolean;
    staleNote: string;
    selectedOverBudget: number;
  }
) => {
  const { statuses } = summary;
  const total = summary.assets.length;
  const hasErrors = !!statuses.error || opts.selectedOverBudget > 0;
  const counts = [
    ...Object.entries(statuses).map(
      ([status, count]) => `${count} ${STATUS_NAMES[status as PipelineRunResult['status']]}`
    ),
    ...(opts.selectedOverBudget ? [`${opts.selectedOverBudget} over budget`] : []),
  ].join(', ');
  const color = hasErrors ? RED : statuses.encoderMissing ? YELLOW : GREEN;
  console.log(
    `${color}${hasErrors ? '✗' : '✓'} [Assets] ${total}${opts.isPartial ? ` (${opts.selectedCount} selected)` : ''} in ${formatDuration(summary.durationMs)}: ${counts || 'none'}${RESET}`
  );
  const { bytes, vramBytes } = summary.totals;
  if (bytes.in || bytes.out) {
    const vram = vramBytes.in ? `, VRAM ${formatInOut(vramBytes)} (optimized assets)` : '';
    console.log(`  Download ${formatInOut(bytes)}${vram}`);
  }
  const { hit, restored, miss, hitRate } = summary.cache;
  if (hitRate !== null) {
    console.log(
      `  Cache: ${hit} ${hit === 1 ? 'hit' : 'hits'}, ${restored} restored, ${miss} built (${Math.round(hitRate * 100)}% from the cache)`
    );
  }
  const slowest = summary.slowest.filter((asset) => asset.durationMs >= 1000);
  if (slowest.length) {
    console.log(
      `  Slowest: ${slowest.map((asset) => `${asset.id} ${formatDuration(asset.durationMs)}`).join(', ')}`
    );
  }
  if (opts.selectedOverBudget) console.log(`  ${RED}Over budget: ${BUDGET_FIX}${RESET}`);
  if (summary.staleOutputsRemoved.length) {
    console.log(`  Removed ${summary.staleOutputsRemoved.length} stale output(s):`);
    for (const file of summary.staleOutputsRemoved) console.log(`    ${DIM}${file}${RESET}`);
  }
  if (opts.staleNote) console.log(`  ${DIM}${opts.staleNote}${RESET}`);
};

/** The short form: one line, and only when the run did something worth a line */
const printBriefSummary = (
  summary: RunSummary,
  results: PipelineRunResult[],
  selectedOverBudget: number
) => {
  const { statuses } = summary;
  const built = summary.cache.miss;
  const restored = summary.cache.restored;
  const parts = [
    ...(built ? [`${built} built`] : []),
    ...(restored ? [`${restored} restored from the store`] : []),
    ...(statuses.encoderMissing ? [`${statuses.encoderMissing} encoder missing`] : []),
    ...(selectedOverBudget ? [`${selectedOverBudget} over budget`] : []),
    ...(statuses.error ? [`${statuses.error} failed`] : []),
  ];
  const color = statuses.error
    ? RED
    : statuses.encoderMissing || selectedOverBudget
      ? YELLOW
      : GREEN;
  const label = `${results.length} asset${results.length === 1 ? '' : 's'}`;
  console.log(
    `${color}${statuses.error ? '✗' : '✓'} [Assets] ${label}, ${parts.length ? parts.join(', ') : 'all up to date'} (${formatDuration(summary.durationMs)})${RESET}`
  );
};

export type AssetsCommandOpts = {
  projectOptOut: ProjectOptOut;
  /**
   * The assets to build; the others are only looked up in the cache (see `runPipeline`), so the
   * run still has every output there is. Default: all.
   */
  isSelected?: (key: string, asset: PipelineAsset) => boolean;
  /** `yarn assets`' `--only` patterns (with `isSelected`): in the stats; matching no asset throws */
  only?: string[];
  /**
   * Remove stale outputs and lock entries (`yarn assets`): only on a run that builds everything,
   * has no failed asset and isn't under `AEK_ASSETS_OPTIMIZE`. Default: false.
   */
  prune?: boolean;
  /**
   * `full`: every selected asset's line and the whole summary (`yarn assets`), over budget as
   * errors. `brief`: only the assets the run built, restored or failed on, or that are over budget
   * (as warnings), and one summary line; nothing at all when every asset was a plain lookup within
   * its budget and `isQuietWhenUpToDate` (the dev server).
   */
  verbosity: 'full' | 'brief';
  isQuietWhenUpToDate?: boolean;
  /**
   * Re-runs the assets that got no output for want of `ktx` with their textures side off, so they
   * pass through as unoptimized outputs (a production build under `AEK_ASSETS_ALLOW_UNOPTIMIZED`,
   * which has no `__sourceUrl` to fall back to). Not cached: the lock keeps the real settings'
   * entries only. Not a texture array (p299 D2) nor an atlas slot (D3): each is only ever a KTX2
   * file, so it stays `encoderMissing`. Default: false.
   */
  isUnoptimizedFallback?: boolean;
};

export type AssetsCommandResult = {
  run: PipelineRun;
  /** An asset failed (`error`); `encoderMissing` is a warning (§8) */
  hasErrors: boolean;
  /** The selected assets that failed */
  errors: PipelineRunResult[];
  /**
   * The selected assets over their budget (Phase 4): `yarn assets` fails on them, the production
   * gather on the ones shipped scenes use, the dev server only warns
   */
  overBudget: PipelineRunResult[];
};

/**
 * Throws only when the run can't start: an invalid `assets.config.json` or `assets.lock.json`.
 * A failing asset is an `error` result.
 */
export const runAssetsCommand = async (opts: AssetsCommandOpts): Promise<AssetsCommandResult> => {
  const start = performance.now();
  const { projectOptOut, isSelected, verbosity } = opts;
  const isFull = verbosity === 'full';
  const assetsConfig = loadAssetsConfig();
  const resolveSettings = createSettingsResolver(assetsConfig, projectOptOut);
  const projectReasons = new Set(Object.values(projectOptOut));
  const assets = collectPipelineAssets(readAssetJsons());

  const selectedKeys = new Set(
    [...assets].filter(([key, asset]) => !isSelected || isSelected(key, asset)).map(([key]) => key)
  );
  if (opts.only?.length && !selectedKeys.size) {
    throw new Error(
      `--only ${opts.only.join(', ')} matches no asset (an id, or a glob from the repo root)`
    );
  }
  if (isFull) {
    console.log(
      `[Assets] ${isSelected ? `${selectedKeys.size} of ${assets.size}` : assets.size} asset${assets.size === 1 ? '' : 's'}`
    );
    printProjectOptOut(projectOptOut);
  }

  // In a terminal, the asset being built stands on the last line until its result replaces it
  const isTTY = process.stdout.isTTY;
  let progressLine = '';
  const clearProgress = () => {
    if (progressLine) process.stdout.write('\r\x1b[K');
    progressLine = '';
  };
  const log = (message: string) => {
    clearProgress();
    console.log(message);
  };

  const cache = createPipelineCache();
  const pipelineRun = await runPipeline(assets, {
    resolveSettings,
    cache,
    getKtx: createKtxProvider((message) => log(`    ${DIM}${message}${RESET}`)),
    ...(isSelected ? { isSelected: (key) => selectedKeys.has(key) } : {}),
    onStart: (key, asset) => {
      if (!isTTY || !selectedKeys.has(key)) return;
      progressLine = `  … ${getAssetLabel(asset)}`;
      process.stdout.write(progressLine);
    },
    onResult: (key, result) => {
      if (!selectedKeys.has(key)) return;
      if (isFull || isNotable(result) || getBudgetViolations(result).length) {
        log(formatResult(result, projectReasons, isFull));
      } else {
        clearProgress();
      }
    },
  });

  if (opts.isUnoptimizedFallback) {
    const missing = new Map(
      [...pipelineRun.results].flatMap(([key, result]) =>
        result.status === 'encoderMissing' && !isKtxOnlyAsset(result)
          ? [[key, result.asset] as const]
          : []
      )
    );
    if (missing.size) {
      const reason = `${ALLOW_UNOPTIMIZED_ENV_KEY}: shipped unoptimized, ktx is missing`;
      log(
        `  ${YELLOW}⚠ ${missing.size} asset(s) ship unoptimized, ktx is missing: ${getEncoderMissingReason(pipelineRun.results.values())}${RESET}`
      );
      const fallback = await runPipeline(missing, {
        resolveSettings: createSettingsResolver(assetsConfig, {
          ...projectOptOut,
          textures: reason,
        }),
        onResult: (_key, result) => log(formatResult(result, projectReasons, isFull)),
      });
      for (const [key, result] of fallback.results) pipelineRun.results.set(key, result);
    }
  }

  const results = [...pipelineRun.results.values()];
  const hasErrors = results.some((result) => result.status === 'error');
  let staleOutputsRemoved: string[] = [];
  let staleNote = '';
  if (opts.prune) {
    if (isSelected) {
      staleNote = 'Stale outputs are kept: --only is a partial run.';
    } else if (process.env[ENV_KEY]) {
      // A one-run override: the committed outputs and lock stay those of src/CONFIG.ts's settings
      staleNote = `Stale outputs are kept: ${ENV_KEY} overrides src/CONFIG.ts for this run only.`;
    } else if (hasErrors) {
      staleNote = 'Stale outputs are kept: an asset failed.';
    } else {
      cache.prune();
      staleOutputsRemoved = removeStaleOutputs(
        results.flatMap((result) => ('output' in result ? [result.output.url] : []))
      );
    }
  }
  cache.save();

  const overBudget = new Map(
    [...pipelineRun.results].flatMap(([key, result]) => {
      const violations = getBudgetViolations(result);
      return violations.length ? [[key, violations] as const] : [];
    })
  );
  const selectedOverBudget = [...overBudget.keys()].filter((key) => selectedKeys.has(key));
  const summary = summarizeRun(pipelineRun, {
    only: opts.only ?? [],
    durationMs: Math.round(performance.now() - start),
    staleOutputsRemoved,
    overBudget,
  });
  writeRunSummary(summary);

  const isNotableRun = results.some(isNotable) || selectedOverBudget.length > 0;
  if (isFull) {
    printSummary(summary, {
      selectedCount: selectedKeys.size,
      isPartial: !!isSelected,
      staleNote,
      selectedOverBudget: selectedOverBudget.length,
    });
  } else if (!opts.isQuietWhenUpToDate || isNotableRun) {
    if (isNotableRun) printProjectOptOut(projectOptOut);
    printBriefSummary(summary, results, selectedOverBudget.length);
  }
  const encoderMissing = summary.statuses.encoderMissing;
  if (encoderMissing) {
    console.log(
      `  ${YELLOW}! ${encoderMissing} asset${encoderMissing === 1 ? ' needs' : 's need'} ktx and got no output: ${getEncoderMissingReason(results)}${RESET}`
    );
    console.log(`    ${YELLOW}Fix: ${KTX_FIX}; then yarn assets.${RESET}`);
  }
  if (isFull) console.log(`  ${DIM}Stats: ${path.relative(ROOT, LAST_RUN_FILE)}${RESET}`);

  return {
    run: pipelineRun,
    hasErrors,
    errors: [...pipelineRun.results].flatMap(([key, result]) =>
      result.status === 'error' && selectedKeys.has(key) ? [result] : []
    ),
    overBudget: selectedOverBudget.flatMap((key) => pipelineRun.results.get(key) ?? []),
  };
};
