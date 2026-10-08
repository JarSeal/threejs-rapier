import type { ThemeRegistration } from 'shiki';

/**
 * The Hub's two syntax themes (p552 §2.1), built from its tokens (`hub/_assets/scss/_tokens.scss`):
 * the cyan accent for keywords, and a few restrained hues for the rest. Rendered together as CSS
 * variables (`--shiki-dark`, `--shiki-light`) and switched by the Hub's theme (`_code.scss`). The
 * background is the stylesheet's `--hub-code-bg`, not the theme's.
 *
 * Every colour passes WCAG AA (4.5) on its theme's `--hub-code-bg` and on the highlighted line's
 * tint over it; check again when a colour or `--hub-code-bg` changes.
 */

type Palette = {
  bg: string;
  fg: string;
  muted: string;
  comment: string;
  keyword: string;
  fn: string;
  string: string;
  number: string;
  type: string;
  inserted: string;
  deleted: string;
};

const DARK: Palette = {
  bg: '#0a101d',
  fg: '#dbe2ec',
  muted: '#9aa6b8',
  comment: '#8290a6',
  keyword: '#3fd8f2',
  fn: '#9cc2ff',
  string: '#a6dfa0',
  number: '#f2c27a',
  type: '#c9b0ff',
  inserted: '#5fd89a',
  deleted: '#ff8a7d',
};

const LIGHT: Palette = {
  bg: '#edf1f6',
  fg: '#172133',
  muted: '#4b5668',
  comment: '#56627a',
  keyword: '#06657c',
  fn: '#2a5bb0',
  string: '#2c6e31',
  number: '#8a5100',
  type: '#6a3fbf',
  inserted: '#156339',
  deleted: '#b3311c',
};

const createTheme = (name: string, type: 'dark' | 'light', p: Palette): ThemeRegistration => ({
  name,
  type,
  colors: { 'editor.background': p.bg, 'editor.foreground': p.fg },
  fg: p.fg,
  bg: p.bg,
  tokenColors: [
    { settings: { foreground: p.fg } },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: p.comment, fontStyle: 'italic' },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'variable.language',
        'keyword.control',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.logical.python',
        'entity.name.tag',
        'markup.heading',
        'meta.diff.range',
        'meta.diff.header',
      ],
      settings: { foreground: p.keyword },
    },
    {
      scope: [
        'keyword.operator',
        'punctuation',
        'meta.brace',
        'punctuation.definition.tag',
        'punctuation.separator',
        'punctuation.terminator',
      ],
      settings: { foreground: p.muted },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call entity.name.function',
        'entity.other.attribute-name',
        'support.type.property-name',
        'entity.name.tag.yaml',
      ],
      settings: { foreground: p.fn },
    },
    {
      scope: [
        'string',
        'string.template',
        'punctuation.definition.string',
        'markup.inline.raw',
        'string.regexp',
      ],
      settings: { foreground: p.string },
    },
    {
      scope: [
        'constant.numeric',
        'constant.language',
        'constant.character',
        'variable.other.enummember',
        'keyword.other.unit',
        'support.constant',
      ],
      settings: { foreground: p.number },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
        'entity.other.attribute-name.class.css',
        'entity.other.attribute-name.id.css',
        'entity.name.tag.css',
        'variable.other.normal.shell',
        'variable.other.positional.shell',
      ],
      settings: { foreground: p.type },
    },
    {
      // Back to the text colour inside punctuation-coloured template expressions
      scope: ['meta.template.expression', 'variable.parameter', 'variable.other.readwrite'],
      settings: { foreground: p.fg },
    },
    {
      scope: ['markup.inserted', 'punctuation.definition.inserted'],
      settings: { foreground: p.inserted },
    },
    {
      scope: ['markup.deleted', 'punctuation.definition.deleted'],
      settings: { foreground: p.deleted },
    },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
  ],
});

export const HUB_CODE_THEME_DARK = createTheme('aekasha-dark', 'dark', DARK);
export const HUB_CODE_THEME_LIGHT = createTheme('aekasha-light', 'light', LIGHT);

/** For the contrast check (`_code.scss`'s line tints are drawn over `bg`) */
export const HUB_CODE_PALETTES = { dark: DARK, light: LIGHT };
