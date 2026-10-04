/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import { removeStaleOutputs } from './assetPipeline/outputs';
import { ROOT } from './assetPipeline/sources';
import { OUTPUT_FILE_DATA } from './gatherAppData';

/**
 * The production build's asset outputs (p300 Phase 3 step 4): Vite copies all of
 * `src/public/aek-assets/` into `dist/`, which holds more than the build loads: stale outputs
 * (only a full `yarn assets` removes them) and the outputs of debug scenes, which the production
 * data leaves out. After the bundle is written, this removes from `dist/aek-assets/` every file
 * that no `__url` in the bundled generated data points to. `src/public/aek-assets/` is untouched.
 *
 * Every `__url` counts, so a build of dev data (eg. `vite build` without the production gather)
 * keeps every current output instead of too few.
 */

const collectUrls = (value: unknown, urls: Set<string>) => {
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '__url' && typeof item === 'string') urls.add(item);
      else collectUrls(item, urls);
    }
  }
};

const getFileSizes = (dir: string, sizes = new Map<string, number>()) => {
  if (!fs.existsSync(dir)) return sizes;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) getFileSizes(file, sizes);
    else sizes.set(file, fs.statSync(file).size);
  }
  return sizes;
};

const formatBytes = (bytes: number) =>
  bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} KB` : `${(bytes / 1e6).toFixed(2)} MB`;

export const assetOutputsBuildPlugin = (): Plugin => {
  let outDir = '';
  return {
    name: 'vite-plugin-aek-asset-outputs',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const urls = new Set<string>();
      collectUrls(JSON.parse(fs.readFileSync(OUTPUT_FILE_DATA, 'utf-8')), urls);
      const sizes = getFileSizes(path.join(outDir, 'aek-assets'));
      const removed = removeStaleOutputs(urls, outDir);
      let removedBytes = 0;
      for (const file of removed) removedBytes += sizes.get(path.join(ROOT, file)) ?? 0;
      let keptBytes = 0;
      for (const size of sizes.values()) keptBytes += size;
      keptBytes -= removedBytes;
      console.log(
        `\x1b[32m✓ [Assets] ${path.relative(ROOT, outDir)}/aek-assets: ${sizes.size - removed.length} output(s) the shipped scenes load (${formatBytes(keptBytes)})${removed.length ? `, removed ${removed.length} they don't (${formatBytes(removedBytes)})` : ''}\x1b[0m`
      );
    },
  };
};
