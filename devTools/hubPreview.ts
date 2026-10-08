/* eslint-disable no-console */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { rebaseNotFoundPage } from './hub/build';
import { HUB_DIST_DIR, ROOT } from './hub/paths';

/**
 * `yarn hub:preview [--base /hub/] [--port 8090] [--dir dist-hub]`: serves the built Hub as a
 * static host would: a directory URL serves its `index.html`, anything missing gets `404.html`
 * with a 404. `--base` serves it under a path, as `AEK_HUB_IN_DIST` does (`/hub/`).
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

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
  res.writeHead(status, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
  });
  fs.createReadStream(file).pipe(res);
};

http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (base !== '/' && pathname === base.slice(0, -1)) {
      res.writeHead(301, { Location: base }).end();
      return;
    }
    const notFound = () => {
      const html = fs.readFileSync(path.join(dir, '404.html'), 'utf-8');
      res.writeHead(404, { 'Content-Type': CONTENT_TYPES['.html'] });
      res.end(rebaseNotFoundPage(html, base));
    };
    if (!pathname.startsWith(base)) return notFound();
    const file = path.join(dir, pathname.slice(base.length));
    if (file !== dir && !file.startsWith(dir + path.sep)) return notFound();
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${pathname}/` }).end();
        return;
      }
      const index = path.join(file, 'index.html');
      return fs.existsSync(index) ? send(res, 200, index) : notFound();
    }
    return stat?.isFile() ? send(res, 200, file) : notFound();
  })
  .listen(port, () =>
    console.log(`[Hub] ${path.relative(ROOT, dir)}/ at http://localhost:${port}${base}`)
  );
