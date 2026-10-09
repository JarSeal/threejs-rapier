import type { HubDiagnostics } from './diagnostics';
import { escapeHtml } from './html';
import { openInEditorHref, registerHubDirective } from './markdown';
import { CLAUDE_MD_FILE, readClaudeMdSections } from './repoFiles';
import type { HubPage } from './types';

/**
 * CLAUDE.md's Architecture sections on the Hub (p555): the coverage check, and `::: claude-md`,
 * a feature page's dev-only "Read more" line to the sections its `aek:covers` names.
 */

/**
 * The coverage check (p555 §2.5): every page's `aek:covers` names a CLAUDE.md Architecture section,
 * and every section outside `ignore` (`hub.config.ts`'s `coverageIgnore`) is covered by a page,
 * so a new subsystem section without a feature page is a warning. An unknown name is an error. A
 * build outside the repo (no CLAUDE.md) skips it. Returns the file it read, for the watcher.
 */
export const checkClaudeMdCoverage = (
  pages: HubPage[],
  ignore: string[],
  diag: HubDiagnostics
): string[] => {
  const sections = readClaudeMdSections();
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
          `aek:covers: CLAUDE.md has no Architecture section "${name}" (it has: ${[...names].join(', ')})`
        );
      }
    }
  }
  for (const name of ignore) {
    if (!names.has(name)) {
      diag.warn(
        CLAUDE_MD_FILE,
        undefined,
        `hub.config.ts's coverageIgnore names "${name}", which isn't an Architecture section here`
      );
    }
  }
  for (const section of sections) {
    if (covered.has(section.name) || ignore.includes(section.name)) continue;
    diag.warn(
      CLAUDE_MD_FILE,
      section.line,
      `The Architecture section "${section.name}" has no Hub page: name it in a feature page's aek:covers, or in hub.config.ts's coverageIgnore when it isn't a feature`
    );
  }
  return [CLAUDE_MD_FILE];
};

/**
 * `::: claude-md` … `:::`: links each section the page's `aek:covers` names, opening the editor at
 * its heading. Dev only: CLAUDE.md is the contributors' (and their agents') notes, so a `public`
 * build renders nothing. An unknown name is the coverage check's error, and is left out here. The
 * directive takes no content.
 */
registerHubDirective('claude-md', {
  open: (_args, { env, line, tokens, idx }) => {
    if (tokens[idx + 1]?.type !== 'hub_directive_close') {
      env.diag.warn(env.file, line, '::: claude-md takes no content: it renders after the line');
    }
    const sections = readClaudeMdSections();
    if (!sections) return '';
    env.includes.push(CLAUDE_MD_FILE);
    if (!env.page.covers.length) {
      env.diag.error(
        env.file,
        line,
        `::: claude-md links the page's aek:covers, and ${env.page.path || 'the homepage'} has none`
      );
      return '';
    }
    const links = env.page.covers
      .flatMap((name) => sections.filter((section) => section.name === name))
      .map(
        (section) =>
          `<a href="${openInEditorHref(CLAUDE_MD_FILE, section.line)}" data-hub-open-in-editor title="Open in your editor">${escapeHtml(section.heading)}</a>`
      );
    if (env.mode !== 'dev' || !links.length) return '';
    return `<p class="hubDevNote">${env.icons.render('book-open', env.file, line)}<span>In CLAUDE.md (dev only): ${links.join(', ')}</span></p>\n`;
  },
  close: () => '',
});
