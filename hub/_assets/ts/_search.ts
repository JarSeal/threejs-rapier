import MiniSearch, { type SearchResult } from 'minisearch';
import {
  apiSearchName,
  HUB_SEARCH_OPTIONS,
  type HubSearchDoc,
  type HubSearchStored,
} from '../../../devTools/hub/searchProtocol';
import type { HubDataPage, HubNavItem } from '../../../devTools/hub/types';

/**
 * The Hub's search dialog (p552 §2.4): a chunk `hub.ts` imports on first use (the first focus of
 * the search button, ⌘K / Ctrl+K or `/`), which then loads the index (`hub-search.js`, its URL in
 * `hub-data.js`). Both are cached by the browser from then on: the chunk's name has its hash, and
 * the index's URL its `?v=`.
 *
 * Results are grouped by top-level section (Examples, Features, …) in the order of each group's
 * best result, each with its breadcrumb (pages, then the headings above it) and a snippet with
 * the match marked. An API module, symbol or member (p553) shows its kind and name instead of a
 * heading; its pages aren't in `hub-data.js`'s `pages`, so its breadcrumb comes from its path. The input is a combobox over the results' listbox: the arrow keys move,
 * Enter opens, Escape closes (the native `<dialog>`).
 */

type HubSearchData = { nav: HubNavItem[]; pages: HubDataPage[]; searchIndex: string };

declare global {
  interface Window {
    /** `hub-data.js` */
    AEK_HUB?: HubSearchData;
  }
}

type HubSearchResult = SearchResult & HubSearchStored;

/** The last query, kept for the session (p552 §2.4) */
const QUERY_STORAGE_KEY = 'aekHubSearch';
const MAX_RESULTS = 50;
const MAX_SUGGESTIONS = 3;
/** The snippet: this much text before the first match, and this long in all */
const SNIPPET_BEFORE = 40;
const SNIPPET_LENGTH = 180;

const readStoredQuery = () => {
  try {
    return sessionStorage.getItem(QUERY_STORAGE_KEY) ?? '';
  } catch {
    return ''; // Storage off (a private window)
  }
};

const storeQuery = (query: string) => {
  try {
    sessionStorage.setItem(QUERY_STORAGE_KEY, query);
  } catch {
    // Storage off: the query lasts while the page is open
  }
};

// --- The index and the page data ---

let indexPromise: Promise<MiniSearch<HubSearchDoc>> | null = null;

/** Loads the index once; a failed load is tried again on the next open */
const loadIndex = (hubJsUrl: string) =>
  (indexPromise ??= (async () => {
    const data = window.AEK_HUB;
    if (!data) throw new Error('hub-data.js has not loaded');
    const url = new URL(data.searchIndex, hubJsUrl).href;
    const module = (await import(/* @vite-ignore */ url)) as { default: object };
    return MiniSearch.loadJS<HubSearchDoc>(
      module.default as Parameters<typeof MiniSearch.loadJS>[0],
      HUB_SEARCH_OPTIONS
    );
  })().catch((err: unknown) => {
    indexPromise = null;
    throw err;
  }));

type PageInfo = { page: HubDataPage; label: string };

let pageInfos: Map<string, PageInfo> | null = null;
let menuLabels: Map<string, string> | null = null;

/** Every menu entry's label by path */
const getMenuLabels = () => {
  if (menuLabels) return menuLabels;
  const labels = new Map<string, string>();
  const walk = (items: HubNavItem[]) => {
    for (const item of items) {
      labels.set(item.path, item.title);
      walk(item.children);
    }
  };
  walk(window.AEK_HUB?.nav ?? []);
  return (menuLabels = labels);
};

/** Every page by path, labelled by its menu entry where it has one (else its title) */
const getPageInfos = () => {
  if (pageInfos) return pageInfos;
  const data = window.AEK_HUB;
  const menuLabels = getMenuLabels();
  pageInfos = new Map(
    (data?.pages ?? []).map((page) => [
      page.path,
      { page, label: menuLabels.get(page.path) ?? page.title },
    ])
  );
  return pageInfos;
};

/** `documentation/code-blocks/` → `documentation/`, `documentation/code-blocks/` */
const pagePathTrail = (pagePath: string) => {
  const parts = pagePath.split('/').filter(Boolean);
  return parts.map((_part, i) => `${parts.slice(0, i + 1).join('/')}/`);
};

/**
 * A page's breadcrumb label: its menu entry or title, else its folder's name (an API module's
 * page: `documentation/engine/core/SceneLoader/` → `SceneLoader`)
 */
const pathLabel = (pagePath: string) => {
  const parts = pagePath.split('/').filter(Boolean);
  return (
    getPageInfos().get(pagePath)?.label ??
    getMenuLabels().get(pagePath) ??
    parts[parts.length - 1] ??
    pagePath
  );
};

/** The top-level section's path: the group a result goes in */
const sectionOf = (pagePath: string) =>
  getPageInfos().get(pagePath)?.page.section ?? pagePathTrail(pagePath)[0] ?? '';

/** The headings above the result's heading on its page, outermost first */
const parentHeadings = (page: HubDataPage, anchor: string) => {
  const at = page.headings.findIndex((heading) => heading.id === anchor);
  if (at < 0) return [];
  const parents: string[] = [];
  let level = page.headings[at].level;
  for (let i = at - 1; i >= 0 && level > 2; i--) {
    const heading = page.headings[i];
    if (heading.level < level) {
      parents.unshift(heading.text);
      level = heading.level;
    }
  }
  return parents;
};

// --- Text ---

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The matched index terms, longest first so `meshes` is marked before `mesh` */
const termsRegExp = (terms: string[]) => {
  const usable = [...new Set(terms)].filter((term) => term.length > 1);
  if (!usable.length) return null;
  usable.sort((a, b) => b.length - a.length);
  return new RegExp(usable.map(escapeRegExp).join('|'), 'gi');
};

/** The text with every match of `regex` in a `<mark>` */
const appendMarked = (parent: HTMLElement, text: string, regex: RegExp | null) => {
  if (!regex) {
    parent.append(text);
    return;
  }
  let cursor = 0;
  for (const match of text.matchAll(regex)) {
    parent.append(text.slice(cursor, match.index));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    parent.append(mark);
    cursor = match.index + match[0].length;
  }
  parent.append(text.slice(cursor));
};

/** A window of the text around its first match, cut at word edges */
const snippetOf = (text: string, regex: RegExp | null) => {
  if (text.length <= SNIPPET_LENGTH) return text;
  // -1 without a match in the text (it matched the heading or the code): the text's start
  const first = regex ? text.search(regex) : -1;
  let start = Math.max(0, first - SNIPPET_BEFORE);
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  const lastSpace = text.lastIndexOf(' ', end);
  if (end < text.length && lastSpace > start) end = lastSpace;
  return `${start > 0 ? '… ' : ''}${text.slice(start, end)}${end < text.length ? ' …' : ''}`;
};

// --- The dialog ---

type SearchUi = {
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  results: HTMLElement;
  status: HTMLElement;
};

let ui: SearchUi | null = null;
let hubJsUrl = '';
let options: HTMLAnchorElement[] = [];
let activeIndex = -1;
/** The index once loaded, for synchronous searches while typing */
let index: MiniSearch<HubSearchDoc> | null = null;

const rootUrl = () => new URL('../', hubJsUrl);

const resultHref = (result: HubSearchResult) =>
  new URL(`${result.path}${result.anchor ? `#${result.anchor}` : ''}`, rootUrl()).href;

const setActive = (next: number, shouldScroll = true) => {
  if (!ui) return;
  options[activeIndex]?.setAttribute('aria-selected', 'false');
  activeIndex = options.length ? (next + options.length) % options.length : -1;
  const option = options[activeIndex];
  if (option) {
    option.setAttribute('aria-selected', 'true');
    ui.input.setAttribute('aria-activedescendant', option.id);
    if (shouldScroll) option.scrollIntoView({ block: 'nearest' });
  } else {
    ui.input.removeAttribute('aria-activedescendant');
  }
};

const renderResult = (result: HubSearchResult, info: PageInfo | undefined, n: number) => {
  const regex = termsRegExp(result.terms);
  const option = document.createElement('a');
  option.className = 'hubSearchResult';
  option.id = `hubSearchResult_${n}`;
  option.href = resultHref(result);
  option.setAttribute('role', 'option');
  option.setAttribute('aria-selected', 'false');

  // An API symbol's page is its module, in the breadcrumb; a module's is itself
  const crumbs = [
    // The section is the group's label
    ...pagePathTrail(result.path)
      .slice(1, result.anchor ? undefined : -1)
      .map(pathLabel),
    ...(info && result.anchor && !result.kind ? parentHeadings(info.page, result.anchor) : []),
  ];
  if (crumbs.length) {
    const crumb = document.createElement('span');
    crumb.className = 'hubSearchCrumbs';
    crumb.textContent = crumbs.join(' › ');
    option.append(crumb);
  }
  const title = document.createElement('span');
  title.className = 'hubSearchTitle';
  if (result.kind) {
    const kind = document.createElement('span');
    // The API pages' kind badge and colours (`_api.scss`)
    kind.className = `hubSearchKind hubApiKind hubApiKind_${result.kind.replace(/\W/g, '')}`;
    kind.textContent = result.kind;
    const name = document.createElement('code');
    appendMarked(name, apiSearchName(result), regex);
    title.append(kind, name);
  } else {
    const text = result.anchor ? result.heading ?? '' : info?.page.title ?? result.path;
    appendMarked(title, text, regex);
  }
  option.append(title);
  const snippetText = result.text || result.summary;
  if (snippetText) {
    const snippet = document.createElement('span');
    snippet.className = 'hubSearchSnippet';
    appendMarked(snippet, snippetOf(snippetText, regex), regex);
    option.append(snippet);
  }
  return option;
};

/** The closest page titles, for a query without results */
const suggestPages = (query: string) => {
  if (!index) return [];
  return index
    .search(query, { fields: ['title'], fuzzy: 0.4, prefix: true, combineWith: 'OR' })
    .map((result) => getPageInfos().get((result as HubSearchResult).path))
    .filter((info): info is PageInfo => !!info)
    .slice(0, MAX_SUGGESTIONS);
};

const showStatus = (text: string, suggestions: PageInfo[] = []) => {
  if (!ui) return;
  ui.status.textContent = text;
  if (!suggestions.length) return;
  ui.status.append(' Did you mean ');
  suggestions.forEach((info, i) => {
    const link = document.createElement('a');
    link.href = new URL(info.page.path, rootUrl()).href;
    link.textContent = info.page.title;
    ui?.status.append(
      link,
      i < suggestions.length - 2 ? ', ' : i === suggestions.length - 2 ? ' or ' : '?'
    );
  });
};

const runSearch = () => {
  if (!ui) return;
  const query = ui.input.value.trim();
  storeQuery(ui.input.value);
  ui.results.replaceChildren();
  options = [];
  activeIndex = -1;
  ui.input.removeAttribute('aria-activedescendant');
  ui.input.setAttribute('aria-expanded', 'false');
  if (!query) return showStatus('Search the pages, their sections and code.');
  if (!index) return showStatus('Loading the search…');

  const results = index.search(query).slice(0, MAX_RESULTS) as HubSearchResult[];
  if (!results.length) {
    return showStatus(`No results for “${query}”.`, suggestPages(query));
  }

  const pageInfos = getPageInfos();
  const groups = new Map<string, HubSearchResult[]>();
  for (const result of results) {
    const section = sectionOf(result.path);
    groups.set(section, [...(groups.get(section) ?? []), result]);
  }
  let n = 0;
  for (const [section, sectionResults] of groups) {
    const group = document.createElement('div');
    group.className = 'hubSearchGroup';
    group.setAttribute('role', 'group');
    const label = document.createElement('div');
    label.className = 'hubSearchGroupLabel';
    label.id = `hubSearchGroup_${n}`;
    label.setAttribute('role', 'presentation');
    label.textContent = pageInfos.get(section)?.label ?? 'Home';
    group.setAttribute('aria-labelledby', label.id);
    group.append(label);
    for (const result of sectionResults) {
      const option = renderResult(result, pageInfos.get(result.path), n++);
      options.push(option);
      group.append(option);
    }
    ui.results.append(group);
  }
  ui.input.setAttribute('aria-expanded', 'true');
  setActive(0, false);
  ui.results.scrollTop = 0;
  showStatus(
    `${results.length}${results.length === MAX_RESULTS ? '+' : ''} result${results.length === 1 ? '' : 's'}`
  );
};

const createUi = (): SearchUi => {
  const dialog = document.createElement('dialog');
  dialog.className = 'hubSearch';
  dialog.setAttribute('aria-label', 'Search the Hub');
  dialog.innerHTML = `<div class="hubSearchPanel">
  <div class="hubSearchField">
    <input class="hubSearchInput" type="search" placeholder="Search the Hub" autocomplete="off"
      autocapitalize="off" spellcheck="false" enterkeyhint="go" role="combobox"
      aria-label="Search the Hub" aria-autocomplete="list" aria-expanded="false"
      aria-controls="hubSearchResults" />
    <button type="button" class="hubSearchClose" data-hub-search-close>Close</button>
  </div>
  <div class="hubSearchResults" id="hubSearchResults" role="listbox" aria-label="Results"></div>
  <p class="hubSearchStatus" role="status"></p>
  <p class="hubSearchHints" aria-hidden="true">
    <span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>esc</kbd> to close</span>
  </p>
</div>`;
  // The header button's icon, so the dialog has no icons of its own to keep in sync
  const icon = document.querySelector('.hubSearchButton .hubIcon')?.cloneNode(true);
  if (icon) dialog.querySelector('.hubSearchField')?.prepend(icon);
  document.body.append(dialog);

  const input = dialog.querySelector<HTMLInputElement>('.hubSearchInput')!;
  const results = dialog.querySelector<HTMLElement>('.hubSearchResults')!;
  const status = dialog.querySelector<HTMLElement>('.hubSearchStatus')!;

  /**
   * Blurs before it closes: the native close gives the focus back to what had it before, but
   * with nothing focused then, Chrome leaves it on the hidden input (`/` would type into it)
   */
  const close = () => {
    if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    dialog.close();
  };

  input.addEventListener('input', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      options[activeIndex]?.click();
    } else if (e.key === 'Escape') {
      // A search input's first Escape would only clear it: the query is kept for the next open
      e.preventDefault();
      close();
    }
  });
  results.addEventListener('mousemove', (e) => {
    const option = (e.target as Element).closest<HTMLAnchorElement>('.hubSearchResult');
    const at = option ? options.indexOf(option) : -1;
    if (at >= 0 && at !== activeIndex) setActive(at, false);
  });
  // Escape with the focus elsewhere in the dialog (a result)
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dialog.addEventListener('click', (e) => {
    const target = e.target as Element;
    const isPlainClick = !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    // The backdrop is the dialog itself; its panel fills it
    if (target === dialog || target.closest('[data-hub-search-close]')) close();
    // A link on this page only scrolls: the dialog closes for it
    else if (target.closest('a') && isPlainClick) close();
  });
  return { dialog, input, results, status };
};

/** Starts loading the index (the first focus of the search button) */
export const preloadSearch = (url: string) => {
  hubJsUrl = url;
  loadIndex(url)
    .then((loaded) => (index = loaded))
    .catch(() => {
      // Tried again, and reported, when the search opens
    });
};

/** Opens the dialog with the last query of the session */
export const openSearch = (url: string) => {
  hubJsUrl = url;
  ui ??= createUi();
  const { dialog, input } = ui;
  if (!dialog.open) {
    if (!input.value) input.value = readStoredQuery();
    dialog.showModal();
  }
  input.focus();
  input.select();
  runSearch();
  if (index) return;
  loadIndex(url)
    .then((loaded) => {
      index = loaded;
      if (dialog.open) runSearch();
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[Hub] The search index failed to load:', err);
      showStatus('The search could not load. Check the connection and try again.');
    });
};
