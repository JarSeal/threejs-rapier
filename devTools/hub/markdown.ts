import fs from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import type { HubDiagnostics } from './diagnostics';
import { hashContent } from './hash';
import { PAGE_IMAGES_URL_DIR } from './paths';
import type { HubHeading, HubPage } from './types';

/**
 * The Hub's Markdown: markdown-it with its plugins (p551 §2.2):
 * - heading anchors: slugged ids (unique per page, slot ids included), a `#` link, and the
 *   page's heading list (the TOC and `hub-data.js`);
 * - directives `::: name args` … `:::`, from a registry other plans add to
 *   (`registerHubDirective`); the callouts `tip`, `note`, `warning` and `danger` are the first.
 *   Nest one in another with a longer marker on the outer one (`::::`);
 * - `hub:` links (`[physics](hub:examples/physics#setup)`), resolved relative to the page and
 *   checked after every page is rendered (`HubMarkdownEnv.links`);
 * - relative images, copied (PNG and JPEG to WebP) to `_assets/images/pages/<page path>`.
 */

export type HubLinkRef = {
  /** The file and line the link is written in */
  file: string;
  line: number;
  /** The site path it points to ('' the homepage) and its `#hash` without the `#` */
  targetPath: string;
  hash: string;
  /** The link as written, for messages */
  raw: string;
};

export type HubImageJob = {
  source: string;
  /** From the site root */
  outPath: string;
  isConverted: boolean;
};

/** One page's render state, shared by its slots */
export type HubMarkdownEnv = {
  page: HubPage;
  /** The `.md` being rendered now */
  file: string;
  /** Added to its headings' levels (a generated section's `# Changelog` is the page's h2) */
  headingOffset: number;
  /** The relative path from the page to the site root (`../../`) */
  root: string;
  diag: HubDiagnostics;
  headings: HubHeading[];
  /** Every id on the page so far (slots and headings) */
  ids: Set<string>;
  links: HubLinkRef[];
  images: HubImageJob[];
};

export const createMarkdownEnv = (
  page: HubPage,
  root: string,
  diag: HubDiagnostics
): HubMarkdownEnv => ({
  page,
  file: page.file,
  headingOffset: 0,
  root,
  diag,
  headings: [],
  // A heading's slug never takes an id the page's own markup has
  ids: new Set([...page.body.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1])),
  links: [],
  images: [],
});

// --- Directives ---

export type HubDirectiveContext = {
  env: HubMarkdownEnv;
  /** The directive's 1-based line */
  line: number;
  md: MarkdownIt;
};

export type HubDirective = {
  /** The HTML before the directive's content; `args` is the text after its name */
  open: (args: string, ctx: HubDirectiveContext) => string;
  /** The HTML after it */
  close: (args: string, ctx: HubDirectiveContext) => string;
};

const directives = new Map<string, HubDirective>();

/** Adds a `::: name args` directive (p552's `code-group`, p554's `scene`, p555's `cards`) */
export const registerHubDirective = (name: string, directive: HubDirective) => {
  directives.set(name, directive);
};

const CALLOUT_TITLES: Record<string, string> = {
  tip: 'Tip',
  note: 'Note',
  warning: 'Warning',
  danger: 'Danger',
};

for (const [kind, defaultTitle] of Object.entries(CALLOUT_TITLES)) {
  registerHubDirective(kind, {
    open: (args, { md, env }) =>
      `<aside class="hubCallout hubCallout_${kind}">\n<p class="hubCalloutTitle">${md.renderInline(args || defaultTitle, env)}</p>\n`,
    close: () => '</aside>\n',
  });
}

const MARKER = 0x3a; // ':'
const MIN_MARKERS = 3;

/** `::: name args` … `:::`: the content is parsed as blocks; the closing marker is as long or longer */
const directiveRule = (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.src.charCodeAt(pos) !== MARKER) return false;
  const markerStart = pos;
  while (pos < max && state.src.charCodeAt(pos) === MARKER) pos++;
  const markerCount = pos - markerStart;
  if (markerCount < MIN_MARKERS) return false;
  const info = state.src.slice(pos, max).trim();
  const nameMatch = /^([\w-]+)\s*(.*)$/.exec(info);
  if (!nameMatch) return false; // A bare marker closes a directive; it opens none
  if (silent) return true;

  let nextLine = startLine;
  let isClosed = false;
  while (++nextLine < endLine) {
    const start = state.bMarks[nextLine] + state.tShift[nextLine];
    const end = state.eMarks[nextLine];
    if (state.sCount[nextLine] < state.blkIndent && start < end) break; // Its list item ended
    if (state.sCount[nextLine] - state.blkIndent >= 4) continue; // Indented code
    let p = start;
    while (p < end && state.src.charCodeAt(p) === MARKER) p++;
    if (p - start >= markerCount && state.src.slice(p, end).trim() === '') {
      isClosed = true;
      break;
    }
  }

  const [, name, args] = nameMatch;
  const env = state.env as HubMarkdownEnv;
  if (!isClosed) {
    env.diag.error(env.file, startLine + 1, `":::${name}" has no closing ":::"`);
  }
  if (!directives.has(name)) {
    env.diag.error(
      env.file,
      startLine + 1,
      `Unknown directive "${name}" (known: ${[...directives.keys()].join(', ')})`
    );
  }

  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  state.parentType = 'container' as typeof state.parentType;
  state.lineMax = nextLine;

  const open = state.push('hub_directive_open', 'div', 1);
  open.block = true;
  open.info = name;
  open.meta = { args };
  open.map = [startLine, nextLine];
  state.md.block.tokenize(state, startLine + 1, nextLine);
  const close = state.push('hub_directive_close', 'div', -1);
  close.block = true;
  close.info = name;
  close.meta = { args };

  state.parentType = oldParent;
  state.lineMax = oldLineMax;
  state.line = nextLine + (isClosed ? 1 : 0);
  return true;
};

// --- Headings ---

/** `Physics & joints` → `physics-joints` */
export const slugify = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

const uniqueId = (env: HubMarkdownEnv, base: string) => {
  let id = base;
  for (let n = 2; env.ids.has(id); n++) id = `${base}-${n}`;
  env.ids.add(id);
  return id;
};

const inlineText = (token: Token) =>
  (token.children ?? [])
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('');

const headingsRule = (state: StateCore) => {
  const env = state.env as HubMarkdownEnv;
  const { tokens } = state;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const level = Math.min(6, Number(token.tag.slice(1)) + env.headingOffset);
    token.tag = `h${level}`;
    tokens[i + 2].tag = token.tag; // Its heading_close
    const text = inlineText(inline).trim();
    const id = uniqueId(env, token.attrGet('id') || slugify(text));
    token.attrSet('id', id);
    env.headings.push({ level, id, text });
    const anchor = new state.Token('html_inline', '', 0);
    anchor.content = ` <a class="hubAnchor" href="#${id}" aria-label="Link to this section">#</a>`;
    inline.children?.push(anchor);
  }
};

// --- Links and images ---

const HUB_LINK_PREFIX = 'hub:';

/** `hub:examples/physics#setup` → its site path and hash */
export const parseHubLink = (href: string) => {
  const [target, hash = ''] = href.slice(HUB_LINK_PREFIX.length).split('#');
  const clean = target.replace(/^\/+|\/+$/g, '');
  return { targetPath: clean ? `${clean}/` : '', hash };
};

/** Resolves a `hub:` href and records it for the dead-link check */
export const resolveHubLink = (href: string, env: HubMarkdownEnv, file: string, line: number) => {
  const { targetPath, hash } = parseHubLink(href);
  env.links.push({ file, line, targetPath, hash, raw: href });
  return `${targetPath ? env.root + targetPath : env.root}${hash ? `#${hash}` : ''}`;
};

export const isHubLink = (href: string) => href.startsWith(HUB_LINK_PREFIX);

const isRelativeUrl = (url: string) => !!url && !/^([a-z][\w+.-]*:|\/|#)/i.test(url);

const CONVERTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

const resolveImage = (src: string, env: HubMarkdownEnv, line: number) => {
  const [file] = src.split(/[?#]/);
  const source = path.resolve(path.dirname(env.file), decodeURI(file));
  if (!fs.existsSync(source)) {
    env.diag.error(env.file, line, `Image not found: ${src}`);
    return src;
  }
  const relative = path.relative(env.page.dir, source).split(path.sep).join('/');
  if (relative.startsWith('../')) {
    env.diag.error(env.file, line, `Image outside its page's folder: ${src}`);
    return src;
  }
  const ext = path.extname(relative).toLowerCase();
  const isConverted = CONVERTED_IMAGE_EXTENSIONS.includes(ext);
  const outRelative = isConverted ? `${relative.slice(0, -ext.length)}.webp` : relative;
  const outPath = `${PAGE_IMAGES_URL_DIR}${env.page.path}${outRelative}`;
  if (!env.images.some((job) => job.outPath === outPath)) {
    env.images.push({ source, outPath, isConverted });
  }
  return `${env.root}${outPath}?v=${hashContent(fs.readFileSync(source))}`;
};

const linksRule = (state: StateCore) => {
  const env = state.env as HubMarkdownEnv;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const line = (block.map?.[0] ?? 0) + 1;
    for (const token of block.children) {
      if (token.type === 'link_open') {
        const href = token.attrGet('href') ?? '';
        if (isHubLink(href)) token.attrSet('href', resolveHubLink(href, env, env.file, line));
      } else if (token.type === 'image') {
        const src = token.attrGet('src') ?? '';
        if (!isRelativeUrl(src)) continue;
        token.attrSet('src', resolveImage(src, env, line));
        token.attrSet('loading', 'lazy');
        token.attrSet('decoding', 'async');
      }
    }
  }
};

// --- The instance ---

export const createHubMarkdown = () => {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  // markdown-it drops `hub:` hrefs as unknown schemes; they're resolved by linksRule
  const defaultValidateLink = md.validateLink.bind(md);
  md.validateLink = (url) => isHubLink(url) || defaultValidateLink(url);

  md.block.ruler.before('fence', 'hub_directive', directiveRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.core.ruler.push('hub_headings', headingsRule);
  md.core.ruler.push('hub_links', linksRule);

  const directiveContext = (tokens: Token[], idx: number, env: HubMarkdownEnv) => ({
    env,
    line: (tokens[idx].map?.[0] ?? 0) + 1,
    md,
  });
  md.renderer.rules['hub_directive_open'] = (tokens, idx, _opts, env: HubMarkdownEnv) => {
    const token = tokens[idx];
    return (
      directives.get(token.info)?.open(token.meta.args, directiveContext(tokens, idx, env)) ??
      '<div>\n'
    );
  };
  md.renderer.rules['hub_directive_close'] = (tokens, idx, _opts, env: HubMarkdownEnv) => {
    const token = tokens[idx];
    return (
      directives.get(token.info)?.close(token.meta.args, directiveContext(tokens, idx, env)) ??
      '</div>\n'
    );
  };
  // Tables scroll on their own instead of the page
  md.renderer.rules['table_open'] = () => '<div class="hubTable">\n<table>\n';
  md.renderer.rules['table_close'] = () => '</table>\n</div>\n';

  return md;
};

/**
 * Renders Markdown into the page's env: `file` is where it's from (its diagnostics, relative
 * images), and `headingOffset` shifts its headings for this text only
 */
export const renderMarkdownText = (
  md: MarkdownIt,
  text: string,
  file: string,
  env: HubMarkdownEnv,
  headingOffset = 0
) => {
  env.file = file;
  env.headingOffset = headingOffset;
  try {
    return md.render(text, env);
  } finally {
    env.headingOffset = 0;
  }
};

/** Renders one slot's Markdown into the page's env */
export const renderMarkdown = (md: MarkdownIt, file: string, env: HubMarkdownEnv) =>
  renderMarkdownText(md, fs.readFileSync(file, 'utf-8'), file, env);
