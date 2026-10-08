import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import hubConfig from '../../hub/hub.config';
import { getProjectMetadata } from '../projectMetadata';
import {
  buildScripts,
  buildStyles,
  ASSETS_URL_DIR,
  copyStaticAssets,
  createStaticAssetHasher,
  HUB_DEV_CLIENT_OUT_PATH,
  type HubAssetFile,
} from './assets';
import { createApiSection, type ApiBuildStats } from './api/render';
import { buildHubData, getPageSection } from './data';
import { hubCodePlugin, loadHubHighlighter } from './code';
import { buildSearchIndex } from './search';
import { createIssuesSection } from './generated/issues';
import type { HubGeneratedSection, HubSlotGenerator } from './generated/section';
import { createVersionSection } from './generated/version';
import { HUB_DEV_META, HUB_DEV_SOCKET_PLACEHOLDER } from './devProtocol';
import { HubDiagnostics, lineAt, type HubDiagnostic } from './diagnostics';
import { escapeHtml } from './html';
import { loadHubIcons } from './icons';
import {
  createHubMarkdown,
  createMarkdownEnv,
  isApiLink,
  renderMarkdown,
  resolveApiLink,
  resolveHubLink,
  type HubImageJob,
  type HubMarkdownEnv,
} from './markdown';
import { discoverPages, relativeRoot, type HubPageTree } from './pages';
import {
  FAVICON_FILES,
  HUB_NOT_FOUND_FILE,
  HUB_PAGES_DIR,
  HUB_SHELL_FILE,
  PACKAGE_JSON_FILE,
  toRepoPath,
} from './paths';
import {
  fillShell,
  pageHref,
  PLACEHOLDER_REGEX,
  renderBreadcrumbs,
  renderNav,
  renderToc,
  type HubMarkupHelpers,
  type ShellPageValues,
  type ShellSiteValues,
} from './shell';
import type { HubBuildMode, HubHeading, HubPage } from './types';

/**
 * Builds the Hub (p551 §2.2): `hub/` → static pages in `outDir`, in the layout p550 §3.5
 * describes. `public` (`yarn hub:build` → `dist-hub/`) writes nothing when there's an error.
 * `dev` (the dev plugin, `devTools/hubPlugin.ts`) writes every page, and a page with an error
 * becomes an error page listing it (§2.3): one in its own files, or one that isn't any page's
 * (the shell, the SCSS, the TS), which every page lists. Dev pages also load the dev client.
 */

export type HubBuildAssets = {
  styles: HubAssetFile | null;
  scripts: HubAssetFile[] | null;
};

export type HubBuildOptions = {
  mode: HubBuildMode;
  outDir: string;
  /** The site root's absolute URL path, for the 404 page's `<base>` (default `/`) */
  basePath?: string;
  /** `dev`: the last build's assets, kept when this build's fail, so error pages keep styles */
  fallback?: HubBuildAssets;
  /**
   * The build time the Version page and `hub-data.js` show (default now). The dev plugin passes
   * its first build's, so a rebuild doesn't change the Version page by itself.
   */
  buildTime?: string;
};

export type HubBuiltPage = {
  /** The page's site path ('' the homepage), '404' for the 404 page */
  path: string;
  /** From `outDir`: `examples/index.html`, `404.html` */
  outPath: string;
  html: string;
  /** `dev`: an error page stands in for it */
  isErrorPage: boolean;
};

export type HubBuildResult = {
  isOk: boolean;
  diag: HubDiagnostics;
  pageCount: number;
  durationMs: number;
  /** Every source file the build read, for the dev plugin's watcher */
  files: string[];
  /** Folders whose added and removed files change the build (`docs/issues/`) */
  dirs: string[];
  /** The pages and the 404 page as written; empty when nothing was */
  pages: HubBuiltPage[];
  assets: HubBuildAssets;
  /**
   * The search index's size (`hub:build` reports it), its documents and how many of them are
   * page sections (the rest are the API's), null when not built
   */
  search: { bytes: number; docCount: number; pageDocCount: number } | null;
  /** The API docs (p553): whether the model was reused, its size, null when it didn't build */
  api: ApiBuildStats | null;
};

/** p552 §2.4: over it, the build warns (the API docs are the risk) */
const SEARCH_INDEX_WARN_BYTES = 1024 * 1024;

export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} kB`
    : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

/**
 * The 404 page is served at any depth, so its links resolve against a `<base>`: the site root's
 * absolute path, `/` by default. `rebaseNotFoundPage` moves a built one (`AEK_HUB_IN_DIST`'s
 * `dist/hub/`, `yarn hub:preview --base`).
 */
const notFoundBaseTag = (basePath: string) => `<base href="${escapeHtml(basePath)}" />`;

export const rebaseNotFoundPage = (html: string, basePath: string) =>
  html.replace(/<base href="[^"]*" \/>/, notFoundBaseTag(basePath));

/** Netlify's headers (p550 §3.6): every `_assets/` reference carries `?v=<hash>` */
const NETLIFY_HEADERS = `/_assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

type RenderedPage = { page: HubPage; body: string; env: HubMarkdownEnv };

/** `href="hub:…"` and `src="hub:…"` in a page's own markup, and `href="api:…"` */
const HTML_HUB_LINK_REGEX = /\b(href|src)=(["'])((?:hub|api):[^"']*)\2/g;

/** The markup helpers a page's own markup can use (`{{link:…}}` is the shell's: pages use `hub:`) */
const PAGE_HELPERS = ['icon', 'asset'] as const;

/** The page's markup with its `hub:` links resolved, `{{root}}` and its markup helpers filled */
const resolvePageMarkup = (
  markup: string,
  offset: number,
  env: HubMarkdownEnv,
  helpers: HubMarkupHelpers
) => {
  const lineOf = (at: number) => env.page.bodyLine + lineAt(env.page.body, offset + at) - 1;
  return markup
    .replace(
      HTML_HUB_LINK_REGEX,
      (_match, attr: string, quote: string, href: string, at: number) =>
        `${attr}=${quote}${(isApiLink(href) ? resolveApiLink : resolveHubLink)(href, env, env.page.file, lineOf(at))}${quote}`
    )
    .replace(PLACEHOLDER_REGEX, (match, key: string, arg: string | undefined, at: number) => {
      if (arg === undefined) return key === 'root' ? env.root : match;
      if ((PAGE_HELPERS as readonly string[]).includes(key)) {
        return helpers[key as (typeof PAGE_HELPERS)[number]](
          arg,
          env.root,
          env.page.file,
          lineOf(at)
        );
      }
      env.diag.error(
        env.page.file,
        lineOf(at),
        `Unknown placeholder ${match} (a page has {{root}}, ${PAGE_HELPERS.map((name) => `{{${name}:…}}`).join(', ')})`
      );
      return '';
    });
};

/** A generated slot's key: `issues/#generated-issues` */
const slotKey = (pagePath: string, slotId: string) => `${pagePath}#${slotId}`;

/** The page's body with its slots filled by their Markdown, or by their section's generator */
const renderPageBody = (
  page: HubPage,
  env: HubMarkdownEnv,
  md: ReturnType<typeof createHubMarkdown>,
  helpers: HubMarkupHelpers,
  generators: Map<string, HubSlotGenerator>
) => {
  let body = '';
  let cursor = 0;
  for (const slot of page.slots) {
    body += resolvePageMarkup(page.body.slice(cursor, slot.offset), cursor, env, helpers);
    const generate = slot.isGenerated ? generators.get(slotKey(page.path, slot.id)) : undefined;
    const content = generate
      ? generate(md, env)
      : slot.mdFile
        ? renderMarkdown(md, slot.mdFile, env)
        : '';
    body += `${slot.openTag}\n${content}${slot.closeTag}`;
    cursor = slot.offset + slot.length;
  }
  return body + resolvePageMarkup(page.body.slice(cursor), cursor, env, helpers);
};

/** A `hub:` link must reach a page, and its `#hash` an id on that page */
const checkLinks = (rendered: RenderedPage[], tree: HubPageTree, diag: HubDiagnostics) => {
  const envs = new Map(rendered.map(({ page, env }) => [page.path, env]));
  for (const { env } of rendered) {
    for (const link of env.links) {
      const target = tree.byPath.get(link.targetPath);
      if (!target) {
        diag.error(
          link.file,
          link.line,
          `Dead link ${link.raw}: no page at hub/pages/${link.targetPath}index.html`
        );
      } else if (link.hash && !envs.get(target.path)?.ids.has(link.hash)) {
        diag.error(
          link.file,
          link.line,
          `Dead link ${link.raw}: "${target.title}" has no #${link.hash}`
        );
      }
    }
  }
};

const writeFile = (file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** `dev` writes into the same folder every run: an image newer than its source is kept */
const isUpToDate = (source: string, out: string) =>
  (fs.statSync(out, { throwIfNoEntry: false })?.mtimeMs ?? -1) >= fs.statSync(source).mtimeMs;

const writeImages = async (
  jobs: HubImageJob[],
  outDir: string,
  mode: HubBuildMode,
  diag: HubDiagnostics
) => {
  await Promise.all(
    jobs.map(async ({ source, outPath, isConverted }) => {
      const out = path.join(outDir, outPath);
      if (mode === 'dev' && isUpToDate(source, out)) return;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try {
        if (isConverted) await sharp(source).webp({ quality: 85 }).toFile(out);
        else fs.copyFileSync(source, out);
      } catch (err) {
        diag.error(source, undefined, `The image could not be written: ${(err as Error).message}`);
      }
    })
  );
};

/**
 * The page a file belongs to: a generated section's source (`pagesByFile`), else the page whose
 * folder holds it (an `.md`, an image), or null for one outside the pages
 */
const findOwnerPage = (
  file: string,
  pagesByDir: Map<string, HubPage>,
  pagesByFile: Map<string, HubPage>
) => {
  const owner = pagesByFile.get(file);
  if (owner) return owner;
  for (
    let dir = path.dirname(file);
    dir === HUB_PAGES_DIR || dir.startsWith(HUB_PAGES_DIR + path.sep);
    dir = path.dirname(dir)
  ) {
    const page = pagesByDir.get(dir);
    if (page) return page;
  }
  return null;
};

const renderErrorBody = (errors: HubDiagnostic[]) => {
  const items = errors.map(
    ({ file, line, message }) =>
      `<li><code>${escapeHtml(toRepoPath(file))}${line ? `:${line}` : ''}</code> ${escapeHtml(message)}</li>`
  );
  return `<h1>Build error</h1>
<p>This page didn't build. Fix ${errors.length === 1 ? 'the error' : 'the errors'} and save: the page reloads by itself.</p>
<ul class="hubBuildErrors">${items.join('')}</ul>`;
};

export const buildHub = async ({
  mode,
  outDir,
  basePath = '/',
  fallback,
  buildTime,
}: HubBuildOptions): Promise<HubBuildResult> => {
  const startTime = performance.now();
  const diag = new HubDiagnostics();
  const rendered: RenderedPage[] = [];
  const builtPages: HubBuiltPage[] = [];
  const assets: HubBuildAssets = { styles: null, scripts: null };
  const meta = getProjectMetadata();
  if (buildTime) meta.build.time = buildTime;
  const version = createVersionSection(meta, diag);
  const api = await createApiSection({ mode, diag, meta });
  const sections: HubGeneratedSection[] = [createIssuesSection(diag), version.section, api.section];
  const sectionDirs = sections.flatMap((section) => section.dirs);
  let searchStats: HubBuildResult['search'] = null;
  const result = (files: string[]): HubBuildResult => ({
    isOk: diag.errors.length === 0,
    diag,
    pageCount: rendered.length,
    durationMs: performance.now() - startTime,
    files,
    dirs: sectionDirs,
    pages: builtPages,
    assets,
    search: searchStats,
    api: api.stats,
  });

  const tree = discoverPages(diag, sections);
  const generators = new Map<string, HubSlotGenerator>();
  for (const section of sections) {
    for (const [id, generate] of Object.entries(section.slots)) {
      generators.set(slotKey(section.path, id), generate);
    }
    for (const page of section.pages) {
      for (const [id, generate] of Object.entries(page.slots)) {
        generators.set(slotKey(page.path, id), generate);
      }
    }
  }
  const shell = fs.readFileSync(HUB_SHELL_FILE, 'utf-8');
  const notFoundBody = fs.readFileSync(HUB_NOT_FOUND_FILE, 'utf-8');
  const icons = loadHubIcons(diag);
  const hashStaticAsset = createStaticAssetHasher();
  const helpers: HubMarkupHelpers = {
    icon: (name, _root, file, line) => icons.render(name, file, line),
    asset: (assetPath, root, file, line) => {
      const hash = hashStaticAsset(assetPath);
      if (hash) return `${root}${ASSETS_URL_DIR}${assetPath}?v=${hash}`;
      diag.error(file, line, `{{asset:${assetPath}}}: no such file in hub/_assets/`);
      return '';
    },
    link: (sitePath, root, file, line) => {
      const target = tree?.byPath.get(`${sitePath.replace(/^\/+|\/+$/g, '')}/`);
      if (target) return pageHref(root, target);
      diag.error(file, line, `Dead link {{link:${sitePath}}}: no page at hub/pages/${sitePath}/`);
      return '';
    },
  };
  assets.styles = buildStyles(mode, diag, hashStaticAsset) ?? fallback?.styles ?? null;
  assets.scripts = (await buildScripts(mode, diag)) ?? fallback?.scripts ?? null;
  // `dev` still writes the 404 page, as the error page every URL gets
  const sectionFiles = sections.flatMap((section) => section.files);
  if (!tree && mode === 'public') return result(sectionFiles);

  const md = createHubMarkdown().use(hubCodePlugin, {
    highlighter: await loadHubHighlighter(),
    icons,
  });
  for (const page of tree?.pages ?? []) {
    const env = createMarkdownEnv(page, relativeRoot(page.path), diag, api.links);
    rendered.push({ page, env, body: renderPageBody(page, env, md, helpers, generators) });
  }
  if (tree) checkLinks(rendered, tree, diag);

  const headings = new Map<HubPage, HubHeading[]>(
    rendered.map(({ page, env }) => [page, env.headings])
  );
  const assetUrl = (root: string, file: HubAssetFile | null | undefined) =>
    file ? `${root}${file.outPath}?v=${file.hash}` : '';
  const search = tree
    ? buildSearchIndex(
        rendered,
        sections.flatMap((section) => section.searchDocs ?? [])
      )
    : null;
  if (search) {
    const { content, docCount, pageDocCount } = search;
    searchStats = { bytes: content.length, docCount, pageDocCount };
  }
  if (search && search.content.length > SEARCH_INDEX_WARN_BYTES) {
    diag.warn(
      HUB_PAGES_DIR,
      undefined,
      `The search index is ${formatBytes(search.content.length)}, over ${formatBytes(SEARCH_INDEX_WARN_BYTES)}: index fewer fields (p552 §2.4)`
    );
  }
  // After the render: the changelog's render fills `latestChange.hash`
  const data =
    tree && search
      ? buildHubData(
          meta,
          tree.root,
          tree.pages,
          headings,
          version.latestChange,
          // Relative to `_assets/`, where hub.js resolves it from
          assetUrl('', search).slice(ASSETS_URL_DIR.length)
        )
      : null;
  const findScript = (outPath: string) => assets.scripts?.find((file) => file.outPath === outPath);
  const devClient = mode === 'dev' ? findScript(HUB_DEV_CLIENT_OUT_PATH) : undefined;

  const siteValues = (root: string, page: HubPage | null): ShellSiteValues => ({
    root,
    siteTitle: escapeHtml(hubConfig.title),
    head: devClient
      ? `<meta name="${HUB_DEV_META}" content="${HUB_DEV_SOCKET_PLACEHOLDER}" />
    <script type="module" src="${assetUrl(root, devClient)}"></script>`
      : '',
    nav: tree ? renderNav(tree.root, page, root, icons) : '',
    css: assetUrl(root, assets.styles),
    js: assetUrl(root, findScript('_assets/hub.js')),
    dataJs: assetUrl(root, data),
    engineVersion: meta.engine.version,
    githubUrl: escapeHtml(hubConfig.githubUrl),
  });

  const pageValues = ({ page, env, body }: RenderedPage): ShellPageValues => {
    const isHome = page === tree?.root;
    const section = getPageSection(page);
    return {
      title: escapeHtml(isHome ? hubConfig.title : `${page.title} · ${hubConfig.title}`),
      pageTitle: escapeHtml(page.title),
      description: escapeHtml(page.description || (isHome ? hubConfig.description : '')),
      pagePath: page.path,
      section,
      bodyClass: `hubPage_${section.replace(/\/$/, '') || 'home'}`,
      breadcrumbs: renderBreadcrumbs(page, env.root),
      // The homepage's sections are its layout, not a document to jump around in
      toc: isHome ? '' : renderToc(env.headings),
      body,
    };
  };
  const notFoundValues: ShellPageValues = {
    title: escapeHtml(`Page not found · ${hubConfig.title}`),
    pageTitle: 'Page not found',
    description: '',
    pagePath: '404',
    section: '404',
    bodyClass: 'hubPage_404',
    breadcrumbs: '',
    toc: '',
    body: notFoundBody,
  };
  const fillPage = (root: string, page: HubPage | null, values: ShellPageValues, head = '') => {
    const site = siteValues(root, page);
    return fillShell(
      shell,
      HUB_SHELL_FILE,
      { ...site, head: [head, site.head].filter(Boolean).join('\n    '), ...values },
      helpers,
      diag
    );
  };

  for (const item of rendered) {
    const html = fillPage(item.env.root, item.page, pageValues(item));
    builtPages.push({
      path: item.page.path,
      outPath: `${item.page.path}index.html`,
      html,
      isErrorPage: false,
    });
  }
  const notFoundHtml = fillPage('', null, notFoundValues, notFoundBaseTag(basePath));
  builtPages.push({ path: '404', outPath: '404.html', html: notFoundHtml, isErrorPage: false });

  // Every fillShell has run, so the errors are complete
  if (mode === 'dev' && diag.errors.length) {
    const pagesByDir = new Map(
      rendered.filter(({ page }) => !page.isGenerated).map(({ page }) => [page.dir, page])
    );
    // A section's sources are its page's, and a generated page's own source is that page's
    const pagesByFile = new Map<string, HubPage>();
    for (const section of sections) {
      const page = tree?.byPath.get(section.path);
      if (page) for (const file of section.files) pagesByFile.set(file, page);
    }
    for (const { page } of rendered) if (page.isGenerated) pagesByFile.set(page.file, page);
    const errorsByPage = new Map<HubPage | null, HubDiagnostic[]>();
    for (const error of diag.errors) {
      const owner = findOwnerPage(error.file, pagesByDir, pagesByFile);
      errorsByPage.set(owner, [...(errorsByPage.get(owner) ?? []), error]);
    }
    const siteErrors = errorsByPage.get(null) ?? [];
    const errorValues = (errors: HubDiagnostic[], values: ShellPageValues): ShellPageValues => ({
      ...values,
      title: escapeHtml(`Build error · ${hubConfig.title}`),
      bodyClass: 'hubPage_error',
      toc: '',
      body: renderErrorBody(errors),
    });
    rendered.forEach((item, i) => {
      const errors = [...(errorsByPage.get(item.page) ?? []), ...siteErrors];
      if (!errors.length) return;
      const html = fillPage(item.env.root, item.page, errorValues(errors, pageValues(item)));
      builtPages[i] = { ...builtPages[i], html, isErrorPage: true };
    });
    if (siteErrors.length || !tree) {
      // Without a page tree, the errors are the discovery's, which no page could list
      const errors = tree ? siteErrors : diag.errors;
      const html = fillPage(
        '',
        null,
        errorValues(errors, notFoundValues),
        notFoundBaseTag(basePath)
      );
      builtPages[builtPages.length - 1] = {
        ...builtPages[builtPages.length - 1],
        html,
        isErrorPage: true,
      };
    }
  }

  const sourceFiles = [
    ...new Set([
      ...(tree?.files ?? []),
      HUB_SHELL_FILE,
      HUB_NOT_FOUND_FILE,
      PACKAGE_JSON_FILE,
      ...sectionFiles,
      ...FAVICON_FILES,
      ...rendered.flatMap(({ env }) => env.images.map((job) => job.source)),
      // Snippet includes (p552): an edit to one rebuilds, and reloads the pages that show it
      ...rendered.flatMap(({ env }) => env.includes),
    ]),
  ];
  if (mode === 'public' && diag.errors.length) {
    builtPages.length = 0;
    return result(sourceFiles);
  }

  if (mode === 'public') fs.rmSync(outDir, { recursive: true, force: true });
  for (const { outPath, html } of builtPages) writeFile(path.join(outDir, outPath), html);
  for (const file of [assets.styles, data, search, ...(assets.scripts ?? [])]) {
    if (file) writeFile(path.join(outDir, file.outPath), file.content);
  }
  copyStaticAssets(outDir);
  await writeImages(
    rendered.flatMap(({ env }) => env.images),
    outDir,
    mode,
    diag
  );
  for (const file of FAVICON_FILES) fs.copyFileSync(file, path.join(outDir, path.basename(file)));
  if (mode === 'public') writeFile(path.join(outDir, '_headers'), NETLIFY_HEADERS);

  return result(sourceFiles);
};
