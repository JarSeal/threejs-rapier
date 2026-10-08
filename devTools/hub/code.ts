import {
  transformerMetaHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerRemoveLineBreak,
  transformerRemoveNotationEscape,
} from '@shikijs/transformers';
import type MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import { createHighlighter, type Highlighter, type ShikiTransformer } from 'shiki';
import { HUB_CODE_THEME_DARK, HUB_CODE_THEME_LIGHT } from './codeThemes';
import { escapeHtml } from './html';
import type { HubIcons } from './icons';
import { registerHubDirective, uniqueId, type HubMarkdownEnv } from './markdown';
import { parseSnippetSpec, readSnippet } from './snippets';

/**
 * The Hub's code blocks (p552 §2.1, §2.2): fences highlighted by shiki at build time, so a page
 * carries highlighted HTML and no highlighter. Both themes go into the HTML as CSS variables
 * (`_code.scss` picks one). The fence's meta (` ```ts title="space.ts" {3,5-7} wrap `) and
 * shiki's notation comments (`// [!code ++]`) add the rest, and `hub.ts` adds copy, collapse
 * and the code group tabs. Inline code with a language (`` `fn()`{ts} ``) is highlighted too,
 * and `<<< path#region` includes a file's region as a code block (§2.3, `snippets.ts`).
 */

/** The languages a page can use; `sh`, `shell`, `yml`, … are shiki's aliases of these */
const LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'json',
  'jsonc',
  'bash',
  'scss',
  'css',
  'html',
  'wgsl',
  'glsl',
  'diff',
  'yaml',
  'markdown',
];

/** Rendered plain without a warning, as a fence without a language */
const PLAIN_LANGUAGES = ['text', 'txt', 'plain', 'plaintext'];

/** Line numbers by default from this many lines */
const LINE_NUMBERS_FROM = 4;
/** `collapse` on its own from this many lines, and the lines a collapsed block shows */
const AUTO_COLLAPSE_FROM = 31;
const COLLAPSED_LINES = 15;

const FENCE_FLAGS = ['showLineNumbers', 'noLineNumbers', 'wrap', 'collapse'] as const;
type FenceFlag = (typeof FENCE_FLAGS)[number];

let highlighterPromise: Promise<Highlighter> | null = null;

/** The highlighter, loaded once per process: the dev server's rebuilds share it */
export const loadHubHighlighter = () =>
  (highlighterPromise ??= createHighlighter({
    themes: [HUB_CODE_THEME_DARK, HUB_CODE_THEME_LIGHT],
    langs: LANGUAGES,
  }));

const THEMES = { dark: HUB_CODE_THEME_DARK.name!, light: HUB_CODE_THEME_LIGHT.name! };

export type HubFenceOptions = {
  title: string;
  /** The raw meta, for shiki's `{3,5-7}` (`transformerMetaHighlight`) */
  meta: string;
  startLine: number;
  flags: Set<FenceFlag>;
};

/** `title="space.ts" {3,5-7} startLine=40 wrap`; anything else warns */
export const parseFenceMeta = (meta: string, warn: (message: string) => void): HubFenceOptions => {
  const options: HubFenceOptions = { title: '', meta, startLine: 1, flags: new Set() };
  const regex = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))|\{([^}]*)\}|(\S+)/g;
  for (const match of meta.matchAll(regex)) {
    const [raw, key, dq, sq, bare, range, word] = match;
    if (key) {
      const value = dq ?? sq ?? bare ?? '';
      if (key === 'title') options.title = value;
      else if (key === 'startLine' && /^\d+$/.test(value) && +value >= 1) {
        options.startLine = +value;
      } else warn(`Unknown or invalid "${raw}" in the code block's meta`);
    } else if (range !== undefined) {
      if (!/^[\d\s,-]+$/.test(range)) warn(`"${raw}": line highlights are like {3,5-7}`);
    } else if ((FENCE_FLAGS as readonly string[]).includes(word)) {
      options.flags.add(word as FenceFlag);
    } else {
      warn(
        `Unknown "${word}" in the code block's meta (known: title="…", {3,5-7}, startLine=N, ${FENCE_FLAGS.join(', ')})`
      );
    }
  }
  return options;
};

/** A fence inside `::: code-group`: its tab panel's ids, set by the directive */
type GroupPanel = { panelId: string; tabId: string; isActive: boolean };

type HubCodeOptions = { highlighter: Highlighter; icons: HubIcons };

const lineOf = (token: Token) => (token.map?.[0] ?? 0) + 1;

/** The language to highlight with ('text' renders plain), warning about an unknown one */
const resolveLanguage = (
  highlighter: Highlighter,
  lang: string,
  env: HubMarkdownEnv,
  line: number
) => {
  if (!lang || PLAIN_LANGUAGES.includes(lang)) return 'text';
  if (highlighter.getLoadedLanguages().includes(lang)) return lang;
  env.diag.warn(
    env.file,
    line,
    `Unknown code language "${lang}": rendered plain (known: ${LANGUAGES.join(', ')} and their aliases)`
  );
  return 'text';
};

const renderCopyButton = (icons: HubIcons, env: HubMarkdownEnv, line: number) =>
  `<button type="button" class="hubCodeCopy" data-hub-code-copy aria-label="Copy the code">${icons.render('copy', env.file, line)}${icons.render('check', env.file, line)}<span class="hubCodeCopyLabel" aria-live="polite">Copy</span></button>`;

const renderFence = ({ highlighter, icons }: HubCodeOptions, token: Token, env: HubMarkdownEnv) => {
  const line = lineOf(token);
  const [rawLang = '', ...rest] = token.info.trim().split(/\s+/);
  const langLabel = rawLang.toLowerCase();
  const lang = resolveLanguage(highlighter, langLabel, env, line);
  const options = parseFenceMeta(rest.join(' '), (message) =>
    env.diag.warn(env.file, line, message)
  );
  const group = token.meta?.group as GroupPanel | undefined;

  let lineCount = 0;
  let isCollapsed = false;
  // Runs after the notation transformers, which remove their comment-only lines
  const hubTransformer: ShikiTransformer = {
    name: 'aek-hub',
    code(node) {
      type Child = (typeof node.children)[number];
      const lines = node.children.filter(
        (child): child is Extract<Child, { type: 'element' }> => child.type === 'element'
      );
      lineCount = lines.length;
      isCollapsed =
        lineCount > COLLAPSED_LINES &&
        (options.flags.has('collapse') || lineCount >= AUTO_COLLAPSE_FROM);
      if (isCollapsed) {
        lines.slice(COLLAPSED_LINES).forEach((el) => this.addClassToHast(el, 'hubCodeFold'));
      }
    },
  };

  const pre = highlighter.codeToHtml(token.content.replace(/\n$/, ''), {
    lang,
    themes: THEMES,
    defaultColor: false,
    meta: { __raw: options.meta },
    transformers: [
      transformerNotationDiff(),
      transformerNotationHighlight(),
      transformerNotationFocus(),
      transformerNotationErrorLevel(),
      transformerMetaHighlight(),
      transformerRemoveNotationEscape(),
      transformerRemoveLineBreak(),
      hubTransformer,
    ],
  });

  const hasLineNumbers = options.flags.has('noLineNumbers')
    ? false
    : options.flags.has('showLineNumbers') || lineCount >= LINE_NUMBERS_FROM;
  const lastLine = options.startLine + lineCount - 1;
  const classes = [
    'hubCode',
    hasLineNumbers && 'hubCode_lines',
    options.flags.has('wrap') && 'hubCode_wrap',
    isCollapsed && 'hubCode_collapsed',
    group && !group.isActive && 'hubCode_inactive',
  ].filter(Boolean);
  const style = hasLineNumbers
    ? ` style="--hub-code-start: ${options.startLine - 1}; --hub-code-digits: ${String(lastLine).length}"`
    : '';
  const panel = group
    ? ` role="tabpanel" id="${group.panelId}" aria-labelledby="${group.tabId}"`
    : '';
  const title = options.title
    ? `<span class="hubCodeTitle">${escapeHtml(options.title)}</span>`
    : '';
  const badge =
    langLabel && lang !== 'text' ? `<span class="hubCodeLang">${escapeHtml(langLabel)}</span>` : '';
  const expand = isCollapsed
    ? `<button type="button" class="hubCodeExpand" data-hub-code-expand aria-expanded="false" data-label-more="Show all ${lineCount} lines" data-label-less="Show fewer lines">Show all ${lineCount} lines</button>\n`
    : '';
  return `<div class="${classes.join(' ')}"${style}${panel}>
<div class="hubCodeHeader">${title}${badge}${renderCopyButton(icons, env, line)}</div>
${pre}
${expand}</div>
`;
};

// --- Code groups ---

/**
 * `::: code-group` around fences: a tab per fence, labelled by its title (else its language).
 * The tabs are rendered here; without JS they're hidden and every block shows with its title.
 */
registerHubDirective('code-group', {
  open: (_args, { env, line, tokens, idx }) => {
    const fences: Token[] = [];
    // The group's direct children are at depth 0; the first closing token there is its own
    for (let i = idx + 1, depth = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (depth === 0) {
        if (token.nesting === -1) break;
        if (token.type === 'fence') fences.push(token);
        else env.diag.warn(env.file, lineOf(token), '::: code-group holds only code blocks');
      }
      depth += token.nesting;
    }
    if (fences.length < 2) {
      env.diag.warn(env.file, line, '::: code-group needs two or more code blocks');
    }
    const groupId = uniqueId(env, 'code-group');
    const tabs = fences.map((fence, i) => {
      const panelId = uniqueId(env, `${groupId}-${i + 1}`);
      const tabId = uniqueId(env, `${panelId}-tab`);
      fence.meta = { ...fence.meta, group: { panelId, tabId, isActive: i === 0 } };
      const [lang = '', ...rest] = fence.info.trim().split(/\s+/);
      const title = /\btitle=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest.join(' '));
      const label = title?.[1] ?? title?.[2] ?? title?.[3] ?? (lang || `Code ${i + 1}`);
      return `<button type="button" role="tab" class="hubCodeTab" id="${tabId}" aria-controls="${panelId}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${escapeHtml(label)}</button>`;
    });
    return `<div class="hubCodeGroup">\n<div class="hubCodeTabs" role="tablist" aria-label="Code">${tabs.join('')}</div>\n`;
  },
  close: () => '</div>\n',
});

// --- Inline code ---

const INLINE_LANG_REGEX = /^\{([\w+#-]+)\}/;

/** `` `createMeshEntity(props)`{ts} ``: the `{ts}` after inline code is its language */
const inlineLanguageRule = (state: StateCore) => {
  for (const block of state.tokens) {
    const children = block.children;
    if (block.type !== 'inline' || !children) continue;
    for (let i = 0; i < children.length - 1; i++) {
      const code = children[i];
      const next = children[i + 1];
      if (code.type !== 'code_inline' || next.type !== 'text') continue;
      const match = INLINE_LANG_REGEX.exec(next.content);
      if (!match) continue;
      code.meta = { ...code.meta, lang: match[1].toLowerCase(), line: lineOf(block) };
      next.content = next.content.slice(match[0].length);
    }
  }
};

// --- Snippet includes ---

/**
 * `<<< path/from/repo/root.ts#region {meta}` on a line of its own: a fence token with the file's
 * region (`snippets.ts`), so it's an ordinary code block (in a `::: code-group` too). Its title
 * defaults to the path, and a line range is numbered as in the file. A failed include is an error
 * at the page's line; the file is still recorded, so creating or fixing it rebuilds the page.
 */
const snippetRule = (state: StateBlock, startLine: number, _endLine: number, silent: boolean) => {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false; // Indented code
  if (!state.src.startsWith('<<<', pos) || state.src.charAt(pos + 3) === '<') return false;
  if (silent) return true;

  const env = state.env as HubMarkdownEnv;
  const spec = parseSnippetSpec(state.src.slice(pos + 3, max));
  const result = readSnippet(spec);
  if (result.file && !env.includes.includes(result.file)) env.includes.push(result.file);
  state.line = startLine + 1;
  if (!result.isOk) {
    env.diag.error(env.file, startLine + 1, result.message);
    return true;
  }

  const meta = [
    /\btitle=/.test(spec.meta) ? '' : `title="${spec.path}"`,
    result.startLine !== null && !/\bstartLine=/.test(spec.meta)
      ? `startLine=${result.startLine}`
      : '',
    spec.meta,
  ];
  const token = state.push('fence', 'code', 0);
  token.info = [result.lang, ...meta].filter(Boolean).join(' ');
  token.content = `${result.code}\n`;
  token.markup = '<<<';
  token.map = [startLine, startLine + 1];
  return true;
};

/** Adds the code blocks to the Hub's markdown-it (`md.use(hubCodePlugin, { highlighter, icons })`) */
export const hubCodePlugin = (md: MarkdownIt, options: HubCodeOptions) => {
  md.block.ruler.before('fence', 'hub_snippet', snippetRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.core.ruler.after('inline', 'hub_inline_code_lang', inlineLanguageRule);

  md.renderer.rules['fence'] = (tokens, idx, _opts, env: HubMarkdownEnv) =>
    renderFence(options, tokens[idx], env);

  const defaultCodeInline = md.renderer.rules['code_inline']!;
  md.renderer.rules['code_inline'] = (tokens, idx, opts, env: HubMarkdownEnv, self) => {
    const token = tokens[idx];
    const lang = token.meta?.lang as string | undefined;
    if (!lang) return defaultCodeInline(tokens, idx, opts, env, self);
    const resolved = resolveLanguage(options.highlighter, lang, env, token.meta.line);
    if (resolved === 'text') return defaultCodeInline(tokens, idx, opts, env, self);
    const html = options.highlighter.codeToHtml(token.content, {
      lang: resolved,
      themes: THEMES,
      defaultColor: false,
      structure: 'inline',
    });
    return `<code class="hubCodeInline">${html}</code>`;
  };
};
