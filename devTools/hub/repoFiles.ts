import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths';

/**
 * The repo's own files on Hub pages (p555): `repo:` links (`markdown.ts`) and CLAUDE.md's
 * Architecture sections (`claudeMd.ts`, the feature pages' `aek:covers`). No Hub imports, so both
 * can use it.
 */

/** The agents' architecture notes, whose Architecture sections the feature pages cover */
export const CLAUDE_MD_FILE = path.join(ROOT, '.claude', 'CLAUDE.md');

/** `https://github.com/JarSeal/aekasha-js.git` → `https://github.com/JarSeal/aekasha-js` */
export const toRepoWebUrl = (url: string) =>
  url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

export type MarkdownFileHeading = {
  level: number;
  /** As written, inline Markdown included */
  text: string;
  /** GitHub's anchor for it, unique in the file (`-1`, `-2` on repeats, as GitHub does) */
  slug: string;
  /** 1-based */
  line: number;
};

/** Inline Markdown to the text GitHub slugs: code, links and emphasis unwrapped */
const toPlainText = (text: string) =>
  text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .trim();

/** GitHub's heading anchor (github-slugger): lower case, punctuation dropped, spaces to `-` */
const githubSlug = (text: string) =>
  toPlainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');

/** A Markdown file's ATX headings (`## Title`), outside code fences */
export const readMarkdownHeadings = (source: string): MarkdownFileHeading[] => {
  const headings: MarkdownFileHeading[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  source.split('\n').forEach((lineText, index) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(lineText);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1].startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lineText);
    if (!match) return;
    const base = githubSlug(match[2]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({
      level: match[1].length,
      text: match[2],
      slug: count ? `${base}-${count}` : base,
      line: index + 1,
    });
  });
  return headings;
};

export type ClaudeMdSection = {
  /** The heading without a trailing parenthetical: `Debug system`, what `aek:covers` names */
  name: string;
  /** The heading as written: `Debug system (dual-layer, lazy-loaded)` */
  heading: string;
  line: number;
};

/** The `### ` sections under CLAUDE.md's `## Architecture`, null when the file isn't there */
export const readClaudeMdSections = (): ClaudeMdSection[] | null => {
  if (!fs.existsSync(CLAUDE_MD_FILE)) return null;
  const sections: ClaudeMdSection[] = [];
  let isInArchitecture = false;
  for (const heading of readMarkdownHeadings(fs.readFileSync(CLAUDE_MD_FILE, 'utf-8'))) {
    if (heading.level <= 2)
      isInArchitecture = heading.level === 2 && heading.text === 'Architecture';
    else if (isInArchitecture && heading.level === 3) {
      const text = toPlainText(heading.text);
      sections.push({ name: text.replace(/\s*\([^)]*\)$/, ''), heading: text, line: heading.line });
    }
  }
  return sections;
};
