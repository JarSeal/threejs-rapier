import { lineAt, type HubDiagnostics } from './diagnostics';
import { escapeHtml } from './html';
import type { HubIcons } from './icons';
import { getPageTrail } from './pages';
import type { HubHeading, HubPage } from './types';

/**
 * Puts a page into `hub/_layout/shell.html`. The shell's `{{name}}` placeholders are filled in
 * one pass, so a page's own text is never read as one. `{{name:arg}}` ones are the markup
 * helpers (`HubMarkupHelpers`), which a page's own markup has too. The menu is rendered here per
 * page, with the active item and its ancestors marked (p550 §3.5): no flash, and it works without
 * JS.
 */

/**
 * `{{icon:search}}` (an inline icon), `{{asset:images/hero.webp}}` (a static asset's URL with its
 * `?v=`) and, in the shell, `{{link:version}}` (a page's URL, checked). `root` is the relative
 * path to the site root of the page being filled.
 */
export type HubMarkupHelpers = Record<
  'icon' | 'asset' | 'link',
  (arg: string, root: string, file: string, line: number) => string
>;

/** `{{name}}` or `{{name:arg}}` */
export const PLACEHOLDER_REGEX = /\{\{\s*(\w+)(?::([^}\s]+))?\s*\}\}/g;

/** The values every page of a build shares (with its own `root`) */
export type ShellSiteValues = {
  /** The relative path to the site root (`../../`), or '' when a `<base>` sets it (404) */
  root: string;
  siteTitle: string;
  /** Extra `<head>` markup (the 404 page's `<base>` script, p551 Phase 2's dev client) */
  head: string;
  nav: string;
  /** The asset URLs with their `?v=` */
  css: string;
  js: string;
  dataJs: string;
  engineVersion: string;
  githubUrl: string;
};

export type ShellPageValues = {
  /** The `<title>`: the page's, then the site's */
  title: string;
  pageTitle: string;
  description: string;
  pagePath: string;
  /** The top-level section's path ('' the homepage), for section-specific styles */
  section: string;
  bodyClass: string;
  breadcrumbs: string;
  toc: string;
  body: string;
};

export type ShellValues = ShellSiteValues & ShellPageValues;

/** The headings the TOC lists, and how many it needs to show at all */
const TOC_LEVELS = [2, 3];
const TOC_MIN_HEADINGS = 3;

export const fillShell = (
  shell: string,
  shellFile: string,
  values: ShellValues,
  helpers: HubMarkupHelpers,
  diag: HubDiagnostics
) =>
  shell.replace(
    PLACEHOLDER_REGEX,
    (match, key: string, arg: string | undefined, offset: number) => {
      if (arg !== undefined && key in helpers) {
        return helpers[key as keyof HubMarkupHelpers](
          arg,
          values.root,
          shellFile,
          lineAt(shell, offset)
        );
      }
      if (arg === undefined && key in values) return values[key as keyof ShellValues];
      diag.error(shellFile, lineAt(shell, offset), `Unknown placeholder ${match}`);
      return '';
    }
  );

export const pageHref = (root: string, page: HubPage) =>
  page.path ? root + page.path : root || './';

/**
 * The top nav: the homepage, then its children, each with its own children as a dropdown that a
 * chevron button opens (`hub.ts`; hover opens it too). `active` is the page on screen (null on
 * the 404 page): its top-level item is marked active, and the page itself `aria-current`.
 */
export const renderNav = (
  homepage: HubPage,
  active: HubPage | null,
  root: string,
  icons: HubIcons
) => {
  const trail = new Set(active ? getPageTrail(active) : []);
  const item = (page: HubPage, isTop: boolean): string => {
    const isCurrent = page === active;
    const isInTrail = page !== homepage && trail.has(page);
    const menuPages = page.children.filter((child) => child.isInMenu);
    const hasMenu = isTop && page !== homepage && menuPages.length > 0;
    const classes = [
      'hubNavItem',
      isCurrent || isInTrail ? 'hubNavItem_active' : '',
      hasMenu ? 'hubNavItem_hasMenu' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const icon = isTop && page.icon ? icons.render(page.icon, page.file) : '';
    const link = `<a class="hubNavLink" href="${pageHref(root, page)}"${isCurrent ? ' aria-current="page"' : ''}>${icon}<span>${escapeHtml(page.menu)}</span></a>`;
    if (!hasMenu) return `<li class="${classes}">${link}</li>`;
    const menuId = `hubNavMenu_${page.path.replace(/\/$/, '').replace(/[^\w-]/g, '_')}`;
    const toggle = `<button type="button" class="hubNavToggle" aria-expanded="false" aria-controls="${menuId}" aria-label="${escapeHtml(page.menu)}: show its pages">${icons.render('chevron-down', page.file)}</button>`;
    const menu = `<ul class="hubNavDropdown" id="${menuId}">${menuPages.map((child) => item(child, false)).join('')}</ul>`;
    return `<li class="${classes}">${link}${toggle}${menu}</li>`;
  };
  return `<ul class="hubNavList">${[homepage, ...homepage.children].map((page) => item(page, true)).join('')}</ul>`;
};

export const renderBreadcrumbs = (page: HubPage, root: string) => {
  if (!page.parent) return '';
  const items = getPageTrail(page).map((p) =>
    p === page
      ? `<li aria-current="page">${escapeHtml(p.menu)}</li>`
      : `<li><a href="${pageHref(root, p)}">${escapeHtml(p.menu)}</a></li>`
  );
  return `<nav class="hubBreadcrumbs" aria-label="Breadcrumbs"><ol>${items.join('')}</ol></nav>`;
};

export const renderToc = (headings: HubHeading[]) => {
  const listed = headings.filter((h) => TOC_LEVELS.includes(h.level));
  if (listed.length < TOC_MIN_HEADINGS) return '';
  const items = listed.map(
    (h) =>
      `<li class="hubTocItem hubTocItem_h${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`
  );
  return `<nav class="hubToc" aria-label="On this page"><p class="hubTocTitle">On this page</p><ul>${items.join('')}</ul></nav>`;
};
