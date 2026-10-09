import fs from 'node:fs';
import path from 'node:path';
import type { HubDiagnostics } from './diagnostics';
import { hashContent } from './hash';
import { escapeHtml } from './html';
import {
  addImageJob,
  registerHubDirective,
  resolveHubLink,
  type HubMarkdownEnv,
  type HubRenderContext,
} from './markdown';
import {
  APP_DATA_FILE,
  APP_SRC_DIR,
  PAGE_IMAGES_URL_DIR,
  ROOT,
  SCENE_IMAGES_URL_DIR,
  toRepoPath,
} from './paths';
import type { HubPage } from './types';

/**
 * The app's scenes on Hub pages (p554 §2.4-2.5):
 * - `::: scene <sceneId>` … `:::`: the scene's Hub image, the directive's content, and in `dev`
 *   "Open in debug" / "Open in prod test" buttons (`?startScene=<sceneId>`), in `public` a note
 *   on running it locally;
 * - a scene's Hub image is `<sceneId>.hub.png` beside its scene file, written by the example
 *   scenes' Hub tab (`src/app/examples/_dbg__exampleHub.ts`, the same path rule), converted to
 *   webp at the widths the layout shows it;
 * - `aek:image` in a page's head (`scene:<sceneId>` or a path from the repo root), which a
 *   `::: cards` shows (`cards.ts`).
 * The scene ids come from the generated app data, the data `?startScene` checks, so a scene the
 * Hub links is one the app loads. `yarn build` gathers the development data again before
 * `hub:build`, so it has every scene, debug scenes too.
 */

export type HubAppScene = {
  id: string;
  /** The scene JSON's `name`, else its id */
  name: string;
  /** `<sceneFile's folder>/<sceneId>.hub.png`, whether it's there or not */
  imageFile: string;
};

export type HubAppScenes =
  | { byId: Map<string, HubAppScene>; error: null }
  | { byId: null; error: string };

export const HUB_IMAGE_SUFFIX = '.hub.png';

/** The widths a scene's image is converted to: the content column (46rem) at 1x and 2x */
const SCENE_IMAGE_WIDTHS = [800, 1600];
const SCENE_IMAGE_SIZES = '(min-width: 46rem) 46rem, 100vw';

type GeneratedScenes = { scenes?: Record<string, { name?: string; sceneFile?: string }> };

/** Reads the generated app data's scenes (a scene file's path is from `src/app/`) */
export const loadAppScenes = (): HubAppScenes => {
  let data: GeneratedScenes;
  try {
    data = JSON.parse(fs.readFileSync(APP_DATA_FILE, 'utf-8')) as GeneratedScenes;
  } catch (err) {
    return {
      byId: null,
      error: `The app's scenes can't be read from ${toRepoPath(APP_DATA_FILE)} (run yarn gatherAppData): ${(err as Error).message}`,
    };
  }
  const byId = new Map<string, HubAppScene>();
  for (const [id, scene] of Object.entries(data.scenes ?? {})) {
    if (!scene.sceneFile) continue;
    const dir = path.dirname(path.resolve(APP_SRC_DIR, scene.sceneFile));
    byId.set(id, {
      id,
      name: scene.name || id,
      imageFile: path.join(dir, `${id}${HUB_IMAGE_SUFFIX}`),
    });
  }
  return { byId, error: null };
};

/** A PNG's size from its IHDR chunk, null when it isn't a PNG */
const readPngSize = (file: string) => {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const isPng =
    header.readUInt32BE(0) === 0x89504e47 && header.toString('ascii', 12, 16) === 'IHDR';
  return isPng ? { width: header.readUInt32BE(16), height: header.readUInt32BE(20) } : null;
};

/** Finds a scene, with an error at `file`:`line` when there's no such scene (or no data) */
const findScene = (
  id: string,
  env: HubRenderContext,
  diag: HubDiagnostics,
  file: string,
  line?: number
) => {
  const scenes = env.getAppScenes();
  if (scenes.error !== null) {
    diag.error(file, line, scenes.error);
    return null;
  }
  const scene = scenes.byId.get(id);
  if (!scene) {
    diag.error(
      file,
      line,
      `Unknown scene "${id}": ${toRepoPath(APP_DATA_FILE)} has ${[...scenes.byId.keys()].sort().join(', ')}`
    );
  }
  return scene ?? null;
};

/** The scene's Hub image as webp sources (an image job per width), or null when there's none yet */
const getSceneImageSources = (
  scene: HubAppScene,
  env: HubMarkdownEnv,
  file: string,
  line: number,
  imageWidths = SCENE_IMAGE_WIDTHS
) => {
  env.includes.push(scene.imageFile); // Watched also before it's there: saving it rebuilds
  if (!fs.existsSync(scene.imageFile)) {
    env.diag.warn(
      file,
      line,
      `The scene "${scene.id}" has no Hub image yet (${toRepoPath(scene.imageFile)}): save it from the scene's Hub tab`
    );
    return null;
  }
  const size = readPngSize(scene.imageFile);
  if (!size) {
    env.diag.error(file, line, `Not a PNG: ${toRepoPath(scene.imageFile)}`);
    return null;
  }
  const hash = hashContent(fs.readFileSync(scene.imageFile));
  const widths = [...new Set(imageWidths.map((width) => Math.min(width, size.width)))];
  const urls = widths.map((width) => {
    const outPath = `${SCENE_IMAGES_URL_DIR}${scene.id}-${width}.webp`;
    addImageJob(env, { source: scene.imageFile, outPath, isConverted: true, width });
    return { width, url: `${env.root}${outPath}?v=${hash}` };
  });
  return {
    src: urls[0].url,
    srcset: urls.map(({ width, url }) => `${url} ${width}w`).join(', '),
    width: size.width,
    height: size.height,
  };
};

/** The scene's Hub image as an `<img>` with its webp sizes, or null when there's none yet */
const renderSceneImage = (scene: HubAppScene, env: HubMarkdownEnv, line: number) => {
  const image = getSceneImageSources(scene, env, env.file, line);
  if (!image) return null;
  return `<img class="hubSceneImage" src="${image.src}" srcset="${image.srcset}" sizes="${SCENE_IMAGE_SIZES}" width="${image.width}" height="${image.height}" alt="${escapeHtml(scene.name)}, rendered by the engine" loading="lazy" decoding="async" />`;
};

const SCENE_ID_REGEX = /^[\w-]+$/;

/** An `<img>` in a page's markup that shows a scene's Hub image: `data-aek-scene="<sceneId>"` */
export const SCENE_IMG_TAG_REGEX = /<img\b[^>]*?\sdata-aek-scene="([^"]*)"[^>]*>/g;

/**
 * Resolves an `<img data-aek-scene="<sceneId>">` of a page's markup (its other placeholders
 * already resolved): with the scene's Hub image saved, its `src`, `srcset`, `width` and `height`
 * become the image's webp, and it gets the class `hubSceneRender`; without one, it keeps its own
 * `src` (a fallback) and the build warns. Its other attributes (class, alt, sizes) are kept.
 */
export const resolveSceneImageTag = (
  tag: string,
  sceneId: string,
  env: HubMarkdownEnv,
  file: string,
  line: number
) => {
  const plain = tag.replace(/\s+data-aek-scene="[^"]*"/, '');
  if (!SCENE_ID_REGEX.test(sceneId)) {
    env.diag.error(file, line, `data-aek-scene needs a scene id, not "${sceneId}"`);
    return plain;
  }
  const scene = findScene(sceneId, env, env.diag, file, line);
  const image = scene ? getSceneImageSources(scene, env, file, line) : null;
  if (!image) return plain;
  const attrs: Record<string, string> = {
    src: image.src,
    srcset: image.srcset,
    width: String(image.width),
    height: String(image.height),
  };
  let resolved = plain;
  for (const [name, value] of Object.entries(attrs)) {
    const attrRegex = new RegExp(`\\s${name}="[^"]*"`);
    resolved = attrRegex.test(resolved)
      ? resolved.replace(attrRegex, ` ${name}="${value}"`)
      : resolved.replace(/^<img\b/, `<img ${name}="${value}"`);
  }
  return /\sclass="/.test(resolved)
    ? resolved.replace(/\sclass="([^"]*)"/, ' class="$1 hubSceneRender"')
    : resolved.replace(/^<img\b/, '<img class="hubSceneRender"');
};

registerHubDirective('scene', {
  open: (args, { env, line }) => {
    const id = args.trim();
    if (!SCENE_ID_REGEX.test(id)) {
      env.diag.error(env.file, line, `::: scene needs a scene id ("::: scene examplePhysics")`);
      return '<div class="hubScene">\n<div class="hubSceneBody">\n';
    }
    env.includes.push(APP_DATA_FILE);
    const scene = findScene(id, env, env.diag, env.file, line);
    let image = scene ? renderSceneImage(scene, env, line) : null;
    if (!image && scene && env.mode === 'dev') {
      image = `<p class="hubSceneNoImage">No Hub image yet: open the scene in debug and press <strong>Save Hub image</strong> in its Hub tab.</p>`;
    }
    return `<div class="hubScene">\n${image ?? ''}<div class="hubSceneBody">\n`;
  },
  close: (args, { env, line }) => {
    const id = args.trim();
    if (!SCENE_ID_REGEX.test(id)) return '</div>\n</div>\n';
    if (env.mode === 'dev') {
      const link = (param: string, icon: string, label: string) =>
        `<a class="hubButton" href="/?${param}=true&amp;startScene=${id}" target="_blank" rel="noopener">${env.icons.render(icon, env.file, line)}${label}${env.icons.render('arrow-right', env.file, line)}</a>`;
      return `<p class="hubSceneLinks">${link('isDebug', 'bug', 'Open in debug')}${link('isProdTest', 'play', 'Open in prod test')}</p>\n</div>\n</div>\n`;
    }
    // The public Hub runs no engine (p550 §1): how to run it, the same for every scene
    const quickStart = resolveHubLink('hub:examples#quick-start', env, env.file, line);
    return `<p class="hubSceneNote">Run it locally: start the dev server (<code>yarn dev</code>, see the <a href="${quickStart}">quick start</a>), then open <code>http://localhost:8080/?isDebug=true&amp;startScene=${id}</code>, or <code>?isProdTest=true&amp;startScene=${id}</code> to run it as in production.</p>\n</div>\n</div>\n`;
  },
});

/**
 * Checks a page's `aek:image`: a scene's Hub image (`scene:<sceneId>`, a warning while it isn't
 * saved yet) or an image at a path from the repo root
 * @returns its file (null without one), and the files the dev plugin watches for it
 */
export const resolvePageImage = (
  page: HubPage,
  context: HubRenderContext,
  diag: HubDiagnostics
): { file: string | null; dependencies: string[] } => {
  if (!page.image) return { file: null, dependencies: [] };
  const sceneMatch = /^scene:(.*)$/.exec(page.image);
  if (sceneMatch) {
    const scene = findScene(sceneMatch[1].trim(), context, diag, page.file);
    if (!scene) return { file: null, dependencies: [APP_DATA_FILE] };
    const dependencies = [APP_DATA_FILE, scene.imageFile];
    if (fs.existsSync(scene.imageFile)) return { file: scene.imageFile, dependencies };
    diag.warn(
      page.file,
      undefined,
      `aek:image: the scene "${scene.id}" has no Hub image yet (${toRepoPath(scene.imageFile)})`
    );
    return { file: null, dependencies };
  }
  const file = path.resolve(ROOT, page.image);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) {
    diag.error(page.file, undefined, `aek:image: no such file from the repo root: ${page.image}`);
    return { file: null, dependencies: [] };
  }
  if (!/\.(png|jpe?g|webp)$/i.test(file)) {
    diag.error(page.file, undefined, `aek:image: not a PNG, JPEG or WebP: ${page.image}`);
    return { file: null, dependencies: [] };
  }
  return { file, dependencies: [file] };
};

export type HubImageSources = {
  src: string;
  srcset: string;
  /** The source's size, null when it isn't a PNG (the layout then sets the aspect ratio) */
  width: number | null;
  height: number | null;
};

/**
 * A page's `aek:image` (resolved by `resolvePageImage` first) as webp sources at `widths`, for
 * an image of it on another page (`::: cards`), or null without one. A scene's image shares its
 * outputs with the scene's panels (`_assets/images/scenes/<sceneId>-<width>.webp`), a file's go
 * beside the page's own images.
 */
export const getPageImageSources = (
  page: HubPage,
  env: HubMarkdownEnv,
  widths: number[],
  line: number
): HubImageSources | null => {
  if (!page.imageFile) return null;
  const sceneMatch = /^scene:(.*)$/.exec(page.image);
  if (sceneMatch) {
    const scene = env.getAppScenes().byId?.get(sceneMatch[1].trim());
    return scene ? getSceneImageSources(scene, env, env.file, line, widths) : null;
  }
  const source = page.imageFile;
  const size = /\.png$/i.test(source) ? readPngSize(source) : null;
  const hash = hashContent(fs.readFileSync(source));
  const urls = widths.map((width) => {
    const outPath = `${PAGE_IMAGES_URL_DIR}${page.path}aek-image-${width}.webp`;
    addImageJob(env, { source, outPath, isConverted: true, width });
    return { width, url: `${env.root}${outPath}?v=${hash}` };
  });
  return {
    src: urls[0].url,
    srcset: urls.map(({ width, url }) => `${url} ${width}w`).join(', '),
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
};
