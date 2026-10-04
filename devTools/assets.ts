/* eslint-disable no-console */
import { runAssetsCommand } from './assetPipeline/command';
import { globToRegExp } from './assetPipeline/glob';
import type { PipelineAsset } from './assetPipeline/pipeline';
import { loadProjectOptOut } from './assetPipeline/switches';

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
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

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

const run = async () => {
  const { only } = parseArgs(process.argv.slice(2));
  const matchers = only.map((pattern) => ({ pattern, regExp: globToRegExp(pattern) }));
  const isSelected = (_key: string, asset: PipelineAsset) =>
    matchers.some(
      ({ pattern, regExp }) =>
        asset.id === pattern ||
        regExp.test(asset.jsonFile) ||
        (asset.source.kind !== 'remote' && regExp.test(asset.source.repoPath))
    );

  const { run: pipelineRun, hasErrors } = await runAssetsCommand({
    projectOptOut: await loadProjectOptOut(),
    ...(only.length ? { isSelected, only } : {}),
    prune: true,
    verbosity: 'full',
  });

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
