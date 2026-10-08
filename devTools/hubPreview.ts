/* eslint-disable no-console */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { rebaseNotFoundPage } from './hub/build';
import { HUB_DIST_DIR, ROOT } from './hub/paths';
import { getHubContentType, resolveHubRoute } from './hub/serve';

/**
 * `yarn hub:preview [--base /hub/] [--port 8090] [--dir dist-hub]`: serves the built Hub as a
 * static host would: a directory URL serves its `index.html`, anything missing gets `404.html`
 * with a 404. `--base` serves it under a path, as `AEK_HUB_IN_DIST` does (`/hub/`).
 */

const parseArgs = (args: string[]) => {
  const opts = { base: '/', port: 8090, dir: HUB_DIST_DIR };
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === '--base' && value)
      opts.base = `/${value.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
    else if (args[i] === '--port' && value) opts.port = Number(value);
    else if (args[i] === '--dir' && value) opts.dir = path.resolve(ROOT, value);
    else throw new Error(`Unknown argument "${args[i]}"`);
  }
  return opts;
};

const { base, port, dir } = parseArgs(process.argv.slice(2));
if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error(`No Hub build in ${dir}: run yarn hub:build first`);
  process.exit(1);
}

const send = (res: http.ServerResponse, status: number, file: string) => {
  res.writeHead(status, { 'Content-Type': getHubContentType(file) });
  fs.createReadStream(file).pipe(res);
};

http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const route = resolveHubRoute(dir, base, pathname);
    if (route.kind === 'redirect') {
      res.writeHead(301, { Location: route.location }).end();
    } else if (route.kind === 'file') {
      send(res, 200, route.file);
    } else {
      const html = fs.readFileSync(path.join(dir, '404.html'), 'utf-8');
      res.writeHead(404, { 'Content-Type': getHubContentType('404.html') });
      res.end(rebaseNotFoundPage(html, base));
    }
  })
  .listen(port, () =>
    console.log(`[Hub] ${path.relative(ROOT, dir)}/ at http://localhost:${port}${base}`)
  );
