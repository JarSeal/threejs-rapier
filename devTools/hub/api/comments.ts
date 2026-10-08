import type { JSONOutput } from 'typedoc';
import type { Comment } from './model';

/**
 * JSDoc comments as the Hub's Markdown (p553 §2.2). TypeDoc's comment model is display parts:
 * text, code (with its backticks) and inline tags. A `{@link}` is a Markdown link when the
 * caller resolves it (§2.3), else its text as code.
 */

export type CommentParts = JSONOutput.CommentDisplayPart[] | undefined;

export type InlineTagPart = JSONOutput.InlineTagDisplayPart;

/** A `{@link}`'s href, or undefined to print it unlinked */
export type CommentLinkResolver = (part: InlineTagPart) => string | undefined;

/** Inline code for any text: a run of backticks longer than the text's longest */
export const toInlineCode = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
};

const LINK_TAGS = ['@link', '@linkcode', '@linkplain'];

/**
 * What a `{@link}` shows: `{@link X | the text}`'s own text as Markdown, else the name as code
 * (`@linkplain` as text). TypeDoc keeps the whole `X | the text` in `text` when it didn't
 * resolve the link, and also for some links TypeScript resolved (`tsLinkText` has the text then).
 */
const linkLabel = (part: InlineTagPart) => {
  const bar = part.text.indexOf('|');
  if (bar >= 0)
    return part.text.slice(bar + 1).trim() || toInlineCode(part.text.slice(0, bar).trim());
  const name = (part.tsLinkText || part.text).trim();
  return part.tag === '@linkplain' ? name : toInlineCode(name);
};

/** The name a `{@link}` refers to: `X` of `{@link X | text}` */
export const linkName = (part: InlineTagPart) => part.text.split('|')[0].trim();

export const partsToMarkdown = (parts: CommentParts, resolveLink?: CommentLinkResolver) =>
  (parts ?? [])
    .map((part) => {
      if (part.kind === 'inline-tag' && LINK_TAGS.includes(part.tag)) {
        const label = linkLabel(part);
        const href = resolveLink?.(part);
        return href ? `[${label}](<${href}>)` : label;
      }
      return part.text;
    })
    .join('');

export const getBlockTags = (comment: Comment | undefined, tag: string) =>
  (comment?.blockTags ?? []).filter((block) => block.tag === tag);

export const hasBlockTag = (comment: Comment | undefined, tag: string) =>
  getBlockTags(comment, tag).length > 0;

export const hasModifierTag = (comment: Comment | undefined, tag: string) =>
  !!comment?.modifierTags?.includes(tag as never);

/** `@returns` → `Returns`, `@defaultValue` → `Default value` */
export const tagLabel = (tag: string) => {
  const words = tag.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/**
 * The summary's first sentence (a module's or an index's one-line summary): up to the first
 * `.`, `!` or `?` that ends a sentence, in its first paragraph
 */
export const firstSentence = (markdown: string) => {
  const paragraph = markdown
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ');
  const match = /^(.*?[.!?])(?=\s+[A-Z`(_*[]|$)/.exec(paragraph);
  return (match?.[1] ?? paragraph).trim();
};
