/* eslint-disable no-console */
import path from 'path';
import type { Plugin, ViteDevServer } from 'vite';
import type { AppConfig } from '../src/_engine/core/Config';
import { AEK_GATHER_EVENT, type DevDataGatheredEvent } from '../src/_engine/debug/DevFilesProtocol';
import { runAssetsCommand } from './assetPipeline/command';
import { AEK_ASSETS_DIR } from './assetPipeline/outputs';
import {
  listAssetJsonFiles,
  listAssetSourceFiles,
  type PipelineAsset,
} from './assetPipeline/pipeline';
import type { PipelineRun, PipelineRunResult } from './assetPipeline/run';
import { ASSETS_CONFIG_FILE } from './assetPipeline/settings';
import { ROOT } from './assetPipeline/sources';
import { CONFIG_FILE, resolveProjectOptOut, type ProjectOptOut } from './assetPipeline/switches';
import { DEV_FILES_TEMP_SUFFIX } from './devFiles/commit';
import {
  gatherSceneData,
  isFilePathValid,
  OUTPUT_FILE_DATA,
  OUTPUT_FILE_FN,
} from './gatherAppData';

/**
 * The dev server's gatherer (`yarn dev`): re-gathers the generated data when an asset JSON is
 * added, changed or deleted, and runs the asset pipeline (p300) first when what it reads changed:
 * - an asset JSON (`*.texture.json`, `*.importedAsset.json`, `*.textureArray.json`,
 *   `*.textureAtlas.json`): its assets are built, and the arrays and atlas slots that have one of
 *   its textures as a layer or a cell;
 * - a source file of an asset (a pack's files and a .gltf's external files too): the assets that
 *   read it are built;
 * - `assets.config.json`, or the switches in `src/CONFIG.ts` (`assets.optimization`, loaded
 *   through Vite: Node can't import .ts): every asset is built, which is a cache hit for those
 *   whose settings didn't change.
 * Every other asset is only looked up in the cache, so the gather keeps its `__url`. A run never
 * removes stale outputs (`yarn assets` does). Changes are queued: one run at a time, and the
 * changes that come in during a run go into the next one.
 *
 * Each gather ends with the custom HMR event `aek:gather` (`DevDataGatheredEvent`: how it went,
 * the changed files, whether a reload follows), before the `full-reload`. The dev files' client
 * delivers it to `onDevDataGathered` (p342 §2.5); Vite's client handles the reload only after its
 * listeners have settled.
 */

const ASSET_JSON_SUFFIXES = [
  '.texture.json',
  '.importedAsset.json',
  '.textureArray.json',
  '.textureAtlas.json',
];

/** Lets a burst of saves (eg. a debug tool writing several JSONs) go into one run */
const DEBOUNCE_MS = 100;

type PendingWork = {
  /** Changed asset JSONs and source files: the assets that read them are built */
  files: Set<string>;
  /** Every asset is built (its settings may have changed) */
  isAllSelected: boolean;
  /** The pipeline runs before the gather */
  needsRun: boolean;
  /** src/CONFIG.ts changed: reload the switches, and run with all assets if they differ */
  isSwitchesCheck: boolean;
  needsGather: boolean;
  /** Every file whose event queued this work, for the `aek:gather` event */
  changedFiles: Set<string>;
};

const createPendingWork = (): PendingWork => ({
  files: new Set(),
  isAllSelected: false,
  needsRun: false,
  isSwitchesCheck: false,
  needsGather: false,
  changedFiles: new Set(),
});

/** Every file the run's assets read, so a change to one of them can be told apart */
const listRunSourceFiles = (run: PipelineRun) => {
  const files = new Set<string>();
  for (const { asset } of run.results.values()) {
    try {
      for (const file of listAssetSourceFiles(asset)) files.add(file);
    } catch {
      // A pack's missing source: the gather reports it, and the file's 'add' re-runs it
    }
  }
  return files;
};

const sendError = (server: ViteDevServer, message: string, stack: string) =>
  server.ws.send({
    type: 'error',
    err: { message, stack, plugin: 'vite-plugin-scene-gatherer' },
  });

const toAssetErrors = (errors: PipelineRunResult[]) =>
  errors.map((result) => ({
    id: result.asset.id,
    reason: 'reason' in result ? result.reason : '',
  }));

const formatAssetErrors = (errors: PipelineRunResult[]) =>
  toAssetErrors(errors)
    .map(({ id, reason }) => `${id}: ${reason}`)
    .join('\n');

const sendGatherEvent = (
  server: ViteDevServer,
  work: PendingWork,
  event: Omit<DevDataGatheredEvent, 'files'>
) => {
  const data: DevDataGatheredEvent = {
    ...event,
    files: [...work.changedFiles].map((file) =>
      path.relative(ROOT, file).split(path.sep).join('/')
    ),
  };
  server.hot.send({ type: 'custom', event: AEK_GATHER_EVENT, data });
};

export const sceneGathererPlugin = (): Plugin => ({
  name: 'vite-plugin-scene-gatherer',
  apply: 'serve',
  configureServer(server) {
    // The repo root isn't watched (the Vite root is src/)
    server.watcher.add(ASSETS_CONFIG_FILE);
    const configUrl = `/${path.relative(server.config.root, CONFIG_FILE).split(path.sep).join('/')}`;

    let lastRun: PipelineRun | null = null;
    let sourceFiles = new Set<string>();
    let projectOptOut: ProjectOptOut | null = null;
    let isLastGatherFailed = false;
    let pending = createPendingWork();
    let hasPending = false;
    let isRunning = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** The switches as src/CONFIG.ts has them now; true when they changed */
    const reloadProjectOptOut = async () => {
      const { moduleGraph } = server.environments.ssr;
      for (const mod of moduleGraph.getModulesByFile(CONFIG_FILE) ?? []) {
        moduleGraph.invalidateModule(mod);
      }
      const module = (await server.ssrLoadModule(configUrl)) as { default: AppConfig };
      const next = resolveProjectOptOut(module.default.assets?.optimization);
      const isChanged = !!projectOptOut && JSON.stringify(next) !== JSON.stringify(projectOptOut);
      projectOptOut = next;
      return isChanged;
    };

    const runPipeline = async (work: PendingWork) => {
      const previous = lastRun;
      const isSelected = (key: string, asset: PipelineAsset) => {
        // The first run only looks up: `yarn dev` built everything just before
        if (!previous) return false;
        if (work.isAllSelected || !previous.results.has(key)) return true;
        if (listAssetJsonFiles(asset).some((file) => work.files.has(file))) return true;
        try {
          return listAssetSourceFiles(asset).some((file) => work.files.has(file));
        } catch {
          return true; // processAsset reports it
        }
      };
      const result = await runAssetsCommand({
        projectOptOut: projectOptOut ?? {},
        isSelected,
        verbosity: 'brief',
        isQuietWhenUpToDate: true,
      });
      lastRun = result.run;
      sourceFiles = listRunSourceFiles(result.run);
      return result.errors;
    };

    const processWork = async (work: PendingWork) => {
      if (!projectOptOut || work.isSwitchesCheck) {
        if ((await reloadProjectOptOut()) && lastRun) {
          const reasons = [...new Set(Object.values(projectOptOut ?? {}))];
          console.log(
            `[Assets] assets.optimization changed in src/CONFIG.ts: ${reasons.length ? `off (${reasons.join('; ')})` : 'all on'}, every asset runs again`
          );
          work.needsRun = work.isAllSelected = work.needsGather = true;
        }
      }
      let assetErrors: PipelineRunResult[] = [];
      if (work.needsRun || (work.needsGather && !lastRun)) {
        try {
          assetErrors = await runPipeline(work);
        } catch (err) {
          // An invalid assets.lock.json or assets.config.json: the generated data stays as it is
          const message = (err as Error).message;
          console.error(`\x1b[31m✗ [Assets] ${message}\x1b[0m`);
          if (work.needsGather) {
            sendGatherEvent(server, work, {
              status: 'failed',
              assetErrors: [],
              willReload: false,
              message: `The asset pipeline could not start: ${message}`,
            });
          }
          sendError(server, '[Asset Pipeline Error] The run could not start', message);
          return;
        }
      }
      if (!work.needsGather || !lastRun) return;

      const isGathered = gatherSceneData({ pipeline: lastRun });
      isLastGatherFailed = !isGathered;
      if (!isGathered) {
        sendGatherEvent(server, work, {
          status: 'failed',
          assetErrors: toAssetErrors(assetErrors),
          willReload: false,
          message: 'The gather failed: check the terminal for its errors',
        });
        sendError(
          server,
          '[Scene Pipeline Error] Consolidation Failed',
          'Check the terminal for the gatherer’s errors.'
        );
      } else if (assetErrors.length) {
        // The gather is done (the asset falls back to its source), but the error needs a look.
        // Vite reloads the page anyway: it changed the generated data, which nothing accepts
        sendGatherEvent(server, work, {
          status: 'done',
          assetErrors: toAssetErrors(assetErrors),
          willReload: true,
        });
        sendError(server, '[Asset Pipeline Error] An asset failed', formatAssetErrors(assetErrors));
      } else {
        sendGatherEvent(server, work, { status: 'done', assetErrors: [], willReload: true });
        server.hot.send({ type: 'full-reload' });
      }
    };

    const flush = async () => {
      timer = null;
      if (isRunning) return; // The run in progress picks it up when it ends
      isRunning = true;
      try {
        while (hasPending) {
          const work = pending;
          pending = createPendingWork();
          hasPending = false;
          try {
            await processWork(work);
          } catch (err) {
            console.error('\x1b[31m✗ [Scene Gatherer]\x1b[0m', err);
            if (work.needsGather) {
              sendGatherEvent(server, work, {
                status: 'failed',
                assetErrors: [],
                willReload: false,
                message: `The gatherer failed: ${(err as Error).message}`,
              });
            }
          }
        }
      } finally {
        isRunning = false;
      }
    };

    const schedule = (update: (work: PendingWork) => void, file?: string) => {
      update(pending);
      if (file) pending.changedFiles.add(file);
      hasPending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), DEBOUNCE_MS);
    };

    const handleFileEvent = (event: 'add' | 'change' | 'unlink') => (filePath: string) => {
      const file = path.resolve(filePath);
      if (file === OUTPUT_FILE_DATA || file === OUTPUT_FILE_FN) return;
      if (file.startsWith(AEK_ASSETS_DIR + path.sep)) return; // The pipeline's own outputs
      if (file.endsWith(DEV_FILES_TEMP_SUFFIX)) return; // A dev files commit renames it into place

      if (file === CONFIG_FILE) {
        schedule((work) => (work.isSwitchesCheck = true), file);
      } else if (file === ASSETS_CONFIG_FILE) {
        schedule((work) => (work.needsRun = work.isAllSelected = work.needsGather = true), file);
      } else if (ASSET_JSON_SUFFIXES.some((suffix) => file.endsWith(suffix))) {
        schedule((work) => {
          work.files.add(file);
          work.needsRun = work.needsGather = true;
        }, file);
      } else if (isFilePathValid(file)) {
        schedule((work) => (work.needsGather = true), file);
      } else if (sourceFiles.has(file) || (event !== 'change' && isLastGatherFailed)) {
        // A source changed, or a file came or went that the failed gather may have missed
        schedule((work) => {
          work.files.add(file);
          work.needsRun = work.needsGather = true;
        }, file);
      }
    };

    server.watcher.on('add', handleFileEvent('add')); // Catches: New files created or moved into src
    server.watcher.on('change', handleFileEvent('change')); // Catches: Standard manual file saves
    server.watcher.on('unlink', handleFileEvent('unlink')); // Catches: Files deleted or moved out/renamed

    // Looks every asset up once (it builds nothing), so the first change has a run to gather with
    schedule((work) => (work.needsRun = true));
  },
});
