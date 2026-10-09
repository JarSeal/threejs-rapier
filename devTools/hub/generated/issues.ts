import fs from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { HubDiagnostics } from '../diagnostics';
import { decodeEntities, escapeHtml } from '../html';
import { renderMarkdownText, slugify, type HubMarkdownEnv } from '../markdown';
import { ISSUES_DIR } from '../paths';
import type { HubGeneratedPage, HubGeneratedSection } from './section';

/**
 * The Issues section (p551 §2.5): every `docs/issues/*.md` gets a page at `/issues/<file name>/`,
 * and the section's page lists them grouped by status, each with its summary.
 *
 * An issue file's header (the convention in CLAUDE.md): `**Title:** …` on line 1, then a block of
 * `Key: value` lines from line 3, `Status: …` first. The title becomes the page's `<h1>`, the
 * status a badge (`open | fixed upstream, …`: the badge is the part before the first `|`), and the
 * other keys a list under it; the rest of the file is rendered as it is. Without a `**Title:**`
 * line the title is the first heading (an `# h1` is then left out of the body), else the file
 * name; without a `Status:` line the issue counts as open, shown as "Status not stated".
 */

export const ISSUES_SECTION_PATH = 'issues/';
/** The section page's slot for the list, and each issue page's for its content */
const LIST_SLOT = 'generated-issues';
const ISSUE_SLOT = 'generated-issue';

const TITLE_LINE_REGEX = /^\*\*Title:\*\*\s*(.+?)\s*$/;
/** A header line: `Status: open`, `File at: https://…`, `Our workaround: …` */
const META_LINE_REGEX = /^([A-Z][A-Za-z ]{0,30}):\s+(\S.*?)\s*$/;
const CLOSED_STATUSES = ['fixed', 'closed', 'resolved', 'done', "won't fix", 'wontfix'];
/** The breadcrumbs' label and the `<meta name="description">` are cut to about this */
const MENU_LENGTH = 48;
const DESCRIPTION_LENGTH = 200;

type IssueStatusKind = 'open' | 'closed' | 'other';

type IssueStatus = {
  /** Lowercased, the issues are grouped by it: `open`, `not filed yet` */
  group: string;
  /** The badge: `open`, `Status not stated` */
  label: string;
  /** Markdown: what came after the first `|` */
  detail: string;
  kind: IssueStatusKind;
};

type Issue = {
  name: string;
  file: string;
  path: string;
  /** Markdown */
  title: string;
  plainTitle: string;
  status: IssueStatus;
  /** The header's other lines, Markdown values */
  meta: { key: string; value: string }[];
  /** The file with its header lines blanked, so lines keep their numbers in diagnostics */
  body: string;
  /** The summary paragraph's Markdown and line, or null when the file has none */
  summary: { text: string; line: number } | null;
};

/** No `hub:` links or plugins: for titles, plain text and finding the summary */
const plainMd = new MarkdownIt({ html: false });

const toPlainText = (markdown: string) =>
  decodeEntities(plainMd.renderInline(markdown).replace(/<[^>]*>/g, '')).trim();

const shorten = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,.;:]+$/, '')}…`;
};

const parseStatus = (value: string | undefined): IssueStatus => {
  if (!value) return { group: 'open', label: 'Status not stated', detail: '', kind: 'open' };
  const [label, ...rest] = value.split('|').map((part) => part.trim());
  const group = label.toLowerCase();
  const kind: IssueStatusKind =
    group === 'open' ? 'open' : CLOSED_STATUSES.includes(group) ? 'closed' : 'other';
  return { group, label, detail: rest.join(' | '), kind };
};

/** A paragraph that is one bold text, the way a template writes a section title */
const isBoldLabel = (inline: Token) => {
  const children = (inline.children ?? []).filter(
    (child) => !(child.type === 'text' && !child.content.trim())
  );
  return children[0]?.type === 'strong_open' && children.at(-1)?.type === 'strong_close';
};

/**
 * The summary: the first paragraph of the first section (after a heading or a bold label line,
 * so a template's preamble is skipped), else the first paragraph
 */
const findSummary = (body: string) => {
  const tokens = plainMd.parse(body, {});
  let isInSection = false;
  let first: Token | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') isInSection = true;
    if (token.type !== 'paragraph_open' || token.level !== 0) continue;
    const inline = tokens[i + 1];
    if (isBoldLabel(inline)) {
      isInSection = true;
      continue;
    }
    if (isInSection) {
      first = inline;
      break;
    }
    first ??= inline;
  }
  return first ? { text: first.content, line: (first.map?.[0] ?? 0) + 1 } : null;
};

const parseIssue = (file: string, diag: HubDiagnostics): Issue => {
  const name = path.basename(file, '.md');
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const blank = (from: number, to = from + 1) => lines.fill('', from, to);

  let i = lines.findIndex((line) => line.trim());
  let title = i >= 0 ? TITLE_LINE_REGEX.exec(lines[i])?.[1] ?? '' : '';
  if (title) blank(i++);
  else {
    diag.warn(file, 1, 'No "**Title:** …" line 1 (the issue-file convention in CLAUDE.md)');
    const tokens = plainMd.parse(lines.join('\n'), {});
    const heading = tokens.findIndex((token) => token.type === 'heading_open');
    if (heading >= 0) {
      title = tokens[heading + 1].content;
      const [from, to] = tokens[heading].map ?? [0, 0];
      if (tokens[heading].tag === 'h1') blank(from, to); // The page's own <h1> shows it
    } else title = name;
  }

  const meta: Issue['meta'] = [];
  while (i >= 0 && i < lines.length && !lines[i].trim()) i++;
  for (let match; i >= 0 && (match = META_LINE_REGEX.exec(lines[i] ?? '')); i++) {
    meta.push({ key: match[1], value: match[2] });
    blank(i);
  }
  const statusIndex = meta.findIndex(({ key }) => key.toLowerCase() === 'status');
  const status = parseStatus(meta[statusIndex]?.value);
  if (statusIndex >= 0) meta.splice(statusIndex, 1);

  const body = lines.join('\n');
  return {
    name,
    file,
    path: `${ISSUES_SECTION_PATH}${slugify(name)}/`,
    title,
    plainTitle: toPlainText(title) || name,
    status,
    meta,
    body,
    summary: findSummary(body),
  };
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const renderStatus = (status: IssueStatus, md: MarkdownIt, env: HubMarkdownEnv) =>
  `<p class="hubIssueStatus"><span class="hubStatus hubStatus_${status.kind}">${escapeHtml(capitalize(status.label))}</span>${
    status.detail
      ? `<span class="hubIssueStatusDetail">${md.renderInline(status.detail, env)}</span>`
      : ''
  }</p>\n`;

const renderIssue = (issue: Issue, md: MarkdownIt, env: HubMarkdownEnv) => {
  env.file = issue.file;
  const meta = issue.meta.length
    ? `<dl class="hubMetaList">${issue.meta
        .map(
          ({ key, value }) =>
            `<div><dt>${escapeHtml(key)}</dt><dd>${md.renderInline(value, env)}</dd></div>`
        )
        .join('')}</dl>\n`
    : '';
  return (
    renderStatus(issue.status, md, env) + meta + renderMarkdownText(md, issue.body, issue.file, env)
  );
};

const groupOrder = (status: IssueStatus) =>
  status.group === 'open' ? 0 : status.kind === 'closed' ? 2 : 1;

/** The section page's list: a heading per status, open first and closed last */
const renderList = (issues: Issue[], md: MarkdownIt, env: HubMarkdownEnv) => {
  if (!issues.length) return '<p>No known issues.</p>\n';
  const groups = new Map<string, Issue[]>();
  const sorted = [...issues].sort(
    (a, b) =>
      groupOrder(a.status) - groupOrder(b.status) ||
      a.status.group.localeCompare(b.status.group) ||
      a.plainTitle.localeCompare(b.plainTitle)
  );
  for (const issue of sorted) {
    groups.set(issue.status.group, [...(groups.get(issue.status.group) ?? []), issue]);
  }
  let html = '';
  for (const [group, members] of groups) {
    html += renderMarkdownText(md, `## ${capitalize(group)}\n`, members[0].file, env);
    const items = members.map((issue) => {
      env.file = issue.file;
      // Rendered at its own line, so a diagnostic in it points there
      const summary = issue.summary
        ? md.render(`${'\n'.repeat(issue.summary.line - 1)}${issue.summary.text}\n`, env)
        : '';
      return `<li class="hubIssueItem">
<a class="hubIssueLink" href="${env.root}${issue.path}">${plainMd.renderInline(issue.title)}</a>
${renderStatus(issue.status, md, env)}${summary ? `<div class="hubIssueSummary">${summary}</div>` : ''}
</li>`;
    });
    html += `<ul class="hubIssueList">\n${items.join('\n')}\n</ul>\n`;
  }
  return html;
};

const toPage = (issue: Issue): HubGeneratedPage => ({
  path: issue.path,
  file: issue.file,
  title: issue.plainTitle,
  menu: shorten(issue.plainTitle, MENU_LENGTH),
  description: issue.summary ? shorten(toPlainText(issue.summary.text), DESCRIPTION_LENGTH) : '',
  tags: ['issue', issue.status.group],
  // The section page lists them; a dropdown of long titles would only crowd the nav
  isInMenu: false,
  body: `<h1 class="hubIssueTitle">${plainMd.renderInline(issue.title)}</h1>\n<div id="${ISSUE_SLOT}"></div>\n`,
  slots: { [ISSUE_SLOT]: (md, env) => renderIssue(issue, md, env) },
});

export const createIssuesSection = (diag: HubDiagnostics): HubGeneratedSection => {
  const files = fs.existsSync(ISSUES_DIR)
    ? fs
        .readdirSync(ISSUES_DIR)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => path.join(ISSUES_DIR, name))
    : [];
  const issues = files.map((file) => parseIssue(file, diag));
  return {
    path: ISSUES_SECTION_PATH,
    slots: { [LIST_SLOT]: (md, env) => renderList(issues, md, env) },
    pages: issues.map(toPage),
    files,
    dirs: [ISSUES_DIR],
  };
};
