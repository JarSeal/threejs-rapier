/**
 * The Hub's page script, loaded on every page (p551). The menu is in the page already (rendered
 * at build time), so this only adds behaviour on top of it: the theme toggle, the mobile menu,
 * the nav's dropdowns, the code blocks' copy, collapse and tabs, and opening the search.
 */

document.documentElement.classList.add('hubJs');

// --- Theme ---

type HubTheme = 'light' | 'dark';

/** Also read by the shell's inline script, before the first paint */
const THEME_STORAGE_KEY = 'aekHubTheme';
const lightQuery = window.matchMedia('(prefers-color-scheme: light)');

const getTheme = (): HubTheme => {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light' || theme === 'dark') return theme;
  return lightQuery.matches ? 'light' : 'dark';
};

const themeToggle = document.querySelector<HTMLButtonElement>('[data-hub-theme-toggle]');
const themeLabel = themeToggle?.querySelector<HTMLElement>('[data-hub-theme-label]');

const updateThemeToggle = () => {
  if (themeLabel) {
    themeLabel.textContent =
      getTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }
};

themeToggle?.addEventListener('click', () => {
  const theme: HubTheme = getTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage off (a private window): the choice lasts for this page
  }
  updateThemeToggle();
});
lightQuery.addEventListener('change', updateThemeToggle);
updateThemeToggle();

// --- Mobile menu ---

/** `$nav-collapse` in `_tokens.scss` */
const desktopQuery = window.matchMedia('(min-width: 960px)');
const header = document.querySelector<HTMLElement>('.hubHeader');
const menuButton = document.querySelector<HTMLButtonElement>('.hubMenuButton');

const setMenuOpen = (isOpen: boolean) => {
  header?.classList.toggle('hubNavOpen', isOpen);
  menuButton?.setAttribute('aria-expanded', String(isOpen));
  menuButton?.setAttribute('aria-label', isOpen ? 'Close the menu' : 'Menu');
};

menuButton?.addEventListener('click', () => {
  setMenuOpen(menuButton.getAttribute('aria-expanded') !== 'true');
});
desktopQuery.addEventListener('change', () => setMenuOpen(false));

// --- Nav dropdowns ---

const dropdownItems = [...document.querySelectorAll<HTMLElement>('.hubNavItem_hasMenu')];

const setDropdownOpen = (item: HTMLElement, isOpen: boolean) => {
  item.classList.toggle('hubNavItem_open', isOpen);
  item.querySelector('.hubNavToggle')?.setAttribute('aria-expanded', String(isOpen));
};

for (const item of dropdownItems) {
  const toggle = item.querySelector<HTMLButtonElement>('.hubNavToggle');
  toggle?.addEventListener('click', () => {
    const isOpen = !item.classList.contains('hubNavItem_open');
    for (const other of dropdownItems) setDropdownOpen(other, other === item && isOpen);
  });
  // Tabbing out of the item, or clicking elsewhere, closes it
  item.addEventListener('focusout', (e) => {
    if (!item.contains(e.relatedTarget as Node | null)) setDropdownOpen(item, false);
  });
}

document.addEventListener('click', (e) => {
  for (const item of dropdownItems) {
    if (!item.contains(e.target as Node)) setDropdownOpen(item, false);
  }
});

document.addEventListener('keydown', (e) => {
  // The search dialog closes itself
  if (e.key !== 'Escape' || (e.target as Element).closest?.('dialog')) return;
  const openItem = dropdownItems.find((item) => item.classList.contains('hubNavItem_open'));
  if (openItem) {
    setDropdownOpen(openItem, false);
    openItem.querySelector<HTMLElement>('.hubNavToggle')?.focus();
  } else if (header?.classList.contains('hubNavOpen')) {
    setMenuOpen(false);
    menuButton?.focus();
  }
});

// --- Code blocks (p552) ---

/** How long the copy button says "Copied" */
const COPIED_MS = 1500;
const copiedTimers = new WeakMap<HTMLElement, number>();

/**
 * The block's source as written: line numbers and diff markers are CSS, the notation comments
 * were removed at build time, and `[!code --]` lines are dropped here
 */
const getCleanSource = (block: HTMLElement) =>
  [...block.querySelectorAll('pre .line')]
    .filter((line) => !line.classList.contains('remove'))
    .map((line) => line.textContent ?? '')
    .join('\n');

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard API outside a secure context (a LAN address over http): the old way
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const isCopied = document.execCommand('copy');
    area.remove();
    return isCopied;
  }
};

const copyCode = async (button: HTMLElement) => {
  const block = button.closest<HTMLElement>('.hubCode');
  if (!block || !(await copyText(getCleanSource(block)))) return;
  const label = button.querySelector('.hubCodeCopyLabel');
  button.dataset.copied = '';
  if (label) label.textContent = 'Copied';
  clearTimeout(copiedTimers.get(button));
  copiedTimers.set(
    button,
    window.setTimeout(() => {
      delete button.dataset.copied;
      if (label) label.textContent = 'Copy';
    }, COPIED_MS)
  );
};

const toggleExpanded = (button: HTMLElement) => {
  const block = button.closest<HTMLElement>('.hubCode');
  if (!block) return;
  const isExpanded = block.classList.toggle('hubCode_expanded');
  button.setAttribute('aria-expanded', String(isExpanded));
  button.textContent = (isExpanded ? button.dataset.labelLess : button.dataset.labelMore) ?? '';
  // Folding a long block back can leave the reader far below it
  if (!isExpanded && block.getBoundingClientRect().top < 0) {
    block.scrollIntoView({ block: 'start' });
  }
};

const selectCodeTab = (tab: HTMLElement) => {
  const tabs = tab.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]');
  for (const other of tabs ?? []) {
    const isSelected = other === tab;
    other.setAttribute('aria-selected', String(isSelected));
    other.tabIndex = isSelected ? 0 : -1;
    const panel = document.getElementById(other.getAttribute('aria-controls') ?? '');
    panel?.classList.toggle('hubCode_inactive', !isSelected);
  }
};

document.addEventListener('click', (e) => {
  const target = e.target as Element;
  const copy = target.closest<HTMLElement>('[data-hub-code-copy]');
  if (copy) return void copyCode(copy);
  const expand = target.closest<HTMLElement>('[data-hub-code-expand]');
  if (expand) return toggleExpanded(expand);
  const tab = target.closest<HTMLElement>('.hubCodeTab');
  if (tab) selectCodeTab(tab);
});

// The tab list's arrow keys (WAI-ARIA tabs: the selection follows the focus)
document.addEventListener('keydown', (e) => {
  const tab = (e.target as Element).closest?.<HTMLElement>('.hubCodeTab');
  if (!tab) return;
  const tabs = [...(tab.parentElement?.querySelectorAll<HTMLElement>('.hubCodeTab') ?? [])];
  const index = tabs.indexOf(tab);
  const next = {
    ArrowRight: tabs[(index + 1) % tabs.length],
    ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
    Home: tabs[0],
    End: tabs[tabs.length - 1],
  }[e.key];
  if (!next) return;
  e.preventDefault();
  selectCodeTab(next);
  next.focus();
});

// --- Search (p552) ---

/**
 * The dialog and the index load on first use (`_search.ts`, a chunk of its own): the first focus
 * or hover of the search button preloads them, a click, ⌘K / Ctrl+K or `/` opens the dialog
 */
const searchButton = document.querySelector<HTMLButtonElement>('[data-hub-search]');
const searchKey = document.querySelector<HTMLElement>('[data-hub-search-key]');
if (searchKey && !/Mac|iPhone|iPad/.test(navigator.userAgent)) searchKey.textContent = 'Ctrl K';

/** `_assets/hub.js`: the index's URL in `hub-data.js` and the site root resolve against it */
const hubJsUrl = import.meta.url;
let searchModule: Promise<typeof import('./_search')> | null = null;

const loadSearch = () =>
  (searchModule ??= import('./_search').catch((err: unknown) => {
    searchModule = null; // Tried again on the next use
    throw err;
  }));

const openSearch = () => {
  setMenuOpen(false);
  loadSearch()
    .then((search) => search.openSearch(hubJsUrl))
    // eslint-disable-next-line no-console
    .catch((err: unknown) => console.error('[Hub] The search failed to load:', err));
};

const preloadSearch = () => {
  loadSearch()
    .then((search) => search.preloadSearch(hubJsUrl))
    .catch(() => {
      // Reported when the search opens
    });
};

searchButton?.addEventListener('click', openSearch);
searchButton?.addEventListener('focus', preloadSearch, { once: true });
searchButton?.addEventListener('pointerenter', preloadSearch, { once: true });

/** A field the reader types in; the search's own input once its dialog is closed isn't one */
const isEditable = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') &&
  !target.closest('dialog:not([open])');

document.addEventListener('keydown', (e) => {
  const isModK =
    (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
  const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable(e.target);
  if (!isModK && !isSlash) return;
  e.preventDefault();
  openSearch();
});
