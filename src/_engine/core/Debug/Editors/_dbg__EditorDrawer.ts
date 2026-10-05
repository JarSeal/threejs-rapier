/**
 * An editor view's right drawer (docs/plans/p084_material-editor-stage-and-selector.md DD6),
 * written for every editor: it looks like the scene debug drawer (same widths, toggler, heading
 * row with a title and a close button, tab menu, scrolling tab container) and mounts ordinary
 * debugger tab definitions ({@link AnyDebuggerTabDef}) through a tab host of its own, so panes,
 * lists, clear-LS buttons, `onRefresh` / `onOpen` / `refreshIntervalMs` and folder persistence
 * work as in the scene drawer.
 *
 * An instance, not a singleton: each editor creates its own. It is only UI: the editor keeps its
 * state (`initialState`, `onStateChange`), and tells it when its view is entered or left
 * (`setActive`). While active and open, it sets the `debugDrawerOpen` body class, so the top
 * on-screen row, the viewport stack and the editor's own UI shift with it.
 */
import { CMP, type TCMP } from '../../../utils/CMP';
import { type AnyDebuggerTabDef } from '../../../debug/DebuggerGUI';
import { getSvgIcon } from '../../UI/icons/SvgIcon';
import { createTabHost } from '../_dbg__TabHost';
import debuggerStyles from '../DebuggerGUI.module.scss';
import styles from './EditorDrawer.module.scss';

/** Set on <body> while a right-side debug drawer is open (_dbg__DebuggerGUI.ts). */
const DRAWER_OPEN_BODY_CLASS = 'debugDrawerOpen';

/** The drawer's UI state (persisted by the editor). */
export type EditorDrawerState = {
  isOpen: boolean;
  /** Empty = the first tab. */
  currentTabId: string;
  /** Each tab's scroll position, by tab id. */
  scrollPos: Record<string, number>;
};

export type EditorDrawerOpts = {
  /** Unique among the drawers (the CMP ids are prefixed with it). */
  id: string;
  /** The parent element (the editor's HUD, which must have KEEP_IN_VIEWS_CLASS). */
  parent: HTMLElement;
  /** The toggler button's text (eg. 'Material'). */
  togglerText: string;
  /** The small label above the title (eg. 'MATERIAL'). */
  headingLabel: string;
  /** The title (eg. the material's name), re-read on every refresh and rebuild. */
  getTitle: () => string;
  /** The tabs, in menu order. Called again on every rebuild (an editor's tabs can be per
   * subject, eg. per material). */
  getTabs: () => AnyDebuggerTabDef[];
  initialState?: Partial<EditorDrawerState>;
  /** After any state change (open, tab, scroll). */
  onStateChange?: (state: EditorDrawerState) => void;
};

export type EditorDrawer = {
  cmp: TCMP;
  /** Opens or closes the drawer (no argument toggles it). */
  toggle: (open?: boolean) => void;
  isOpen: () => boolean;
  /** Its view was entered (true) or left (false): only an active drawer drives the
   * `debugDrawerOpen` body class and refreshes its tab. */
  setActive: (active: boolean) => void;
  /** Re-reads the tabs (`getTabs`) and the title, and mounts the current tab again (its scroll
   * position is kept). */
  rebuild: () => void;
  /** Refreshes the title and the mounted tab. */
  refresh: () => void;
  getState: () => EditorDrawerState;
  dispose: () => void;
};

/**
 * Creates an editor view's right drawer in `opts.parent` (see the file comment).
 * @param opts ({@link EditorDrawerOpts})
 * @returns ({@link EditorDrawer})
 */
export const createEditorDrawer = (opts: EditorDrawerOpts): EditorDrawer => {
  const { id } = opts;
  const state: EditorDrawerState = {
    isOpen: opts.initialState?.isOpen ?? false,
    currentTabId: opts.initialState?.currentTabId ?? '',
    scrollPos: { ...opts.initialState?.scrollPos },
  };
  const notify = () => opts.onStateChange?.({ ...state, scrollPos: { ...state.scrollPos } });

  let isActive = false;
  let tabs: AnyDebuggerTabDef[] = [];
  const menuButtons = new Map<string, TCMP>();

  const root = CMP({
    id: `${id}-editorDrawer`,
    class: [
      debuggerStyles.debuggerGUI,
      styles.editorDrawer,
      state.isOpen ? debuggerStyles.debuggerGUI_open : debuggerStyles.debuggerGUI_closed,
    ],
  });

  // The global classes let other debug SCSS find it (eg. aekOnScreenToolsDisabled)
  root.add({
    tag: 'button',
    text: opts.togglerText,
    class: [debuggerStyles.debugDrawerToggler, 'debugDrawerToggler', 'MIDDLE'],
    onClick: () => toggle(),
  });

  const titleRow = root.add({ class: debuggerStyles.debugCurrentSceneTitle });
  titleRow.add({
    tag: 'span',
    text: opts.headingLabel,
    class: debuggerStyles.debugCurrentSceneTitleHeading,
  });
  const titleText = titleRow.add({
    tag: 'span',
    text: opts.getTitle(),
    class: [debuggerStyles.debugCurrentSceneTitleText, styles.title],
  });
  titleRow.add({
    tag: 'button',
    class: debuggerStyles.closeBtn,
    attr: { title: 'Close' },
    onClick: () => toggle(false),
  });

  const menu = root.add({ class: [debuggerStyles.debugDrawerTabsMenu, styles.tabsMenu] });
  const tabsContainer = root.add({
    class: [debuggerStyles.debugDrawerTabsContainer, styles.tabsContainer],
  });

  const isVisible = () => isActive && state.isOpen;

  const host = createTabHost({
    getContainer: () => tabsContainer,
    isVisible,
    onMount: (def) => {
      for (const [tabId, button] of menuButtons) {
        button.updateClass(
          debuggerStyles.debugDrawerTabButton_selected,
          tabId === def.id ? 'add' : 'remove'
        );
      }
    },
    label: `Editor drawer "${id}" tab`,
  });

  /** The saved tab, or the first one. */
  const getCurrentTab = () => tabs.find((tab) => tab.id === state.currentTabId) || tabs[0];

  /** A display: none ancestor (the editor's HUD outside its view, the closed drawer is only
   * moved) loses the scroll position. */
  const restoreScroll = () => {
    const tabId = host.mountedId;
    tabsContainer.elem.scrollTop = tabId ? state.scrollPos[tabId] || 0 : 0;
  };

  const mountTab = (def: AnyDebuggerTabDef) => {
    host.mount(def);
    restoreScroll();
  };

  const selectTab = (def: AnyDebuggerTabDef) => {
    if (host.mountedId === def.id) return;
    state.currentTabId = def.id;
    mountTab(def);
    notify();
  };

  const buildMenu = () => {
    for (const button of menuButtons.values()) button.remove();
    menuButtons.clear();
    for (const def of tabs) {
      const icon = getSvgIcon(def.icon);
      const button = CMP({
        class: debuggerStyles.debugDrawerTabButton,
        html: () => `<button>${icon}</button>`,
        attr: { title: def.title },
        onClick: () => selectTab(def),
      });
      menuButtons.set(def.id, button);
      menu.add(button);
    }
  };

  const rebuild = () => {
    titleText.updateText(opts.getTitle());
    tabs = opts.getTabs();
    buildMenu();
    const def = getCurrentTab();
    if (def) mountTab(def);
    else {
      host.unmount();
      tabsContainer.removeChildren();
    }
  };

  const refresh = () => {
    titleText.updateText(opts.getTitle());
    host.refresh();
  };

  const applyBodyClass = () => {
    if (!isActive) return;
    document.body.classList.toggle(DRAWER_OPEN_BODY_CLASS, state.isOpen);
  };

  const toggle = (open?: boolean) => {
    const nextOpen = open ?? !state.isOpen;
    if (nextOpen === state.isOpen) return;
    state.isOpen = nextOpen;
    root.updateClass(debuggerStyles.debuggerGUI_open, nextOpen ? 'add' : 'remove');
    root.updateClass(debuggerStyles.debuggerGUI_closed, nextOpen ? 'remove' : 'add');
    applyBodyClass();
    // The tab was not refreshed while closed
    if (isVisible()) host.resume();
    else host.pause();
    notify();
  };

  const setActive = (active: boolean) => {
    if (isActive === active) return;
    isActive = active;
    if (!active) {
      host.pause();
      // The view that is entered next (or the scene drawer) sets it again
      document.body.classList.remove(DRAWER_OPEN_BODY_CLASS);
      return;
    }
    applyBodyClass();
    restoreScroll();
    if (state.isOpen) host.resume();
  };

  tabsContainer.update({
    listeners: [
      {
        type: 'scroll',
        fn: () => {
          // Not while hidden: a display: none ancestor resets it
          const tabId = host.mountedId;
          if (!tabId || !isVisible()) return;
          state.scrollPos[tabId] = tabsContainer.elem.scrollTop;
          notify();
        },
      },
    ],
  });

  opts.parent.append(root.elem);
  rebuild();

  return {
    cmp: root,
    toggle,
    isOpen: () => state.isOpen,
    setActive,
    rebuild,
    refresh,
    getState: () => ({ ...state, scrollPos: { ...state.scrollPos } }),
    dispose: () => {
      setActive(false);
      host.unmount();
      root.remove();
    },
  };
};
