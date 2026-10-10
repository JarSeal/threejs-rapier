// No imports: `hub/hub.config.ts` imports `HubConfig` from here, and `hub/tsconfig.json` checks it
// without Node's types.

export type HubBuildMode = 'dev' | 'public';

/** `hub/hub.config.ts`'s default export */
export type HubConfig = {
  /** The site's name: the `<title>` suffix, the footer */
  title: string;
  /** The homepage's `<meta name="description">` when its page sets none */
  description: string;
  /**
   * CLAUDE.md sections that aren't features (p555 §2.5, the root's Architecture sections and the
   * nested files' `## ` ones), by heading without its parenthetical: the coverage check doesn't ask
   * a page's `aek:covers` for them
   */
  coverageIgnore: string[];
};

export type HubHeading = {
  /** 1-6 */
  level: number;
  id: string;
  /** Plain text, without the anchor */
  text: string;
};

/** An empty element with an `id` in a page's body, filled by `<id>.md` (p550 §3.3) */
export type HubSlot = {
  id: string;
  /** The element's opening and closing tags, as written */
  openTag: string;
  closeTag: string;
  /** Its offset and length in the page's body, and its line in `index.html` */
  offset: number;
  length: number;
  line: number;
  /** `<id>.md` in the page's folder, or null when there is none */
  mdFile: string | null;
  /** A generated section's generator fills it (p551 §2.5), never an `.md` */
  isGenerated: boolean;
};

export type HubPage = {
  /** The URL path from the site root, with a trailing slash: '' (the homepage), 'examples/physics/' */
  path: string;
  /** The page's folder and its `index.html` */
  dir: string;
  file: string;
  /** `<title>` */
  title: string;
  /** `aek:menu`, else the title */
  menu: string;
  /** `aek:order` (default 0): the menu order among siblings, then the title */
  order: number;
  /** `aek:tags` */
  tags: string[];
  /** `aek:description` */
  description: string;
  /** `aek:icon`: a file name in `hub/_assets/icons/` without `.svg` */
  icon: string;
  /** `aek:featured` */
  isFeatured: boolean;
  /**
   * `aek:image` as written: `scene:<sceneId>` (the scene's Hub image) or a path from the repo
   * root. The build checks it and sets `imageFile` (p555's cards show it).
   */
  image: string;
  /** The image `aek:image` points to, null without one (or when it isn't there) */
  imageFile: string | null;
  /** `aek:group`: the group a `::: cards <path> group=<name>` shows it in (the Features page's) */
  group: string;
  /**
   * `aek:covers`: the CLAUDE.md sections the page covers (p555 §2.5; the root's Architecture
   * sections and the nested files' `## ` ones), by heading without its parenthetical (`Debug
   * system`). `::: claude-md` links them in dev.
   */
  covers: string[];
  /**
   * A generated section's child page (an issue): it has no `index.html`, `dir` and `file` are its
   * source's (`docs/issues/<name>.md`)
   */
  isGenerated: boolean;
  /** Listed in the nav's dropdowns (generated pages can leave themselves out) */
  isInMenu: boolean;
  /**
   * In the search: its sections in the index, and the page in `hub-data.js`'s `pages` (the
   * dialog's breadcrumbs). The API pages leave themselves out: their symbols are indexed apart.
   */
  isSearchable: boolean;
  /** The `<body>`'s inner HTML and the line it starts on */
  body: string;
  bodyLine: number;
  slots: HubSlot[];
  parent: HubPage | null;
  children: HubPage[];
};

/** A menu item in `hub-data.js` */
export type HubNavItem = {
  path: string;
  title: string;
  icon: string;
  children: HubNavItem[];
};

/** A page in `hub-data.js` (here, not in `data.ts`: the search dialog reads it too) */
export type HubDataPage = {
  path: string;
  title: string;
  tags: string[];
  description: string;
  /** The top-level section's path ('' the homepage) */
  section: string;
  headings: HubHeading[];
};
