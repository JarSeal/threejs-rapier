import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import hubConfig from '../../hub/hub.config';
import { getProjectMetadata } from '../projectMetadata';
import { buildScripts, buildStyles, copyStaticAssets, type HubAssetFile } from './assets';
import { buildHubData, getPageSection } from './data';
import { HubDiagnostics, lineAt } from './diagnostics';
import { escapeHtml } from './html';
import {
  createHubMarkdown,
  createMarkdownEnv,
  renderMarkdown,
  resolveHubLink,
  type HubImageJob,
  type HubMarkdownEnv,
} from './markdown';
import { discoverPages, relativeRoot, type HubPageTree } from './pages';
import { FAVICON_FILES, HUB_NOT_FOUND_FILE, HUB_SHELL_FILE } from './paths';
import { fillShell, renderBreadcrumbs, renderNav, renderToc, type ShellSiteValues } from './shell';
import type { HubBuildMode, HubHeading, HubPage } from './types';

/**
 * Builds the Hub (p551 §2.2): `hub/` → static pages in `outDir`, in the layout p550 §3.5
 * describes. `public` (`yarn hub:build` → `dist-hub/`) writes nothing when there's an error;
 * `dev` (the dev plugin, Phase 2) writes what it could.
 */

export type HubBuildOptions = {
  mode: HubBuildMode;
  outDir: string;
  /** The site root's absolute URL path, for the 404 page's `<base>` (default `/`) */
  basePath?: string;
};

export type HubBuildResult = {
  isOk: boolean;
  diag: HubDiagnostics;
  pageCount: number;
  durationMs: number;
  /** Every source file the build read, for the dev plugin's watcher */
  files: string[];
};

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

/** `href="hub:…"` and `src="hub:…"` in a page's own markup */
const HTML_HUB_LINK_REGEX = /\b(href|src)=(["'])(hub:[^"']*)\2/g;

/** The page's markup with its `hub:` links resolved and `{{root}}` filled */
const resolvePageMarkup = (markup: string, offset: number, env: HubMarkdownEnv) =>
  markup
    .replace(
      HTML_HUB_LINK_REGEX,
      (_match, attr: string, quote: string, href: string, at: number) => {
        const line = env.page.bodyLine + lineAt(env.page.body, offset + at) - 1;
        return `${attr}=${quote}${resolveHubLink(href, env, env.page.file, line)}${quote}`;
      }
    )
    .replace(/\{\{\s*root\s*\}\}/g, env.root);

/** The page's body with its slots filled by their Markdown */
const renderPageBody = (
  page: HubPage,
  env: HubMarkdownEnv,
  md: ReturnType<typeof createHubMarkdown>
) => {
  let body = '';
  let cursor = 0;
  for (const slot of page.slots) {
    body += resolvePageMarkup(page.body.slice(cursor, slot.offset), cursor, env);
    const content = slot.mdFile ? renderMarkdown(md, slot.mdFile, env) : '';
    body += `${slot.openTag}\n${content}${slot.closeTag}`;
    cursor = slot.offset + slot.length;
  }
  return body + resolvePageMarkup(page.body.slice(cursor), cursor, env);
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

const writeImages = async (jobs: HubImageJob[], outDir: string, diag: HubDiagnostics) => {
  await Promise.all(
    jobs.map(async ({ source, outPath, isConverted }) => {
      const out = path.join(outDir, outPath);
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

export const buildHub = async ({
  mode,
  outDir,
  basePath = '/',
}: HubBuildOptions): Promise<HubBuildResult> => {
  const startTime = performance.now();
  const diag = new HubDiagnostics();
  const rendered: RenderedPage[] = [];
  const result = (files: string[]): HubBuildResult => ({
    isOk: diag.errors.length === 0,
    diag,
    pageCount: rendered.length,
    durationMs: performance.now() - startTime,
    files,
  });

  const tree = discoverPages(diag);
  const shell = fs.readFileSync(HUB_SHELL_FILE, 'utf-8');
  const notFoundBody = fs.readFileSync(HUB_NOT_FOUND_FILE, 'utf-8');
  const [styles, scripts] = [buildStyles(mode, diag), await buildScripts(mode, diag)];
  if (!tree) return result([]);

  const md = createHubMarkdown();
  for (const page of tree.pages) {
    const env = createMarkdownEnv(page, relativeRoot(page.path), diag);
    rendered.push({ page, env, body: renderPageBody(page, env, md) });
  }
  checkLinks(rendered, tree, diag);

  const meta = getProjectMetadata();
  const headings = new Map<HubPage, HubHeading[]>(
    rendered.map(({ page, env }) => [page, env.headings])
  );
  const data = buildHubData(meta, tree.root, tree.pages, headings);
  const assetUrl = (root: string, file: HubAssetFile | null | undefined) =>
    file ? `${root}${file.outPath}?v=${file.hash}` : '';
  const hubJs = scripts?.find((file) => file.outPath === '_assets/hub.js');

  const siteValues = (root: string, page: HubPage | null): ShellSiteValues => ({
    root,
    siteTitle: escapeHtml(hubConfig.title),
    head: '',
    nav: renderNav(tree.root, page, root),
    css: assetUrl(root, styles),
    js: assetUrl(root, hubJs),
    dataJs: assetUrl(root, data),
    engineVersion: meta.engine.version,
    githubUrl: escapeHtml(hubConfig.githubUrl),
  });

  const pageHtml = rendered.map(({ page, env, body }) => {
    const isHome = page === tree.root;
    const section = getPageSection(page);
    const html = fillShell(
      shell,
      HUB_SHELL_FILE,
      {
        ...siteValues(env.root, page),
        title: escapeHtml(isHome ? hubConfig.title : `${page.title} · ${hubConfig.title}`),
        pageTitle: escapeHtml(page.title),
        description: escapeHtml(page.description || (isHome ? hubConfig.description : '')),
        pagePath: page.path,
        section,
        bodyClass: `hubPage_${section.replace(/\/$/, '') || 'home'}`,
        breadcrumbs: renderBreadcrumbs(page, env.root),
        toc: renderToc(env.headings),
        body,
      },
      diag
    );
    return { outPath: `${page.path}index.html`, html };
  });

  const notFoundHtml = fillShell(
    shell,
    HUB_SHELL_FILE,
    {
      ...siteValues('', null),
      head: notFoundBaseTag(basePath),
      title: escapeHtml(`Page not found · ${hubConfig.title}`),
      pageTitle: 'Page not found',
      description: '',
      pagePath: '404',
      section: '404',
      bodyClass: 'hubPage_404',
      breadcrumbs: '',
      toc: '',
      body: notFoundBody,
    },
    diag
  );

  const sourceFiles = [
    ...tree.files,
    HUB_SHELL_FILE,
    HUB_NOT_FOUND_FILE,
    ...rendered.flatMap(({ env }) => env.images.map((job) => job.source)),
  ];
  if (mode === 'public' && diag.errors.length) return result(sourceFiles);

  if (mode === 'public') fs.rmSync(outDir, { recursive: true, force: true });
  for (const { outPath, html } of pageHtml) writeFile(path.join(outDir, outPath), html);
  writeFile(path.join(outDir, '404.html'), notFoundHtml);
  for (const file of [styles, data, ...(scripts ?? [])]) {
    if (file) writeFile(path.join(outDir, file.outPath), file.content);
  }
  copyStaticAssets(outDir);
  await writeImages(
    rendered.flatMap(({ env }) => env.images),
    outDir,
    diag
  );
  for (const file of FAVICON_FILES) fs.copyFileSync(file, path.join(outDir, path.basename(file)));
  if (mode === 'public') writeFile(path.join(outDir, '_headers'), NETLIFY_HEADERS);

  return result(sourceFiles);
};
