import type { JSONOutput } from 'typedoc';
import type { Comment } from './model';

/**
 * JSDoc comments as the Hub's Markdown (p553 §2.2). TypeDoc's comment model is display parts:
 * text, code (with its backticks) and inline tags. `{@link}` prints its text as code until
 * Phase 2 resolves it.
 */

export type CommentParts = JSONOutput.CommentDisplayPart[] | undefined;

/** Inline code for any text: a run of backticks longer than the text's longest */
export const toInlineCode = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
};

const LINK_TAGS = ['@link', '@linkcode', '@linkplain'];

export const partsToMarkdown = (parts: CommentParts) =>
  (parts ?? [])
    .map((part) => {
      if (part.kind === 'inline-tag' && LINK_TAGS.includes(part.tag)) {
        return toInlineCode(part.text);
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
