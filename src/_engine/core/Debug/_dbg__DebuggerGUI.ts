import { CMP, TCMP } from '../../utils/CMP';
import styles from './DebuggerGUI.module.scss';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { getWindowSize } from '../../utils/Window';
import { getHUDRootCMP } from '../../core/HUD';
import { DEFAULT_DEBUG_DRAWER_TAB_ORDER, getConfig, isDebugEnvironment } from '../../core/Config';
import { lwarn } from '../../utils/Logger';
import {
  type DebugGUIOpts,
  type AnyDebuggerTabDef,
  type UpdateDebuggerTabOpts,
} from '../../debug/DebuggerGUI';
import { createDebuggerSceneLoader } from './_dbg__DebuggerSceneLoader';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { persistDebuggerTabStateValue } from './_dbg__DebuggerPaneBuilder';
import { createTabHost } from './_dbg__TabHost';
import { doesSceneExist, getCurrentSceneId, registerOnAllSceneExits } from '../Scene';

export { _debuggerListCMP } from './_dbg__DebuggerList';

let drawerCMP: TCMP | null = null;
let currentSceneTitleCMP: TCMP | null = null;
let currentSceneTitleText: string = '';
let tabsContainerWrapper: null | TCMP = null;
let debugSceneLoaderCreated = false;
let debuggerDisabled = false;
/** An editor view is active (see _setDrawerSuspendedByView). */
let isSuspendedByView = false;
/** Set while a right-side debug drawer is open: this one in the Runtime view, an editor's own one
 * in an editor view (ViewManager.ts). The top on-screen row and the viewport stack shift by it. */
const DRAWER_OPEN_BODY_CLASS = 'debugDrawerOpen';
const LS_KEY = 'AEK_debugDrawerState';
const SCENE_EXIT_HOOK_ID = 'debuggerSceneTabs';

type DrawerState = {
  isOpen: boolean;
  currentTabId: string;
  currentScrollPos: number;
};

let drawerState: DrawerState = {
  isOpen: false,
  // Empty = the first tab in order
  currentTabId: '',
  currentScrollPos: 0,
};

const saveDrawerState = (newState?: Partial<DrawerState>) => {
  const updatedState = { ...drawerState, ...newState };
  drawerState = updatedState;
  lsSetItem(LS_KEY, JSON.stringify(updatedState));
};

/**
 * Creates the debugger scene loader (idempotent). Called at registration so the loader exists
 * before the first loadScene (which may target it via the debug start scene options).
 */
export const _ensureDebuggerSceneLoader = () => {
  if (debugSceneLoaderCreated) return;
  createDebuggerSceneLoader();
  debugSceneLoaderCreated = true;
};

const initDrawerState = () => {
  _ensureDebuggerSceneLoader();

  // Setup drawerState
  const savedState = lsGetItem(LS_KEY, '{}');
  if (!savedState || typeof savedState !== 'string') return drawerState;
  const parsedSavedState = JSON.parse(savedState);
  drawerState = { ...drawerState, ...parsedSavedState };
  if (drawerState.isOpen && !isSuspendedByView) {
    document.body.classList.add(DRAWER_OPEN_BODY_CLASS);
  }
  return drawerState;
};

type TabEntry = { def: AnyDebuggerTabDef; button: TCMP | null };

// Keyed by tab id. A Map keeps insertion order, so a re-registered (replaced) tab keeps its
// registration position for the ordering tie-break.
const tabs = new Map<string, TabEntry>();

/** The mounted tab's lifecycle (drawerState.currentTabId is only the saved preference, and it can
 * point to a tab that is not registered yet). */
const host = createTabHost({
  getContainer: () => tabsContainerWrapper,
  // Hidden in editor views too (_setDrawerSuspendedByView)
  isVisible: () => Boolean(drawerCMP) && drawerState.isOpen && !isSuspendedByView,
  onMount: (def) => {
    for (const other of tabs.values()) {
      other.button?.updateClass(styles.debugDrawerTabButton_selected, 'remove');
    }
    tabs.get(def.id)?.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');
  },
});

const getTabSortValue = (def: AnyDebuggerTabDef, tabOrder: string[]) => {
  if (def.orderNr !== undefined) return def.orderNr;
  const index = tabOrder.indexOf(def.id);
  return index === -1 ? Infinity : index;
};

/** All tabs in menu order: `orderNr ?? tabOrder index`, ties (and unlisted tabs) in registration
 * order, except that scene tabs come after the other tabs of the same value (unlisted scene tabs
 * go last). */
const getOrderedTabs = () => {
  const tabOrder = getConfig().debugDrawer?.tabOrder || DEFAULT_DEBUG_DRAWER_TAB_ORDER;
  // Array.sort is stable, so equal values keep the Map's registration order
  return [...tabs.values()].sort((a, b) => {
    const aValue = getTabSortValue(a.def, tabOrder);
    const bValue = getTabSortValue(b.def, tabOrder);
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
    return Number(Boolean(a.def.sceneId)) - Number(Boolean(b.def.sceneId));
  });
};

/** Whether the saved open tab is registered (or none is saved). When it isn't, the drawer shows
 * the first tab as a fallback, and the saved id (and scroll position) is kept for the saved tab. */
const isSavedTabShown = () => !drawerState.currentTabId || tabs.has(drawerState.currentTabId);

const createTabMenuButtons = () => {
  for (const entry of tabs.values()) {
    const def = entry.def;
    if (entry.button) entry.button.remove();
    const buttonIcon = getSvgIcon(def.icon);
    const tooltip = def.sceneId ? `${def.title} (scene tab: ${def.sceneId})` : def.title;
    entry.button = CMP({
      id: `debugTabsMenuButton-${def.id}`,
      class: def.sceneId
        ? [styles.debugDrawerTabButton, styles.debugDrawerTabButton_scene]
        : styles.debugDrawerTabButton,
      html: () => `<button>${buttonIcon}</button>`,
      attr: tooltip ? { title: tooltip } : undefined,
      onClick: (_, cmp) => {
        if (cmp.elem.classList.contains(styles.debugDrawerTabButton_selected)) return;
        host.mount(entry.def);
        saveDrawerState({ currentTabId: def.id, currentScrollPos: 0 });
      },
    });
  }
};

let guiOpts: DebugGUIOpts | undefined = undefined;

export const _createDebugGui = (opts?: DebugGUIOpts) => {
  if (!isDebugEnvironment()) return;

  guiOpts = opts;
  initDrawerState();
  createTabMenuButtons();

  // Drawer (the lifecycle cleanup of the mounted tab runs before its CMPs are removed)
  host.unmount();
  if (drawerCMP) drawerCMP.remove();
  drawerCMP = getHUDRootCMP().add({
    id: 'debugDrawer',
    class: [
      styles.debuggerGUI,
      drawerState.isOpen ? styles.debuggerGUI_open : styles.debuggerGUI_closed,
      debuggerDisabled ? styles.debuggerDisabled : '',
    ],
    settings: { replaceRootDom: false },
  });

  // Drawer toggle button
  drawerCMP.add({
    id: 'debugDrawerToggler',
    tag: 'button',
    text: 'Debug',
    // The global class lets other debug SCSS find it (eg. the axes gizmo clears the TOP one)
    class: [styles.debugDrawerToggler, 'debugDrawerToggler', opts?.drawerBtnPlace || 'MIDDLE'],
    onClick: () => _toggleDrawer(),
  });

  // Current scene title
  currentSceneTitleCMP = CMP({
    class: [styles.debugCurrentSceneTitle, 'debugCurrentSceneTitle'],
  });
  currentSceneTitleCMP.add({
    text: 'SCENE',
    tag: 'span',
    class: [styles.debugCurrentSceneTitleHeading, 'debugCurrentSceneTitleHeading'],
  });
  currentSceneTitleCMP.add({
    id: 'debugCurrentSceneTitleText',
    text: currentSceneTitleText,
    tag: 'span',
    class: [styles.debugCurrentSceneTitleText, 'debugCurrentSceneTitleText'],
  });
  currentSceneTitleCMP.add({
    id: 'debugCloseBtn',
    tag: 'button',
    class: styles.closeBtn,
    attr: { title: 'Close' },
    onClick: () => _toggleDrawer('CLOSE'),
  });

  // Tabs container wrapper
  tabsContainerWrapper = CMP({
    id: 'debugDrawerTabsContainerWrapper',
    class: [styles.debugDrawerTabsContainer, 'debugDrawerTabsContainer'],
  });

  // Tabs menu container
  const tabsMenuContainer = CMP({
    id: 'debugDrawerTabsMenu',
    class: styles.debugDrawerTabsMenu,
  });
  const orderedTabs = getOrderedTabs();
  for (let i = 0; i < orderedTabs.length; i++) {
    const button = orderedTabs[i].button;
    if (button) tabsMenuContainer.add(button);
  }

  drawerCMP.add(currentSceneTitleCMP);
  drawerCMP.add(tabsMenuContainer);
  drawerCMP.add(tabsContainerWrapper);
  const getWrapperHeight = () =>
    getWindowSize().height -
    (currentSceneTitleCMP?.elem.offsetHeight || 0) -
    tabsMenuContainer.elem.offsetHeight -
    30; // 30 is padding

  tabsContainerWrapper.update({
    attr: { style: `height: ${getWrapperHeight()}px` },
    listeners: [
      {
        type: 'scroll',
        fn: () => {
          // The fallback tab's scroll position is not the saved tab's
          if (!isSavedTabShown()) return;
          const scrollPos = tabsContainerWrapper?.elem.scrollTop;
          saveDrawerState({ currentScrollPos: scrollPos || 0 });
        },
      },
    ],
  });

  const setWrapperHeightOnResize = () => {
    tabsContainerWrapper?.updateAttr({ style: `height: ${getWrapperHeight()}px` });
  };
  window.removeEventListener('resize', setWrapperHeightOnResize, true);
  window.addEventListener('resize', setWrapperHeightOnResize, true);
  tabsContainerWrapper.update({
    onRemoveCmp: () => {
      window.removeEventListener('resize', setWrapperHeightOnResize, true);
    },
  });

  // Show current tab (the saved one, or the first in order)
  const savedTab = tabs.get(drawerState.currentTabId);
  const entry = savedTab || orderedTabs[0];
  if (!entry) return drawerCMP;

  host.mount(entry.def);
  tabsContainerWrapper.elem.scrollTop = savedTab ? drawerState.currentScrollPos || 0 : 0;

  return drawerCMP;
};

export const _toggleDrawer = (openOrClose?: 'OPEN' | 'CLOSE') => {
  if (!drawerCMP) return;
  let newState: boolean = false;
  if (openOrClose === 'CLOSE') {
    newState = false;
  } else if (openOrClose === 'OPEN') {
    newState = true;
  } else {
    newState = !drawerState.isOpen;
  }
  const wasOpen = drawerState.isOpen;
  saveDrawerState({ isOpen: newState });
  if (drawerState.isOpen) {
    drawerCMP.updateClass(styles.debuggerGUI_open, 'add');
    drawerCMP.updateClass(styles.debuggerGUI_closed, 'remove');
    // Hidden in an editor view: _setDrawerSuspendedByView shows it on the way back
    if (isSuspendedByView) return;
    document.body.classList.add(DRAWER_OPEN_BODY_CLASS);
    // The tab was not refreshed while hidden
    if (!wasOpen) host.resume();
    return;
  }
  host.pause();
  drawerCMP.updateClass(styles.debuggerGUI_open, 'remove');
  drawerCMP.updateClass(styles.debuggerGUI_closed, 'add');
  if (!isSuspendedByView) document.body.classList.remove(DRAWER_OPEN_BODY_CLASS);
};

/**
 * Hides the drawer for an editor view (ViewManager.ts), or shows it again. The open state is kept,
 * but while suspended, its open tab isn't refreshed and the `debugDrawerOpen` body class is left
 * to the editor view (an editor's own right drawer sets it, so the offset rules of the top row and
 * the viewport stack keep working).
 * @param suspended (boolean) whether an editor view is active
 */
export const _setDrawerSuspendedByView = (suspended: boolean) => {
  if (isSuspendedByView === suspended) return;
  isSuspendedByView = suspended;
  if (!drawerState.isOpen) return;
  if (suspended) {
    host.pause();
    document.body.classList.remove(DRAWER_OPEN_BODY_CLASS);
    return;
  }
  document.body.classList.add(DRAWER_OPEN_BODY_CLASS);
  host.resume();
};

export const _createDebuggerTab = (def: AnyDebuggerTabDef, opts?: DebugGUIOpts) => {
  if (def.sceneId && !doesSceneExist(def.sceneId)) {
    lwarn(
      `Debugger tab "${def.id}" has a sceneId "${def.sceneId}" that is not a scene, so it is never removed on a scene exit (in createDebuggerTab)`
    );
  }
  const existing = tabs.get(def.id);
  if (existing) {
    // Replace (keeps the registration position)
    existing.button?.remove();
    existing.button = null;
    existing.def = def;
  } else {
    tabs.set(def.id, { def, button: null });
  }
  createTabMenuButtons();
  if (!drawerCMP) return;
  const options = { ...guiOpts, ...opts };
  _createDebugGui(options);
};

export const _openDebuggerTab = (id: string) => {
  const entry = tabs.get(id);
  if (!entry) {
    lwarn(`Could not find a debugger tab to open with id "${id}" in openDebuggerTab`);
    return;
  }
  saveDrawerState({ currentTabId: id, currentScrollPos: 0 });
  if (tabsContainerWrapper && host.mountedId !== id) {
    host.mount(entry.def);
    tabsContainerWrapper.elem.scrollTop = 0;
  }
  _toggleDrawer('OPEN');
};

/** Removes a tab entry, without rebuilding the drawer. */
const deleteTabEntry = (entry: TabEntry) => {
  if (host.mountedId === entry.def.id) host.unmount();
  entry.button?.remove();
  tabs.delete(entry.def.id);
};

export const _removeDebuggerTab = (id: string) => {
  const entry = tabs.get(id);
  if (!entry) {
    lwarn(`Could not find a debugger tab to remove with id "${id}" in removeDebuggerTab`);
    return;
  }
  deleteTabEntry(entry);
  createTabMenuButtons();
  if (!drawerCMP) return;
  _createDebugGui(guiOpts);
};

/** Removes the scene tabs of the scene being exited (registered on all scene exits), with one
 * drawer rebuild. The saved open tab id is kept, so a re-entry shows the tab again. */
const removeSceneTabs = () => {
  const sceneId = getCurrentSceneId();
  if (!sceneId) return;
  let removed = false;
  for (const entry of [...tabs.values()]) {
    if (entry.def.sceneId !== sceneId) continue;
    deleteTabEntry(entry);
    removed = true;
  }
  if (!removed) return;
  createTabMenuButtons();
  if (!drawerCMP) return;
  _createDebugGui(guiOpts);
};

registerOnAllSceneExits(SCENE_EXIT_HOOK_ID, removeSceneTabs);

export const _persistDebuggerTabValue = (id: string, key: string) => {
  const entry = tabs.get(id);
  if (!entry) {
    lwarn(`Could not find a debugger tab with id "${id}" in persistDebuggerTabValue`);
    return;
  }
  persistDebuggerTabStateValue(entry.def, key);
};

export const _isDebuggerTabOpen = (id: string) =>
  Boolean(drawerCMP) && drawerState.isOpen && host.mountedId === id;

export const _updateDebuggerTab = (id: string, opts?: UpdateDebuggerTabOpts) => {
  if (!_isDebuggerTabOpen(id)) return;
  host.refresh(opts?.rebuild);
};

export const _getDrawerState = () => drawerState;

export const _updateDebuggerSceneTitle = (title: string) => {
  currentSceneTitleText = title;
  _createDebugGui(guiOpts);
};

export const _disableDebugger = (disable: boolean) => {
  if (!isDebugEnvironment()) return;
  debuggerDisabled = disable;
  if (disable) {
    drawerCMP?.updateClass(styles.debuggerDisabled, 'add');
    return;
  }
  drawerCMP?.updateClass(styles.debuggerDisabled, 'remove');

  // @TODO: disable also the on screen tools
};

export const _isDebuggerDisabled = () => debuggerDisabled;
