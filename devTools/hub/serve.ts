import fs from 'node:fs';
import path from 'node:path';

/**
 * How a built Hub is served, as a static host would serve it: a directory URL serves its
 * `index.html` (without the trailing slash it redirects to it), anything missing is the 404 page.
 * Shared by `yarn hub:preview` and the dev plugin.
 */

export const HUB_CONTENT_TYPES: Record<string, string> = {
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

export const getHubContentType = (file: string) =>
  HUB_CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';

export type HubRoute =
  | { kind: 'file'; file: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'notFound' };

/**
 * The response for a URL path under `base` (`/`, `/hub/`), served from `dir`. `pathname` is
 * decoded; the base without its slash (`/hub`) redirects to it.
 */
export const resolveHubRoute = (dir: string, base: string, pathname: string): HubRoute => {
  if (base !== '/' && pathname === base.slice(0, -1)) return { kind: 'redirect', location: base };
  if (!pathname.startsWith(base)) return { kind: 'notFound' };
  const file = path.join(dir, pathname.slice(base.length));
  if (file !== dir && !file.startsWith(dir + path.sep)) return { kind: 'notFound' };
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    if (!pathname.endsWith('/')) return { kind: 'redirect', location: `${pathname}/` };
    const index = path.join(file, 'index.html');
    return fs.existsSync(index) ? { kind: 'file', file: index } : { kind: 'notFound' };
  }
  return stat?.isFile() ? { kind: 'file', file } : { kind: 'notFound' };
};
