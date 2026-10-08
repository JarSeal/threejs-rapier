/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { buildHub, formatBytes, rebaseNotFoundPage } from './hub/build';
import { formatDiagnostic } from './hub/diagnostics';
import { APP_DIST_DIR, HUB_DIST_DIR, ROOT, toRepoPath } from './hub/paths';

/**
 * `yarn hub:build [--out <dir>]`: builds the Ækasha Hub's public site (p551) into `dist-hub/`
 * (emptied first), and exits 1 on an error, without writing anything. `yarn build` runs it last.
 * - `AEK_HUB=false`: does nothing (`yarn build` without the Hub).
 * - `AEK_HUB_IN_DIST=true`: also copies the site into the app's `dist/hub/`, so the app's own
 *   site serves it at `/hub/` (p550 §3.1). Off by default: the Hub isn't in production unless
 *   the developer asks for it.
 */

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

const fail = (message: string) => {
  console.error(`${RED}✗ [Hub] ${message}${RESET}`);
  process.exit(1);
};

const parseArgs = (args: string[]) => {
  let outDir = HUB_DIST_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) outDir = path.resolve(ROOT, args[++i]);
    else fail(`Unknown argument "${args[i]}" (usage: yarn hub:build [--out <dir>])`);
  }
  return { outDir };
};

/**
 * dist/hub/: everything but Netlify's `_headers`, which only works at a site's root, with the 404
 * page's links pointing at `/hub/`
 */
const copyIntoAppDist = (outDir: string) => {
  if (!fs.existsSync(path.join(APP_DIST_DIR, 'index.html'))) {
    fail('AEK_HUB_IN_DIST=true, but dist/ has no app build: run it after `vite build`');
  }
  const target = path.join(APP_DIST_DIR, 'hub');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(outDir, target, {
    recursive: true,
    filter: (file) => path.relative(outDir, file) !== '_headers',
  });
  const notFoundFile = path.join(target, '404.html');
  fs.writeFileSync(
    notFoundFile,
    rebaseNotFoundPage(fs.readFileSync(notFoundFile, 'utf-8'), '/hub/')
  );
  console.log(`${GREEN}✓ [Hub] Copied into ${toRepoPath(target)}/${RESET}`);
};

const main = async () => {
  if (process.env.AEK_HUB === 'false') {
    console.log('[Hub] AEK_HUB=false: not built');
    return;
  }
  const { outDir } = parseArgs(process.argv.slice(2));
  const result = await buildHub({ mode: 'public', outDir });

  for (const warning of result.diag.warnings) {
    console.warn(`${YELLOW}⚠ [Hub] ${formatDiagnostic(warning)}${RESET}`);
  }
  for (const error of result.diag.errors) {
    console.error(`${RED}✗ [Hub] ${formatDiagnostic(error)}${RESET}`);
  }
  if (!result.isOk) {
    const count = result.diag.errors.length;
    fail(`${count} error${count === 1 ? '' : 's'}: ${toRepoPath(outDir)}/ not written`);
  }
  console.log(
    `${GREEN}✓ [Hub] ${result.pageCount} pages → ${toRepoPath(outDir)}/ (${Math.round(result.durationMs)} ms)${RESET}`
  );
  if (result.api) {
    const { isCached, extractMs, moduleCount, symbolCount, coverage } = result.api;
    const share = coverage.total ? Math.round((coverage.documented / coverage.total) * 100) : 100;
    console.log(
      `  API: ${moduleCount} modules, ${symbolCount} symbols, ${share}% documented; model ${isCached ? 'reused' : 'extracted'} (${(extractMs / 1000).toFixed(1)} s)`
    );
  }
  if (result.search) {
    console.log(
      `  Search index: ${formatBytes(result.search.bytes)}, ${result.search.docCount} sections`
    );
  }

  if (process.env.AEK_HUB_IN_DIST === 'true') copyIntoAppDist(outDir);
};

main().catch((err) => fail((err as Error).stack ?? String(err)));
