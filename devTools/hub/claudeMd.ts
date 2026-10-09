import { escapeHtml } from './html';
import { openInEditorHref, registerHubDirective } from './markdown';
import { CLAUDE_MD_FILE, readClaudeMdSections } from './repoFiles';

/**
 * `::: claude-md` … `:::` (p555 §2.1): a feature page's "Read more" line to the CLAUDE.md
 * Architecture sections its `aek:covers` names, each opening the editor at its heading. Dev only:
 * CLAUDE.md is the contributors' (and their agents') notes, so a `public` build renders nothing.
 * Both modes check the names while CLAUDE.md is there (a build outside the repo skips it). The
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
    const links: string[] = [];
    for (const name of env.page.covers) {
      const section = sections.find((s) => s.name === name);
      if (!section) {
        env.diag.error(
          env.page.file,
          undefined,
          `aek:covers: CLAUDE.md has no Architecture section "${name}" (it has: ${sections.map((s) => s.name).join(', ')})`
        );
        continue;
      }
      links.push(
        `<a href="${openInEditorHref(CLAUDE_MD_FILE, section.line)}" data-hub-open-in-editor title="Open in your editor">${escapeHtml(section.heading)}</a>`
      );
    }
    if (env.mode !== 'dev' || !links.length) return '';
    return `<p class="hubDevNote">${env.icons.render('book-open', env.file, line)}<span>In CLAUDE.md (dev only): ${links.join(', ')}</span></p>\n`;
  },
  close: () => '',
});
