import path from 'node:path';
import type { HubDiagnostics } from './diagnostics';
import { escapeHtml } from './html';
import { openInEditorHref, registerHubDirective } from './markdown';
import { ROOT } from './paths';
import { CLAUDE_MD_FILE, readClaudeMdSections, type ClaudeMdSection } from './repoFiles';
import type { HubPage } from './types';

/**
 * The CLAUDE.md sections on the Hub (p555, p605 S9): the root's Architecture sections and the nested
 * files' sections. The coverage check, and `::: claude-md`, a feature page's dev-only "Read more"
 * line to the sections its `aek:covers` names.
 */

/**
 * The sections the build's coverage check read, which the build's `::: claude-md` directives
 * reuse: the nested files are listed through git once per build, not once per page
 */
let buildSections: ClaudeMdSection[] | null | undefined;

/**
 * The coverage check (p555 §2.5): every page's `aek:covers` names a CLAUDE.md section, and every
 * section outside `ignore` (`hub.config.ts`'s `coverageIgnore`) is covered by a page, so a new
 * subsystem section without a feature page is a warning. An unknown name is an error. A build
 * outside the repo (no root CLAUDE.md) skips it. Runs before any page renders. Returns the files
 * it read, for the watcher.
 */
export const checkClaudeMdCoverage = (
  pages: HubPage[],
  ignore: string[],
  diag: HubDiagnostics
): string[] => {
  const sections = readClaudeMdSections();
  buildSections = sections;
  if (!sections) return [];
  const names = new Set(sections.map((s) => s.name));
  const covered = new Set<string>();
  for (const page of pages) {
    for (const name of page.covers) {
      if (names.has(name)) covered.add(name);
      else {
        diag.error(
          page.file,
          undefined,
          `aek:covers: no CLAUDE.md has a section "${name}" (the root's Architecture and the nested files have: ${[...names].join(', ')})`
        );
      }
    }
  }
  for (const name of ignore) {
    if (!names.has(name)) {
      diag.warn(
        CLAUDE_MD_FILE,
        undefined,
        `hub.config.ts's coverageIgnore names "${name}", which isn't a section here or in a nested CLAUDE.md`
      );
    }
  }
  for (const section of sections) {
    if (covered.has(section.name) || ignore.includes(section.name)) continue;
    diag.warn(
      section.file,
      section.line,
      `The CLAUDE.md section "${section.name}" has no Hub page: name it in a feature page's aek:covers, or in hub.config.ts's coverageIgnore when it isn't a feature`
    );
  }
  return [...new Set([CLAUDE_MD_FILE, ...sections.map((section) => section.file)])];
};

/** A section's link text: a nested file's section names its file */
const toLinkText = (section: ClaudeMdSection) =>
  section.file === CLAUDE_MD_FILE
    ? escapeHtml(section.heading)
    : `${escapeHtml(section.heading)} (<code>${escapeHtml(path.relative(ROOT, section.file).split(path.sep).join('/'))}</code>)`;

/**
 * `::: claude-md` … `:::`: links each section the page's `aek:covers` names (a name in the root
 * and in a nested file links both), opening the editor at its heading. Dev only: CLAUDE.md is the
 * contributors' (and their agents') notes, so a `public` build renders nothing. An unknown name is
 * the coverage check's error, and is left out here. The directive takes no content.
 */
registerHubDirective('claude-md', {
  open: (_args, { env, line, tokens, idx }) => {
    if (tokens[idx + 1]?.type !== 'hub_directive_close') {
      env.diag.warn(env.file, line, '::: claude-md takes no content: it renders after the line');
    }
    const sections = buildSections === undefined ? readClaudeMdSections() : buildSections;
    if (!sections) return '';
    if (!env.page.covers.length) {
      env.diag.error(
        env.file,
        line,
        `::: claude-md links the page's aek:covers, and ${env.page.path || 'the homepage'} has none`
      );
      return '';
    }
    const linked = env.page.covers.flatMap((name) =>
      sections.filter((section) => section.name === name)
    );
    env.includes.push(CLAUDE_MD_FILE, ...linked.map((section) => section.file));
    const links = linked.map(
      (section) =>
        `<a href="${openInEditorHref(section.file, section.line)}" data-hub-open-in-editor title="Open in your editor">${toLinkText(section)}</a>`
    );
    if (env.mode !== 'dev' || !links.length) return '';
    return `<p class="hubDevNote">${env.icons.render('book-open', env.file, line)}<span>In CLAUDE.md (dev only): ${links.join(', ')}</span></p>\n`;
  },
  close: () => '',
});
