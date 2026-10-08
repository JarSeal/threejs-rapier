import type MarkdownIt from 'markdown-it';
import type { HubMarkdownEnv } from '../markdown';

/**
 * A generated section (p550 §3.3, p551 §2.5): a hand-written page under `hub/pages/` whose
 * listed slots a generator fills, plus the child pages it adds. The generator reads its sources
 * once per build; the slots render in the page's Markdown env, so their headings reach the TOC
 * and their `hub:` links are checked like any page's.
 */

/** Renders a slot's content: set `env.file` to the source being rendered, for its diagnostics */
export type HubSlotGenerator = (md: MarkdownIt, env: HubMarkdownEnv) => string;

export type HubGeneratedPage = {
  /** The page's site path: `issues/three-bind-group-cache-light-leak/` */
  path: string;
  /** Its source: the page's `file`, and `dir` its folder (relative Markdown images) */
  file: string;
  title: string;
  /** The breadcrumbs' label */
  menu: string;
  description: string;
  tags: string[];
  isInMenu: boolean;
  /** The page's markup: `{{root}}`, `hub:` links and slots work as in a page's `<body>` */
  body: string;
  /** Its slots' generators, by slot id */
  slots: Record<string, HubSlotGenerator>;
};

export type HubGeneratedSection = {
  /** The hand-written page it fills: `issues/` */
  path: string;
  /** The slots of that page it fills, by id (`<div id="generated-issues"></div>`) */
  slots: Record<string, HubSlotGenerator>;
  pages: HubGeneratedPage[];
  /** Every source file it read (an error in one shows on the section's page), for the watcher */
  files: string[];
  /** Folders whose added and removed files change it (`docs/issues/`), for the watcher */
  dirs: string[];
};
