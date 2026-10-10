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
/** Dev builds only: the dev plugin's client (p551 Phase 2), built to `_assets/hub-dev.js` */
export const HUB_DEV_CLIENT_FILE = path.join(HUB_TS_DIR, '_devClient.ts');
/** Copied as they are into `_assets/<name>/` */
export const HUB_STATIC_ASSET_DIRS = ['icons', 'fonts', 'images'];
/** The icons, also inlined into the pages (`devTools/hub/icons.ts`) */
export const HUB_ICONS_DIR = path.join(HUB_ASSETS_DIR, 'icons');

/** The outputs (p550 §3.5) */
export const HUB_DEV_OUT_DIR = path.join(ROOT, '.cache', 'hub', 'dev');
/** Where the dev plugin serves `HUB_DEV_OUT_DIR` */
export const HUB_DEV_URL_BASE = '/hub/';
export const HUB_DIST_DIR = path.join(ROOT, 'dist-hub');
/** The app's build: `AEK_HUB_IN_DIST=true` copies the Hub into its `hub/` */
export const APP_DIST_DIR = path.join(ROOT, 'dist');

/** The versions and packages (`getProjectMetadata`) */
export const PACKAGE_JSON_FILE = path.join(ROOT, 'package.json');

/** The TypeScript config: its `typedocOptions` are the API docs' entry points (p553) */
export const TSCONFIG_FILE = path.join(ROOT, 'tsconfig.json');
/** The API model's cache: TypeDoc's JSON and the hash of its inputs (p553 §2.1) */
export const HUB_API_CACHE_FILE = path.join(ROOT, '.cache', 'hub', 'typedoc.json');

/** The generated sections' sources (p551 §2.5) */
export const ISSUES_DIR = path.join(ROOT, 'docs', 'issues');
export const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');

/** The Hub's own favicons (the app's glyph in the Hub's accent), copied to the Hub's root */
export const FAVICON_FILES = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'].map((name) =>
  path.join(HUB_ASSETS_DIR, 'favicons', name)
);

/** The output folder for a page's Markdown images: `_assets/images/pages/<page path>` */
export const PAGE_IMAGES_URL_DIR = '_assets/images/pages/';

/** The app's scenes (p554): the generated data lists them, a scene file's path is from `src/app/` */
export const APP_DATA_FILE = path.join(ROOT, 'src', 'generated', 'generatedAppData.json');
export const APP_SRC_DIR = path.join(ROOT, 'src', 'app');
/** The output folder for the scenes' Hub images: `_assets/images/scenes/<sceneId>-<width>.webp` */
export const SCENE_IMAGES_URL_DIR = '_assets/images/scenes/';

/** A path from the repo root with forward slashes, for messages */
export const toRepoPath = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
