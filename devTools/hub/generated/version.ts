import fs from 'node:fs';
import type MarkdownIt from 'markdown-it';
import type { ProjectMetadata } from '../../projectMetadata';
import type { HubDiagnostics } from '../diagnostics';
import { escapeHtml } from '../html';
import { renderMarkdownText, type HubMarkdownEnv } from '../markdown';
import { CHANGELOG_FILE, PACKAGE_JSON_FILE } from '../paths';
import type { HubGeneratedSection } from './section';

/**
 * The Version section (p551 §2.5): the engine's, toolkit's, app's and project's versions with
 * their codenames and the build's commit and time, then `CHANGELOG.md`. The changelog's headings
 * move one level down (`# Changelog` is the page's h2, an entry an h3), so the TOC lists the
 * entries and each one has its anchor: `#2026-10-07-dev-server-implementation`. The latest
 * entry goes into `hub-data.js` as `latestChange`, for the homepage's "What's new". The changelog
 * is out of the search (`hubSearchSkip`, p555): it was a large share of the index, and the
 * browser's own find searches it on this page.
 */

export const VERSION_SECTION_PATH = 'version/';
const VERSIONS_SLOT = 'generated-versions';
const CHANGELOG_SLOT = 'generated-changelog';

/** `## 2026-10-07 — dev-server-implementation` */
const ENTRY_REGEX = /^##\s+(\d{4}-\d{2}-\d{2})\s+[—–-]\s+(.+?)\s*$/;
/** `### Engine 4.12.0 (Afternoon)`, `### Project` */
const PART_REGEX = /^###\s+(?:(Engine|Toolkit|App)\s+(\S+)\s+\(([^)]+)\)|(Project))\s*$/;
const FENCE_REGEX = /^\s*(```|~~~)/;
/** A changelog's change labels (`**Added**`), styled as labels */
const CHANGE_LABEL_REGEX =
  /<p><strong>(Added|Changed|Deprecated|Fixed|Removed|Security)<\/strong><\/p>/g;

export type HubChangePart = {
  part: 'engine' | 'toolkit' | 'app' | 'project';
  /** '' for the project, whose version is the engine's */
  version: string;
  codename: string;
};

export type HubLatestChange = {
  date: string;
  branch: string;
  /** The entry's anchor on the Version page */
  path: string;
  hash: string;
  parts: HubChangePart[];
};

/** The first entry's date, branch and parts; its `hash` is filled when the changelog renders */
const parseLatestChange = (source: string): HubLatestChange | null => {
  let latest: HubLatestChange | null = null;
  let isInFence = false;
  for (const line of source.split('\n')) {
    if (FENCE_REGEX.test(line)) isInFence = !isInFence;
    if (isInFence) continue;
    const entry = ENTRY_REGEX.exec(line);
    if (entry) {
      if (latest) break;
      latest = {
        date: entry[1],
        branch: entry[2],
        path: VERSION_SECTION_PATH,
        hash: '',
        parts: [],
      };
      continue;
    }
    const part = latest && PART_REGEX.exec(line);
    if (!latest || !part) continue;
    latest.parts.push(
      part[4]
        ? { part: 'project', version: '', codename: '' }
        : {
            part: part[1].toLowerCase() as HubChangePart['part'],
            version: part[2],
            codename: part[3],
          }
    );
  }
  return latest;
};

/** `2026-10-08T09:14:03.120Z` → `2026-10-08 09:14 UTC` */
const formatTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const renderVersions = (meta: ProjectMetadata, md: MarkdownIt, env: HubMarkdownEnv) => {
  const rows = [
    ['Engine', meta.engine.version, meta.engine.codename],
    ['Toolkit', meta.toolkit.version, meta.toolkit.codename],
    ['App', meta.app.version, meta.app.codename],
    ['Project', meta.pkgVersion, ''],
  ].map(
    ([part, version, codename]) =>
      `<tr><th scope="row">${part}</th><td><code>${escapeHtml(version)}</code></td><td>${escapeHtml(codename) || '—'}</td></tr>`
  );
  const { commit, hasLocalChanges, time } = meta.build;
  const build = [
    commit
      ? `<div><dt>Commit</dt><dd><code>${escapeHtml(commit)}</code>${hasLocalChanges ? ' <span class="hubStatus hubStatus_other">local changes</span>' : ''}</dd></div>`
      : '',
    `<div><dt>Built</dt><dd><time datetime="${escapeHtml(time)}">${escapeHtml(formatTime(time))}</time></dd></div>`,
  ];
  return `${renderMarkdownText(md, '## Versions\n', PACKAGE_JSON_FILE, env)}<div class="hubTable">
<table class="hubVersionTable">
<thead><tr><th scope="col">Part</th><th scope="col">Version</th><th scope="col">Codename</th></tr></thead>
<tbody>${rows.join('')}</tbody>
</table>
</div>
<dl class="hubMetaList">${build.join('')}</dl>
`;
};

const renderChangelog = (
  source: string | null,
  latest: HubLatestChange | null,
  md: MarkdownIt,
  env: HubMarkdownEnv
) => {
  if (source === null) return '<p>No changelog yet.</p>\n';
  const headingCount = env.headings.length;
  const html = renderMarkdownText(md, source, CHANGELOG_FILE, env, 1).replace(
    CHANGE_LABEL_REGEX,
    (_match, label: string) =>
      `<p class="hubChangeLabel hubChangeLabel_${label.toLowerCase()}">${label}</p>`
  );
  if (latest) {
    const text = `${latest.date} — ${latest.branch}`;
    const heading = env.headings
      .slice(headingCount)
      .find((h) => h.level === 3 && h.text.replace(/\s+[—–-]\s+/, ' — ') === text);
    latest.hash = heading?.id ?? '';
  }
  return `<div class="hubChangelog hubSearchSkip">\n${html}</div>\n`;
};

export const createVersionSection = (meta: ProjectMetadata, diag: HubDiagnostics) => {
  const source = fs.existsSync(CHANGELOG_FILE) ? fs.readFileSync(CHANGELOG_FILE, 'utf-8') : null;
  const latestChange = source === null ? null : parseLatestChange(source);
  if (source === null) {
    diag.warn(CHANGELOG_FILE, undefined, 'No CHANGELOG.md: the Version page has no changelog');
  } else if (!latestChange) {
    diag.warn(
      CHANGELOG_FILE,
      undefined,
      'No "## YYYY-MM-DD — branch" entry: the homepage has no latest change to show'
    );
  }
  const section: HubGeneratedSection = {
    path: VERSION_SECTION_PATH,
    slots: {
      [VERSIONS_SLOT]: (md, env) => renderVersions(meta, md, env),
      [CHANGELOG_SLOT]: (md, env) => renderChangelog(source, latestChange, md, env),
    },
    pages: [],
    files: [CHANGELOG_FILE, PACKAGE_JSON_FILE],
    dirs: [],
  };
  return { section, latestChange };
};
