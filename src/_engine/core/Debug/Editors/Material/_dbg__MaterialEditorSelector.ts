/**
 * The material editor's selector (docs/plans/_DONE_p084_material-editor-stage-and-selector.md
 * DD5): the bottom drawer with every project material as a card, a filter by id and name, and a collapse
 * button. It is only UI: the editor hands it the entries and its callbacks, and calls `refresh`
 * when the selected, loading or failed material changes.
 */
import styles from './MaterialEditor.module.scss';

/** A project material as the selector shows it. */
export type MaterialSelectorEntry = {
  id: string;
  /** `debugData.name`, else the id. */
  name: string;
  /** The material type (eg. 'STANDARDNODEMATERIAL'). */
  type: string;
  /** Has a TSL file. */
  isTsl: boolean;
  sourcePath?: string;
  description?: string;
  /** A CSS colour for the preview slot's swatch (the material's first colour), or null. */
  swatch: string | null;
  /** Why it can't be loaded (eg. no TSL graph in a production-gathered build); listed disabled. */
  unavailableReason?: string;
};

/** The selector's UI state (persisted by the editor). */
export type MaterialSelectorState = { isOpen: boolean; filterText: string; scrollTop: number };

export type MaterialSelectorOpts = {
  /** The parent element (the editor's HUD). */
  parent: HTMLElement;
  entries: MaterialSelectorEntry[];
  initialState?: Partial<MaterialSelectorState>;
  /** A card click (not for unavailable materials). */
  onSelect: (id: string) => void;
  getSelectedId: () => string | null;
  /** The material whose load is in progress, if any. */
  getLoadingId: () => string | null;
  /** Why a material failed to load, if it did. */
  getFailure: (id: string) => string | undefined;
  /** After any state change (open, filter, scroll). */
  onStateChange?: (state: MaterialSelectorState) => void;
};

export type MaterialSelector = {
  elem: HTMLElement;
  /** Re-reads the selected, loading and failed materials into the cards. */
  refresh: () => void;
  setOpen: (isOpen: boolean) => void;
  getState: () => MaterialSelectorState;
  /** Puts the saved scroll position back: a hidden element (display: none, eg. the editor's HUD
   * outside its view) loses it. */
  restoreScroll: () => void;
  dispose: () => void;
};

/** What a filter matcher reads: the filter input's state. */
type MaterialFilter = { text: string };
type Card = { entry: MaterialSelectorEntry; elem: HTMLButtonElement; searchText: string };
/** Every matcher must accept a card for it to be shown. A later criterion (type, source folder,
 * tags) is one more matcher. */
type MaterialMatcher = (card: Card, filter: MaterialFilter) => boolean;

const MATCHERS: MaterialMatcher[] = [
  (card, filter) => !filter.text || card.searchText.includes(filter.text),
];

const createElem = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
) => {
  const elem = document.createElement(tag);
  if (className) elem.className = className;
  if (text !== undefined) elem.textContent = text;
  return elem;
};

/** The type without its NodeMaterial suffix, eg. 'STANDARD' for 'STANDARDNODEMATERIAL'. */
const getBaseType = (type: string) => type.replace(/NODEMATERIAL$/, '');

const getCardTitle = (entry: MaterialSelectorEntry, failure?: string) =>
  [
    entry.unavailableReason ? `Unavailable: ${entry.unavailableReason}` : '',
    failure ? `Failed to load: ${failure}` : '',
    entry.sourcePath ?? '',
    entry.description ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');

const createCard = (entry: MaterialSelectorEntry) => {
  const elem = createElem('button', styles.card);
  elem.type = 'button';
  elem.dataset.id = entry.id;
  if (entry.unavailableReason) {
    elem.classList.add('unavailable');
    elem.setAttribute('aria-disabled', 'true');
  }

  // Reserved for the preview thumbnails (later): a swatch of the first colour, or the initials
  const slot = createElem('span', `${styles.previewSlot} matEditorPreviewSlot`);
  if (entry.swatch) slot.style.background = entry.swatch;
  else slot.textContent = getBaseType(entry.type).slice(0, 2);

  const info = createElem('span', styles.cardInfo);
  info.append(
    createElem('span', styles.cardName, entry.name),
    createElem('span', styles.cardId, entry.id)
  );
  const badges = createElem('span', styles.cardBadges);
  badges.append(createElem('span', styles.badge, getBaseType(entry.type)));
  if (entry.isTsl) badges.append(createElem('span', styles.badge, 'TSL'));
  info.append(badges);

  elem.append(slot, info);
  elem.title = getCardTitle(entry);
  return elem;
};

const byNameThenId = (a: MaterialSelectorEntry, b: MaterialSelectorEntry) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Creates the material selector (the editor's bottom drawer) in `opts.parent`.
 * @param opts ({@link MaterialSelectorOpts})
 * @returns ({@link MaterialSelector})
 */
export const createMaterialSelector = (opts: MaterialSelectorOpts): MaterialSelector => {
  const state: MaterialSelectorState = {
    isOpen: opts.initialState?.isOpen ?? true,
    filterText: opts.initialState?.filterText ?? '',
    scrollTop: opts.initialState?.scrollTop ?? 0,
  };
  const notify = () => opts.onStateChange?.({ ...state });

  const root = createElem('div', `${styles.selector} matEditorSelector`);

  // Header row (always visible): title, count, filter, collapse
  const header = createElem('div', styles.selectorHeader);
  const heading = createElem('h3', styles.selectorTitle, 'Materials');
  const count = createElem('span', styles.selectorCount);
  const filterInput = createElem('input', styles.filterInput);
  filterInput.type = 'text';
  filterInput.placeholder = 'Filter by id or name';
  filterInput.autocomplete = 'off';
  filterInput.spellcheck = false;
  filterInput.value = state.filterText;
  filterInput.setAttribute('aria-label', 'Filter materials by id or name');
  const collapseButton = createElem('button', styles.collapseButton);
  collapseButton.type = 'button';
  header.append(heading, count, filterInput, collapseButton);

  const body = createElem('div', styles.selectorBody);
  const grid = createElem('div', styles.grid);
  const emptyNotice = createElem('p', styles.emptyNotice);
  body.append(grid, emptyNotice);
  root.append(header, body);

  const cards: Card[] = opts.entries
    .slice()
    .sort(byNameThenId)
    .map((entry) => ({
      entry,
      elem: createCard(entry),
      searchText: `${entry.id}\n${entry.name}`.toLowerCase(),
    }));
  const cardsById = new Map(cards.map((card) => [card.entry.id, card]));
  for (const card of cards) grid.append(card.elem);

  const applyFilter = () => {
    const filter: MaterialFilter = { text: state.filterText.trim().toLowerCase() };
    let shown = 0;
    for (const card of cards) {
      const isShown = MATCHERS.every((matcher) => matcher(card, filter));
      card.elem.classList.toggle(styles.card_filteredOut, !isShown);
      if (isShown) shown++;
    }
    count.textContent = `${shown} / ${cards.length}`;
    emptyNotice.textContent = !cards.length
      ? 'No project materials (*.material.json) found.'
      : !shown
        ? 'No material matches the filter.'
        : '';
  };

  const applyOpen = () => {
    root.classList.toggle(styles.selector_collapsed, !state.isOpen);
    collapseButton.title = state.isOpen ? 'Collapse the materials' : 'Expand the materials';
    collapseButton.setAttribute('aria-expanded', String(state.isOpen));
  };

  const refresh = () => {
    const selectedId = opts.getSelectedId();
    const loadingId = opts.getLoadingId();
    for (const card of cards) {
      const { id } = card.entry;
      const failure = opts.getFailure(id);
      card.elem.classList.toggle('selected', id === selectedId);
      card.elem.classList.toggle('loading', id === loadingId);
      card.elem.classList.toggle('failed', Boolean(failure));
      card.elem.title = getCardTitle(card.entry, failure);
    }
  };

  const restoreScroll = () => {
    body.scrollTop = state.scrollTop;
  };

  const setOpen = (isOpen: boolean) => {
    if (state.isOpen === isOpen) return;
    state.isOpen = isOpen;
    applyOpen();
    // The collapsed body is hidden, which loses its scroll position
    if (isOpen) restoreScroll();
    notify();
  };

  const setFilterText = (text: string) => {
    if (state.filterText === text) return;
    state.filterText = text;
    applyFilter();
    notify();
  };

  grid.addEventListener('click', (e) => {
    const cardElem = (e.target as HTMLElement).closest<HTMLButtonElement>(`.${styles.card}`);
    const id = cardElem?.dataset.id;
    const card = id ? cardsById.get(id) : undefined;
    if (!card || card.entry.unavailableReason) return;
    opts.onSelect(card.entry.id);
  });
  filterInput.addEventListener('input', () => setFilterText(filterInput.value));
  filterInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // A first Escape clears the filter, a second one hands the keys back
    if (filterInput.value) {
      filterInput.value = '';
      setFilterText('');
    } else {
      filterInput.blur();
    }
    e.stopPropagation();
  });
  collapseButton.addEventListener('click', () => setOpen(!state.isOpen));
  body.addEventListener('scroll', () => {
    if (!state.isOpen) return;
    state.scrollTop = body.scrollTop;
    notify();
  });

  applyFilter();
  applyOpen();
  refresh();
  opts.parent.append(root);
  // After the cards are in the DOM, so there is something to scroll
  restoreScroll();

  return {
    elem: root,
    refresh,
    setOpen,
    getState: () => ({ ...state }),
    restoreScroll,
    dispose: () => root.remove(),
  };
};
