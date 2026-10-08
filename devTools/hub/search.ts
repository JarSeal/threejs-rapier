import MiniSearch from 'minisearch';
import type { HubAssetFile } from './assets';
import { ASSETS_URL_DIR } from './assets';
import { hashContent } from './hash';
import { decodeEntities, parseAttributes } from './html';
import { HUB_SEARCH_FILE, HUB_SEARCH_OPTIONS, type HubSearchDoc } from './searchProtocol';
import type { HubPage } from './types';

/**
 * The search index (p552 §2.4): `_assets/hub-search.js`, loaded by the search dialog on first
 * use. One document per section of every page but the homepage (whose sections are its layout),
 * read from the page's rendered body, so the page's own markup, its Markdown and the generated
 * sections are all in it. Code blocks give their identifiers only. The index is serialized here
 * (`MiniSearch.toJSON`), so the browser only loads it.
 */

/** An HTML tag (its attributes may hold `>` inside quotes) or a comment */
const TAG_REGEX =
  /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Their edges separate words: `<li>a</li><li>b</li>` is "a b" */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

const HEADING_TAG_REGEX = /^h[1-6]$/;

/** Never text: controls, icons, and the code blocks' headers (title, language, copy) */
const SKIPPED_TAGS = new Set(['button', 'script', 'style', 'svg', 'template']);
const SKIPPED_CLASSES = ['hubAnchor', 'hubCodeHeader', 'hubCodeTabs'];

const isSkipped = (tag: string, attrs: Record<string, string>) =>
  SKIPPED_TAGS.has(tag) ||
  attrs['aria-hidden'] === 'true' ||
  // The page's `<h1>` is its title, which the page's own section has
  (tag === 'h1' && !attrs.id) ||
  (attrs.class ?? '').split(/\s+/).some((name) => SKIPPED_CLASSES.includes(name));

/** Code identifiers worth finding: no keywords, nothing shorter than three characters */
const IDENTIFIER_REGEX = /[A-Za-z_$][\w$]{2,}/g;
const CODE_STOP_WORDS = new Set([
  'any',
  'as',
  'async',
  'await',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'else',
  'export',
  'extends',
  'false',
  'for',
  'from',
  'function',
  'import',
  'interface',
  'let',
  'new',
  'null',
  'number',
  'return',
  'string',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unknown',
  'var',
  'void',
  'while',
]);

type Section = { anchor: string; heading: string[]; text: string[]; code: string[] };

const newSection = (anchor: string): Section => ({ anchor, heading: [], text: [], code: [] });

const collapse = (parts: string[]) => parts.join('').replace(/\s+/g, ' ').trim();

const identifiers = (code: string[]) => {
  const names = new Set<string>();
  for (const [name] of code.join('').matchAll(IDENTIFIER_REGEX)) {
    if (!CODE_STOP_WORDS.has(name)) names.add(name);
  }
  return [...names].join(' ');
};

type OpenElement = { tag: string; isSkipped: boolean; isHeading: boolean; isPre: boolean };

/** A page's rendered body → its sections: each heading with an id starts one */
export const splitSections = (body: string) => {
  const sections = [newSection('')];
  const stack: OpenElement[] = [];
  let skipped = 0;
  let headings = 0;
  let pres = 0;
  const current = () => sections[sections.length - 1];
  const emit = (raw: string) => {
    if (skipped || !raw) return;
    const text = decodeEntities(raw);
    const section = current();
    if (headings) section.heading.push(text);
    else if (pres) section.code.push(text);
    else section.text.push(text);
  };
  const space = () => emit(' ');
  const close = (element: OpenElement) => {
    if (element.isSkipped) skipped--;
    if (element.isHeading) headings--;
    if (element.isPre) pres--;
    if (BLOCK_TAGS.has(element.tag)) space();
  };

  let cursor = 0;
  for (const match of body.matchAll(TAG_REGEX)) {
    emit(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const [, slash, rawTag, rawAttrs, selfClosing] = match;
    if (!rawTag) continue; // A comment
    const tag = rawTag.toLowerCase();
    if (slash) {
      // Closes what it left open too
      let at = stack.length - 1;
      while (at >= 0 && stack[at].tag !== tag) at--;
      if (at >= 0) stack.splice(at).reverse().forEach(close);
      continue;
    }
    if (VOID_TAGS.has(tag) || selfClosing) {
      if (BLOCK_TAGS.has(tag)) space();
      continue;
    }
    const attrs = parseAttributes(rawAttrs);
    const element: OpenElement = {
      tag,
      isSkipped: isSkipped(tag, attrs),
      isHeading: false,
      isPre: tag === 'pre',
    };
    if (BLOCK_TAGS.has(tag)) space();
    if (element.isSkipped) skipped++;
    else if (HEADING_TAG_REGEX.test(tag) && attrs.id && !skipped && !pres) {
      element.isHeading = true;
      sections.push(newSection(attrs.id));
      headings++;
    }
    if (element.isPre) pres++;
    // A code line: shiki leaves no line breaks between them (`transformerRemoveLineBreak`)
    if (pres && (attrs.class ?? '').split(/\s+/).includes('line')) emit('\n');
    stack.push(element);
  }
  emit(body.slice(cursor));

  return sections.map((section) => ({
    anchor: section.anchor,
    heading: collapse(section.heading),
    text: collapse(section.text),
    code: identifiers(section.code),
  }));
};

export type HubSearchIndexFile = HubAssetFile & { docCount: number };

/** Builds `_assets/hub-search.js` from the pages' rendered bodies */
export const buildSearchIndex = (pages: { page: HubPage; body: string }[]): HubSearchIndexFile => {
  const docs: HubSearchDoc[] = [];
  for (const { page, body } of pages) {
    if (!page.path) continue; // The homepage
    splitSections(body).forEach((section, i) => {
      const isPageSection = i === 0;
      // The description summarises the page: its own section's snippet starts with it
      const description = collapse([page.description]);
      const text =
        isPageSection && description && !section.text.includes(description)
          ? `${description} ${section.text}`.trim()
          : section.text;
      docs.push({
        id: docs.length,
        path: page.path,
        anchor: section.anchor,
        title: isPageSection ? page.title : '',
        tags: isPageSection ? page.tags.join(' ') : '',
        heading: section.heading,
        text,
        code: section.code,
      });
    });
  }
  const index = new MiniSearch(HUB_SEARCH_OPTIONS);
  index.addAll(docs);
  // A string literal for JSON.parse: parsed faster than the same object as a JS literal
  const content = `export default JSON.parse(${JSON.stringify(JSON.stringify(index))});\n`;
  return {
    outPath: `${ASSETS_URL_DIR}${HUB_SEARCH_FILE}`,
    content,
    hash: hashContent(content),
    docCount: docs.length,
  };
};
