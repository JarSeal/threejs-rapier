/* eslint-disable no-console */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { DevFilesError } from './devFiles/http';
import { checkHostAndOrigin } from './devFiles/security';
import { buildHub, type HubBuildResult } from './hub/build';
import { HUB_DEV_EVENT, HUB_DEV_SOCKET_PLACEHOLDER, type HubDevEvent } from './hub/devProtocol';
import { diagnosticKey, formatDiagnostic } from './hub/diagnostics';
import {
  FAVICON_FILES,
  HUB_ASSETS_DIR,
  HUB_CONFIG_FILE,
  HUB_DEV_OUT_DIR,
  HUB_DEV_URL_BASE,
  HUB_DIR,
  HUB_STATIC_ASSET_DIRS,
  toRepoPath,
} from './hub/paths';
import { getHubContentType, resolveHubRoute } from './hub/serve';

/**
 * The Ækasha Hub in the dev server (p551 §2.3): serves `/hub/` from `.cache/hub/dev/` and keeps
 * it current while `yarn dev` runs. Dev server only, never in a build. `AEK_HUB=false` turns it
 * off.
 * - Lazy: the first build runs on the first `/hub` request (which waits for it), and the watching
 *   starts after it.
 * - Every run builds the whole Hub (tens of ms), then compares the pages with the last run's to
 *   send the custom HMR event `aek:hub` (`HubDevEvent`): `css` when only the stylesheet changed,
 *   `pages` with the pages whose HTML changed, `all` for the scripts and static assets. Never a
 *   `full-reload`: open app tabs aren't touched.
 * - `hub/` is watched with `fs.watch`, not Vite's watcher: Vite logs every watched `.html` save
 *   as a "page reload", clearing the terminal, and sends a `full-reload`. The build's sources
 *   outside `hub/` (`package.json`, `CHANGELOG.md`, `docs/issues/*.md`) and the folders whose new
 *   files it reads (`docs/issues/`) go through Vite's watcher. `hub/hub.config.ts` and the
 *   generator are Vite config dependencies: a change restarts the server, and the open pages
 *   reload once it's back.
 * - A page with an error is served as an error page (`buildHub`), and the terminal gets the
 *   errors and warnings that are new since the last run.
 */

const DEBOUNCE_MS = 100;

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** The `?v=` of these changes with any page's headings or with the SCSS: not a page change */
const VOLATILE_ASSET_REF_REGEX = /(_assets\/(?:hub\.css|hub-data\.js))\?v=[\w-]+/g;

/** Static files copied as they are: no `?v=` changes when they do, so open pages reload */
const STATIC_DIRS = HUB_STATIC_ASSET_DIRS.map((name) => path.join(HUB_ASSETS_DIR, name));
const isStaticAsset = (file: string) =>
  FAVICON_FILES.includes(file) || STATIC_DIRS.some((dir) => file.startsWith(dir + path.sep));

const getPathname = (req: IncomingMessage) => {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return null; // A malformed escape
  }
};

const sendText = (res: ServerResponse, status: number, text: string) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
};

/** The plural `s` */
const s = (count: number) => (count === 1 ? '' : 's');

/** The events open pages need after `next`: none when nothing a page shows changed */
const diffBuilds = (
  prev: HubBuildResult,
  next: HubBuildResult,
  changedFiles: Set<string>
): HubDevEvent[] => {
  const scriptKeys = (build: HubBuildResult) =>
    (build.assets.scripts ?? []).map((file) => `${file.outPath}?${file.hash}`).join();
  if (
    scriptKeys(prev) !== scriptKeys(next) ||
    [...changedFiles].some((file) => isStaticAsset(file))
  ) {
    return [{ kind: 'all' }];
  }

  const events: HubDevEvent[] = [];
  const nextCss = next.assets.styles?.hash;
  if (nextCss && nextCss !== prev.assets.styles?.hash)
    events.push({ kind: 'css', version: nextCss });

  const normalise = (html: string) => html.replace(VOLATILE_ASSET_REF_REGEX, '$1');
  const prevPages = new Map(prev.pages.map((page) => [page.path, normalise(page.html)]));
  const paths = next.pages
    .filter((page) => prevPages.get(page.path) !== normalise(page.html))
    .map((page) => page.path);
  const nextPaths = new Set(next.pages.map((page) => page.path));
  // A removed page's open tab reloads into the 404 page
  paths.push(...prev.pages.filter((page) => !nextPaths.has(page.path)).map((page) => page.path));
  if (paths.length) events.push({ kind: 'pages', paths });
  return events;
};

const describeEvents = (events: HubDevEvent[]) =>
  events
    .map((event) => {
      if (event.kind === 'all') return 'scripts or static assets: every page reloads';
      if (event.kind === 'css') return 'styles';
      const names = event.paths.map((p) => p || '/');
      return `${event.paths.length} page${s(event.paths.length)} (${names.join(', ')})`;
    })
    .join(', ');

export const hubPlugin = (): Plugin => ({
  name: 'vite-plugin-aek-hub',
  apply: 'serve',
  configureServer(server) {
    if (process.env.AEK_HUB === 'false') return;
    const checkOpts = {
      allowedHosts: server.config.server.allowedHosts,
      isHttps: !!server.config.server.https,
    };

    let lastBuild: HubBuildResult | null = null;
    /** The first build (lazy), then the run in progress: requests wait for it */
    let building: Promise<void> | null = null;
    let isWatching = false;
    let isClosed = false;
    let pendingFiles = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hubWatcher: fs.FSWatcher | null = null;
    /** The build's sources and folders outside `hub/`, watched through Vite's watcher */
    let outsideFiles = new Set<string>();
    let outsideDirs = new Set<string>();
    /** The first build's time, shown on the Version page until the server restarts */
    let buildTime: string | undefined;

    const report = (result: HubBuildResult, prev: HubBuildResult | null) => {
      const prevKeys = new Set(prev?.diag.items.map(diagnosticKey));
      for (const item of result.diag.items) {
        if (prevKeys.has(diagnosticKey(item))) continue;
        if (item.level === 'error')
          console.error(`${RED}✗ [Hub] ${formatDiagnostic(item)}${RESET}`);
        else console.warn(`${YELLOW}⚠ [Hub] ${formatDiagnostic(item)}${RESET}`);
      }
      if (prev?.diag.errors.length && result.isOk) {
        console.log(`${GREEN}✓ [Hub] No errors${RESET}`);
      }
    };

    /** Removed pages, and script chunks a TS change renamed (every page reloads for it) */
    const removeStaleFiles = (result: HubBuildResult, prev: HubBuildResult) => {
      const outPaths = (build: HubBuildResult) => [
        ...build.pages.map((page) => page.outPath),
        ...(build.assets.scripts ?? []).map((file) => file.outPath),
      ];
      const current = new Set(outPaths(result));
      for (const outPath of outPaths(prev)) {
        if (!current.has(outPath)) fs.rmSync(path.join(HUB_DEV_OUT_DIR, outPath), { force: true });
      }
    };

    const watchOutsideFiles = ({ files, dirs }: HubBuildResult) => {
      const isOutside = (file: string) => !file.startsWith(HUB_DIR + path.sep);
      outsideFiles = new Set(files.filter(isOutside));
      outsideDirs = new Set(dirs.filter(isOutside));
      server.watcher.add([...outsideFiles, ...outsideDirs]);
    };

    const runBuild = async (changedFiles: Set<string>) => {
      buildTime ??= new Date().toISOString();
      const result = await buildHub({
        mode: 'dev',
        outDir: HUB_DEV_OUT_DIR,
        basePath: HUB_DEV_URL_BASE,
        fallback: lastBuild?.assets,
        buildTime,
      });
      const prev = lastBuild;
      lastBuild = result;
      if (isClosed) return;
      watchOutsideFiles(result);
      report(result, prev);
      if (!prev) {
        const errors = result.diag.errors.length;
        console.log(
          `${errors ? YELLOW : GREEN}${errors ? '⚠' : '✓'} [Hub] ${result.pageCount} page${s(result.pageCount)} at ${HUB_DEV_URL_BASE}${errors ? `, ${errors} with errors` : ''} ${DIM}(${Math.round(result.durationMs)} ms${result.api && !result.api.isCached ? `, the API model extracted in ${(result.api.extractMs / 1000).toFixed(1)} s` : ''})${RESET}`
        );
        return;
      }
      removeStaleFiles(result, prev);
      const events = diffBuilds(prev, result, changedFiles);
      for (const data of events) server.hot.send({ type: 'custom', event: HUB_DEV_EVENT, data });
      if (events.length) {
        console.log(
          `[Hub] Updated: ${describeEvents(events)} ${DIM}(${Math.round(result.durationMs)} ms)${RESET}`
        );
      }
    };

    /** Runs the pending changes, one run at a time; changes during a run go into the next */
    const flush = () => {
      timer = null;
      if (building) return; // The run in progress picks them up when it ends
      const run = async () => {
        while (pendingFiles.size && !isClosed) {
          const files = pendingFiles;
          pendingFiles = new Set();
          try {
            await runBuild(files);
          } catch (err) {
            console.error(`${RED}✗ [Hub] The build failed:${RESET}`, err);
          }
        }
      };
      building = run().finally(() => (building = null));
    };

    const schedule = (file: string) => {
      if (!isWatching || isClosed) return;
      pendingFiles.add(file);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    };

    const startWatching = () => {
      isWatching = true;
      hubWatcher = fs.watch(HUB_DIR, { recursive: true }, (_event, name) => {
        const file = name ? path.join(HUB_DIR, name) : HUB_DIR;
        // Vite restarts the server for it (a config dependency): the next request rebuilds
        if (file !== HUB_CONFIG_FILE) schedule(file);
      });
      hubWatcher.on('error', (err) =>
        console.error(`${RED}✗ [Hub] Watching hub/ failed:${RESET}`, err)
      );
      for (const event of ['add', 'change', 'unlink']) {
        server.watcher.on(event, (filePath: string) => {
          const file = path.resolve(filePath);
          if (outsideFiles.has(file) || outsideDirs.has(path.dirname(file))) schedule(file);
        });
      }
    };

    /** The first request builds; one that comes during a rebuild waits for it */
    const ensureBuilt = async () => {
      if (!lastBuild && !building) {
        // Pages of an earlier session may be gone from hub/ since
        fs.rmSync(HUB_DEV_OUT_DIR, { recursive: true, force: true });
        building = runBuild(new Set())
          .then(startWatching)
          .finally(() => {
            building = null;
            if (pendingFiles.size) flush(); // Saved while it ran
          });
      }
      await building;
      if (!lastBuild) throw new Error('The first Hub build failed: see the terminal');
    };

    /** The socket path and token, for the dev client (never written to disk) */
    const socketPath = () =>
      server.config.server.ws === false
        ? ''
        : `${server.config.base}?token=${encodeURIComponent(server.config.webSocketToken)}`;

    const serve = async (pathname: string, res: ServerResponse) => {
      await ensureBuilt();
      const route = resolveHubRoute(HUB_DEV_OUT_DIR, HUB_DEV_URL_BASE, pathname);
      if (route.kind === 'redirect') {
        res.writeHead(301, { Location: route.location }).end();
        return;
      }
      const file = route.kind === 'file' ? route.file : path.join(HUB_DEV_OUT_DIR, '404.html');
      let content: string | Buffer = fs.readFileSync(file);
      if (file.endsWith('.html')) {
        content = content.toString('utf-8').replace(HUB_DEV_SOCKET_PLACEHOLDER, socketPath());
      }
      res.writeHead(route.kind === 'file' ? 200 : 404, {
        'Content-Type': getHubContentType(file),
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    };

    server.httpServer?.once('close', () => {
      isClosed = true;
      if (timer) clearTimeout(timer);
      hubWatcher?.close();
    });

    server.middlewares.use((req, res, next) => {
      const pathname = getPathname(req);
      if (pathname === null) return next();
      if (pathname !== '/hub' && !pathname.startsWith(HUB_DEV_URL_BASE)) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'The Hub only serves GET and HEAD');
        return;
      }
      // Vite's own host check runs after this, and the pages carry the HMR socket's token
      try {
        checkHostAndOrigin(req, checkOpts);
      } catch (err) {
        if (err instanceof DevFilesError) sendText(res, 403, err.message);
        else throw err;
        return;
      }
      serve(pathname, res).catch((err: Error) => {
        console.error(`${RED}✗ [Hub] ${toRepoPath(HUB_DEV_OUT_DIR)}: ${err.message}${RESET}`);
        if (!res.headersSent) sendText(res, 500, `[Hub] ${err.stack ?? err.message}`);
      });
    });
  },
});
