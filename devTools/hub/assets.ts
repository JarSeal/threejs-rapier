import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sass from 'sass';
import { build as viteBuild, type Rollup } from 'vite';
import type { HubDiagnostics } from './diagnostics';
import { hashContent } from './hash';
import {
  HUB_ASSETS_DIR,
  HUB_DEV_CLIENT_FILE,
  HUB_DIR,
  HUB_SCSS_ENTRY,
  HUB_STATIC_ASSET_DIRS,
  HUB_TS_DIR,
} from './paths';
import type { HubBuildMode } from './types';

/**
 * The Hub's own assets: `hub.scss` through sass, the TS entries in `hub/_assets/ts/` through
 * Vite's `build()` (ES modules, fixed entry names, hashed shared chunks), and the static folders
 * copied as they are. Entries keep fixed names (`_assets/hub.css`) and get `?v=<hash>` where
 * they're referenced (p550 §3.6).
 */

export type HubAssetFile = {
  /** From the site root: `_assets/hub.js` */
  outPath: string;
  content: string | Buffer;
  hash: string;
};

const ASSETS_URL_DIR = '_assets/';

export const buildStyles = (mode: HubBuildMode, diag: HubDiagnostics): HubAssetFile | null => {
  try {
    const { css } = sass.compile(HUB_SCSS_ENTRY, {
      style: mode === 'public' ? 'compressed' : 'expanded',
    });
    return { outPath: `${ASSETS_URL_DIR}hub.css`, content: css, hash: hashContent(css) };
  } catch (err) {
    if (err instanceof sass.Exception) {
      const url = err.span.url;
      const file = url?.protocol === 'file:' ? fileURLToPath(url) : HUB_SCSS_ENTRY;
      diag.error(file, err.span.start.line + 1, err.sassMessage);
    } else {
      diag.error(HUB_SCSS_ENTRY, undefined, (err as Error).message);
    }
    return null;
  }
};

/** The TS entries: every `.ts` directly in `hub/_assets/ts/`, except `_*.ts` and `.d.ts` */
export const listScriptEntries = () =>
  fs.existsSync(HUB_TS_DIR)
    ? fs
        .readdirSync(HUB_TS_DIR)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.startsWith('_'))
        .map((name) => path.join(HUB_TS_DIR, name))
    : [];

type RollupErrorLike = Error & { loc?: { file?: string; line?: number }; id?: string };

/** The dev client's output: `dev` builds load it on every page (p551 Phase 2) */
export const HUB_DEV_CLIENT_OUT_PATH = `${ASSETS_URL_DIR}hub-dev.js`;

export const buildScripts = async (
  mode: HubBuildMode,
  diag: HubDiagnostics
): Promise<HubAssetFile[] | null> => {
  const input = Object.fromEntries(
    listScriptEntries().map((file) => [path.basename(file, '.ts'), file])
  );
  if (mode === 'dev') input[path.basename(HUB_DEV_CLIENT_OUT_PATH, '.js')] = HUB_DEV_CLIENT_FILE;
  if (!Object.keys(input).length) return [];
  try {
    const result = await viteBuild({
      configFile: false,
      root: HUB_DIR,
      mode: 'production',
      logLevel: 'warn',
      publicDir: false,
      build: {
        write: false,
        minify: mode === 'public',
        target: 'es2021',
        modulePreload: false,
        reportCompressedSize: false,
        copyPublicDir: false,
        rollupOptions: {
          input,
          preserveEntrySignatures: 'strict',
          output: {
            format: 'es',
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
          },
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
    return outputs
      .flatMap(({ output }) => output)
      .map((item) => {
        const content = item.type === 'chunk' ? item.code : Buffer.from(item.source);
        return { outPath: ASSETS_URL_DIR + item.fileName, content, hash: hashContent(content) };
      });
  } catch (err) {
    const { loc, id, message } = err as RollupErrorLike;
    diag.error(loc?.file ?? id ?? HUB_TS_DIR, loc?.line, message);
    return null;
  }
};

/** Copies `hub/_assets/{icons,fonts,images}/` into `<outDir>/_assets/` */
export const copyStaticAssets = (outDir: string) => {
  for (const name of HUB_STATIC_ASSET_DIRS) {
    const source = path.join(HUB_ASSETS_DIR, name);
    if (!fs.existsSync(source)) continue;
    // Licence files go too: the icons' and fonts' licences ask to ship with them
    fs.cpSync(source, path.join(outDir, ASSETS_URL_DIR, name), { recursive: true });
  }
};
