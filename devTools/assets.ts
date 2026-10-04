/* eslint-disable no-console */
import path from 'path';
import { collectPipelineAssets, readAssetJsons } from './assetPipeline/assets';
import { createPipelineCache } from './assetPipeline/cache';
import { getResultFigures } from './assetPipeline/generated';
import { globToRegExp } from './assetPipeline/glob';
import { createKtxProvider } from './assetPipeline/ktxEncode';
import { removeStaleOutputs } from './assetPipeline/outputs';
import type { PipelineAsset } from './assetPipeline/pipeline';
import { LAST_RUN_FILE, summarizeRun, writeRunSummary } from './assetPipeline/report';
import { runPipeline, type PipelineRunResult } from './assetPipeline/run';
import { createSettingsResolver, loadAssetsConfig } from './assetPipeline/settings';
import { ROOT } from './assetPipeline/sources';
import { ENV_KEY, loadProjectOptOut } from './assetPipeline/switches';

/**
 * The asset optimization pipeline (p300): turns the sources of every `*.texture.json` and
 * `*.importedAsset.json` into the outputs in `src/public/aek-assets/` (KTX2 textures, meshopt
 * GLBs), records them in `assets.lock.json`, then gathers the generated data with their `__url`s.
 * Unchanged assets come from the cache (§7), so a second run encodes nothing.
 *
 * Usage: `yarn assets [--only <id|glob>]...`
 * - `--only` builds the assets whose id is the pattern, or whose JSON or source path (from the
 *   repo root, eg. 'src/app/textures/**') matches it as a glob. The others are only looked up in
 *   the cache.
 * - Only a full run removes stale outputs and lock entries, and not under `AEK_ASSETS_OPTIMIZE`:
 *   a one-run override (eg. a quick CI build) leaves the committed state as it is.
 */

const USAGE = 'Usage: yarn assets [--only <id|glob>]...';

const parseArgs = (args: string[]) => {
  const only: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--only' && args[i + 1] && !args[i + 1].startsWith('--')) {
      only.push(args[++i]);
    } else if (arg.startsWith('--only=') && arg.length > '--only='.length) {
      only.push(arg.slice('--only='.length));
    } else {
      throw new Error(`Unknown or incomplete argument "${arg}". ${USAGE}`);
    }
  }
  return { only };
};

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const formatBytes = (bytes: number) => {
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${(bytes / 1e6).toFixed(2)} MB`;
};

const formatInOut = (value: { in: number; out: number }) =>
  `${formatBytes(value.in)} → ${formatBytes(value.out)}`;

const formatDuration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const getAssetLabel = (asset: PipelineAsset) => {
  const source = asset.source.kind === 'remote' ? asset.source.url : asset.source.repoPath;
  const colorSpace = asset.type === 'texture' && asset.isSrgb ? ', sRGB' : '';
  return `${asset.id} ${DIM}(${source}${colorSpace})${RESET}`;
};

const STATUS_LABELS: Record<PipelineRunResult['status'], string> = {
  optimized: `${GREEN}✓${RESET}`,
  passThrough: `${GREEN}→${RESET}`,
  skipped: `${DIM}·${RESET}`,
  encoderMissing: `${YELLOW}!${RESET}`,
  error: `${RED}✗${RESET}`,
};

/** @param projectReasons The project switches' reasons, printed once instead of per asset */
const formatResult = (result: PipelineRunResult, projectReasons: Set<string>) => {
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
  if ('reason' in result && !projectReasons.has(result.reason)) {
    const color =
      result.status === 'error' ? RED : result.status === 'encoderMissing' ? YELLOW : DIM;
    lines.push(`      ${color}${result.reason}${RESET}`);
  }
  if ('warnings' in result) {
    for (const warning of result.warnings) lines.push(`      ${YELLOW}⚠ ${warning}${RESET}`);
  }
  return lines.join('\n');
};

const STATUS_NAMES: Record<PipelineRunResult['status'], string> = {
  optimized: 'optimized',
  passThrough: 'passed through',
  skipped: 'skipped',
  encoderMissing: 'encoder missing',
  error: 'failed',
};

const run = async () => {
  const start = performance.now();
  const { only } = parseArgs(process.argv.slice(2));
  const projectOptOut = await loadProjectOptOut();
  const resolveSettings = createSettingsResolver(loadAssetsConfig(), projectOptOut);
  const projectReasons = new Set(Object.values(projectOptOut));
  const assets = collectPipelineAssets(readAssetJsons());

  const matchers = only.map((pattern) => ({ pattern, regExp: globToRegExp(pattern) }));
  const isSelected = (_key: string, asset: PipelineAsset) =>
    matchers.some(
      ({ pattern, regExp }) =>
        asset.id === pattern ||
        regExp.test(asset.jsonFile) ||
        (asset.source.kind !== 'remote' && regExp.test(asset.source.repoPath))
    );
  const selectedCount = [...assets].filter(([key, asset]) => isSelected(key, asset)).length;
  if (only.length && !selectedCount) {
    throw new Error(
      `--only ${only.join(', ')} matches no asset (an id, or a glob from the repo root)`
    );
  }
  console.log(
    `[Assets] ${only.length ? `${selectedCount} of ${assets.size}` : assets.size} asset${assets.size === 1 ? '' : 's'}`
  );
  if (projectOptOut.textures === projectOptOut.mesh && projectOptOut.textures) {
    console.log(`  ${DIM}Optimization is off: ${projectOptOut.textures}${RESET}`);
  } else {
    if (projectOptOut.textures)
      console.log(`  ${DIM}Textures are off: ${projectOptOut.textures}${RESET}`);
    if (projectOptOut.mesh) console.log(`  ${DIM}Meshes are off: ${projectOptOut.mesh}${RESET}`);
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
    ...(only.length ? { isSelected } : {}),
    onStart: (key, asset) => {
      if (!isTTY || (only.length && !isSelected(key, asset))) return;
      progressLine = `  … ${getAssetLabel(asset)}`;
      process.stdout.write(progressLine);
    },
    onResult: (key, result) => {
      if (only.length && !isSelected(key, result.asset)) return;
      log(formatResult(result, projectReasons));
    },
  });

  const results = [...pipelineRun.results.values()];
  const hasErrors = results.some((result) => result.status === 'error');
  let staleOutputsRemoved: string[] = [];
  let staleNote = '';
  if (only.length) {
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
  cache.save();

  const summary = summarizeRun(pipelineRun, {
    only,
    durationMs: Math.round(performance.now() - start),
    staleOutputsRemoved,
  });
  writeRunSummary(summary);

  const counts = Object.entries(summary.statuses)
    .map(([status, count]) => `${count} ${STATUS_NAMES[status as PipelineRunResult['status']]}`)
    .join(', ');
  const color = hasErrors ? RED : summary.statuses.encoderMissing ? YELLOW : GREEN;
  console.log(
    `${color}${hasErrors ? '✗' : '✓'} [Assets] ${results.length}${only.length ? ` (${selectedCount} selected)` : ''} in ${formatDuration(summary.durationMs)}: ${counts || 'none'}${RESET}`
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
  if (staleOutputsRemoved.length) {
    console.log(`  Removed ${staleOutputsRemoved.length} stale output(s):`);
    for (const file of staleOutputsRemoved) console.log(`    ${DIM}${file}${RESET}`);
  }
  if (staleNote) console.log(`  ${DIM}${staleNote}${RESET}`);
  if (summary.statuses.encoderMissing) {
    console.log(
      `  ${YELLOW}Assets that need ktx got no output. yarn setupAssetTools shows why it can't be set up.${RESET}`
    );
  }
  console.log(`  ${DIM}Stats: ${path.relative(ROOT, LAST_RUN_FILE)}${RESET}`);

  // Imported here: it compiles the JSON schemas on load
  const { gatherSceneData } = await import('./gatherAppData');
  const isGathered = gatherSceneData({ pipeline: pipelineRun });
  if (hasErrors || !isGathered) process.exitCode = 1;
};

try {
  await run();
} catch (error) {
  console.error(`${RED}✗ [Assets] ${(error as Error).message}${RESET}`);
  process.exitCode = 1;
}
