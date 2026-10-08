import type { ProjectMetadata } from '../projectMetadata';
import { hashContent } from './hash';
import type { HubHeading, HubNavItem, HubPage } from './types';

/**
 * `hub-data.js`, loaded on every page (p550 §3.5): `window.AEK_HUB = { versions, build, nav,
 * pages }`. Small on purpose: the full text for search goes into the lazily loaded
 * `hub-search.js` (p552).
 */

export type HubDataPage = {
  path: string;
  title: string;
  tags: string[];
  description: string;
  /** The top-level section's path ('' the homepage) */
  section: string;
  headings: HubHeading[];
};

export type HubData = {
  versions: Record<'engine' | 'toolkit' | 'app', { version: string; codename: string }> & {
    project: string;
  };
  build: ProjectMetadata['build'];
  nav: HubNavItem[];
  pages: HubDataPage[];
};

export const HUB_DATA_GLOBAL = 'AEK_HUB';

export const getPageSection = (page: HubPage) => {
  let top = page;
  while (top.parent?.parent) top = top.parent;
  return top.parent ? top.path : '';
};

const toNavItem = (page: HubPage): HubNavItem => ({
  path: page.path,
  title: page.menu,
  icon: page.icon,
  children: page.children.map(toNavItem),
});

export const buildHubData = (
  meta: ProjectMetadata,
  homepage: HubPage,
  pages: HubPage[],
  headings: Map<HubPage, HubHeading[]>
) => {
  const data: HubData = {
    versions: {
      engine: { version: meta.engine.version, codename: meta.engine.codename },
      toolkit: { version: meta.toolkit.version, codename: meta.toolkit.codename },
      app: { version: meta.app.version, codename: meta.app.codename },
      project: meta.pkgVersion,
    },
    build: meta.build,
    nav: [toNavItem(homepage)],
    pages: pages.map((page) => ({
      path: page.path,
      title: page.title,
      tags: page.tags,
      description: page.description,
      section: getPageSection(page),
      headings: headings.get(page) ?? [],
    })),
  };
  const content = `window.${HUB_DATA_GLOBAL} = ${JSON.stringify(data)};\n`;
  return { outPath: '_assets/hub-data.js', content, hash: hashContent(content) };
};
