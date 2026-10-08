import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The Hub's sources (p550 §3.2) */
export const HUB_DIR = path.join(ROOT, 'hub');
export const HUB_CONFIG_FILE = path.join(HUB_DIR, 'hub.config.ts');
export const HUB_PAGES_DIR = path.join(HUB_DIR, 'pages');
export const HUB_LAYOUT_DIR = path.join(HUB_DIR, '_layout');
export const HUB_SHELL_FILE = path.join(HUB_LAYOUT_DIR, 'shell.html');
/** The 404 page's body, put into the shell like a page's */
export const HUB_NOT_FOUND_FILE = path.join(HUB_LAYOUT_DIR, '404.html');
export const HUB_ASSETS_DIR = path.join(HUB_DIR, '_assets');
export const HUB_SCSS_ENTRY = path.join(HUB_ASSETS_DIR, 'scss', 'hub.scss');
/** Every `.ts` file directly in it (not `_*.ts`) is an entry, built to `_assets/<name>.js` */
export const HUB_TS_DIR = path.join(HUB_ASSETS_DIR, 'ts');
/** Copied as they are into `_assets/<name>/` */
export const HUB_STATIC_ASSET_DIRS = ['icons', 'fonts', 'images'];

/** The outputs (p550 §3.5) */
export const HUB_DEV_OUT_DIR = path.join(ROOT, '.cache', 'hub', 'dev');
export const HUB_DIST_DIR = path.join(ROOT, 'dist-hub');
/** The app's build: `AEK_HUB_IN_DIST=true` copies the Hub into its `hub/` */
export const APP_DIST_DIR = path.join(ROOT, 'dist');

/** Copied from the app's public folder to the Hub's root */
export const FAVICON_FILES = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'].map((name) =>
  path.join(ROOT, 'src', 'public', name)
);

/** The output folder for a page's Markdown images: `_assets/images/pages/<page path>` */
export const PAGE_IMAGES_URL_DIR = '_assets/images/pages/';

/** A path from the repo root with forward slashes, for messages */
export const toRepoPath = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
