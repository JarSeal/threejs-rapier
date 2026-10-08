/**
 * The Hub's page script, loaded on every page (p551). The menu is in the page already (rendered
 * at build time), so this only adds behaviour on top of it: the theme toggle, the mobile menu,
 * the nav's dropdowns and the search key hint.
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
  if (e.key !== 'Escape') return;
  const openItem = dropdownItems.find((item) => item.classList.contains('hubNavItem_open'));
  if (openItem) {
    setDropdownOpen(openItem, false);
    openItem.querySelector<HTMLElement>('.hubNavToggle')?.focus();
  } else if (header?.classList.contains('hubNavOpen')) {
    setMenuOpen(false);
    menuButton?.focus();
  }
});

// --- Search ---

// p552 opens the search dialog; the hint shows the platform's shortcut
const searchKey = document.querySelector<HTMLElement>('[data-hub-search-key]');
if (searchKey && !/Mac|iPhone|iPad/.test(navigator.userAgent)) searchKey.textContent = 'Ctrl K';
