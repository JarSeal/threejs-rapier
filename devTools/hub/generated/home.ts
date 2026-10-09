import path from 'node:path';
import type { ProjectMetadata } from '../../projectMetadata';
import { escapeHtml } from '../html';
import { resolveHubLink, slugify, type HubMarkdownEnv } from '../markdown';
import { CHANGELOG_FILE, HUB_PAGES_DIR, PACKAGE_JSON_FILE } from '../paths';
import { toRepoWebUrl } from '../repoFiles';
import type { HubGeneratedSection } from './section';
import { VERSION_SECTION_PATH, type HubChangePart, type HubLatestChange } from './version';

/**
 * The homepage's generated slots (p555 Phase 2):
 * - the hero's side text: the engine's description from `package.json`
 *   (`engine_metadata.description`), so the Hub and the package say the same thing;
 * - "What's new": `CHANGELOG.md`'s latest entry (its date, branch and the parts it bumped), linked
 *   to its anchor on the Version page. The anchor is the heading's slug, built here (the homepage
 *   renders before the changelog), and checked like any `hub:` link after the render;
 * - the quick links, GitHub's from `package.json`'s repository.
 */

const HOME_PATH = '';
const HERO_SIDE_SLOT = 'generated-hero-side';
const WHATS_NEW_SLOT = 'generated-whats-new';
const QUICK_LINKS_SLOT = 'generated-quick-links';

const HOME_FILE = path.join(HUB_PAGES_DIR, 'index.html');

const QUICK_LINKS = [
  {
    href: 'hub:documentation',
    icon: 'book-open',
    label: 'Documentation',
    text: 'The API reference',
  },
  { href: 'hub:examples', icon: 'box', label: 'Examples', text: 'Scenes to run and read' },
  { href: 'hub:issues', icon: 'bug', label: 'Issues', text: 'Known issues and workarounds' },
] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-10-08` → `8 October 2026`, the same in every locale */
const formatDate = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
};

const PART_LABELS: Record<HubChangePart['part'], string> = {
  engine: 'Engine',
  toolkit: 'Toolkit',
  app: 'App',
  project: 'Project',
};

const renderPart = ({ part, version, codename }: HubChangePart) =>
  `<li><span class="hubChangePartName">${PART_LABELS[part]}</span>${
    part === 'project'
      ? '<span class="hubChangePartCodename">Tooling</span>'
      : `<code class="hubChangePartVersion">${escapeHtml(version)}</code><span class="hubChangePartCodename">${escapeHtml(codename)}</span>`
  }</li>`;

const renderWhatsNew = (latest: HubLatestChange | null, env: HubMarkdownEnv) => {
  env.file = CHANGELOG_FILE;
  const arrow = env.icons.render('arrow-right', HOME_FILE);
  const title = `<h2>What's new</h2>\n`;
  if (!latest) {
    const href = resolveHubLink(`hub:${VERSION_SECTION_PATH}`, env, CHANGELOG_FILE, 1);
    return `${title}<p>No changelog entry yet.</p>\n<a class="hubMoreLink" href="${href}">See the versions${arrow}</a>\n`;
  }
  // The changelog's heading, as the Version page renders it: `## 2026-10-08 — aekasha-hub`
  const anchor = slugify(`${latest.date} — ${latest.branch}`);
  const href = resolveHubLink(`hub:${VERSION_SECTION_PATH}#${anchor}`, env, CHANGELOG_FILE, 1);
  return `${title}<p class="hubWhatsNewMeta"><time datetime="${latest.date}">${formatDate(latest.date)}</time><code>${escapeHtml(latest.branch)}</code></p>
<ul class="hubChangeParts">${latest.parts.map(renderPart).join('')}</ul>
<a class="hubMoreLink" href="${href}">Read the changelog entry${arrow}</a>
`;
};

const renderQuickLink = (
  href: string,
  icon: string,
  label: string,
  text: string,
  env: HubMarkdownEnv
) =>
  `<li><a class="hubQuickLink" href="${href}">${env.icons.render(icon, HOME_FILE)}<span class="hubQuickLinkBody"><span class="hubQuickLinkLabel">${label}</span><span class="hubQuickLinkText">${text}</span></span>${env.icons.render('arrow-right', HOME_FILE)}</a></li>`;

const renderQuickLinks = (repoUrl: string, env: HubMarkdownEnv) => {
  env.file = HOME_FILE;
  const links = QUICK_LINKS.map(({ href, icon, label, text }) =>
    renderQuickLink(resolveHubLink(href, env, HOME_FILE, 1), icon, label, text, env)
  );
  links.push(renderQuickLink(escapeHtml(repoUrl), 'github', 'GitHub', 'The source', env));
  return `<ul class="hubQuickLinks">${links.join('')}</ul>\n`;
};

/** The repo's web URL, from `package.json`: the Hub's GitHub links and its source links */
export const getRepoWebUrl = (meta: ProjectMetadata) => toRepoWebUrl(meta.engine.repoUrl);

export const createHomeSection = (
  meta: ProjectMetadata,
  latestChange: HubLatestChange | null
): HubGeneratedSection => ({
  path: HOME_PATH,
  slots: {
    [HERO_SIDE_SLOT]: (_md, env) => {
      env.file = PACKAGE_JSON_FILE;
      return `<p>${escapeHtml(meta.engine.description)}</p>\n`;
    },
    [WHATS_NEW_SLOT]: (_md, env) => renderWhatsNew(latestChange, env),
    [QUICK_LINKS_SLOT]: (_md, env) => renderQuickLinks(getRepoWebUrl(meta), env),
  },
  pages: [],
  files: [PACKAGE_JSON_FILE, CHANGELOG_FILE],
  dirs: [],
});
