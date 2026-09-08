import { CMP, TCMP } from '../../utils/CMP';
import styles from './DebuggerGUI.module.scss';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { getWindowSize } from '../../utils/Window';
import { getHUDRootCMP } from '../../core/HUD';
import { Pane } from 'tweakpane';
import { getConfig, isDebugEnvironment } from '../../core/Config';
import { createKeyInputControl } from '../../core/InputControls';
import { lwarn } from '../../utils/Logger';
import { type TabAndContainer, type DebugGUIOpts } from '../../debug/DebuggerGUI';
import { createDebuggerSceneLoader } from './_dbg__DebuggerSceneLoader';

let drawerCMP: TCMP | null = null;
let currentSceneTitleCMP: TCMP | null = null;
let currentSceneTitleText: string = '';
let tabsContainerWrapper: null | TCMP = null;
let debugKeysFromConfigInitiated = false;
let debugSceneLoaderCreated = false;
let debuggerDisabled = false;
const DRAWER_OPEN_BODY_CLASS = 'debugDrawerOpen';
const LS_KEY = 'AEK_debugDrawerState';

type DrawerState = {
  isOpen: boolean;
  currentTabId: string;
  currentScrollPos: number;
};

let drawerState: DrawerState = {
  isOpen: false,
  currentTabId: 'stats',
  currentScrollPos: 0,
};

const saveDrawerState = (newState?: Partial<DrawerState>) => {
  const updatedState = { ...drawerState, ...newState };
  drawerState = updatedState;
  lsSetItem(LS_KEY, JSON.stringify(updatedState));
};

const initDrawerState = () => {
  // Create debugger scene loader
  if (!debugSceneLoaderCreated) {
    createDebuggerSceneLoader();
    debugSceneLoaderCreated = true;
  }

  // Setup debug shortcut keys
  if (!debugKeysFromConfigInitiated) {
    const { debugKeys } = getConfig();
    if (debugKeys && debugKeys.length) {
      for (let i = 0; i < debugKeys.length; i++) {
        const keyParams = debugKeys[i];
        createKeyInputControl({
          type: keyParams.type || 'KEY_UP',
          fn: keyParams.fn,
          ...(keyParams.key ? { key: keyParams.key } : {}),
          ...(keyParams.id ? { id: keyParams.id } : {}),
          ...(keyParams.sceneId ? { sceneId: keyParams.sceneId } : {}),
        });
      }
    }
    debugKeysFromConfigInitiated = true;
  }

  // Setup drawerState
  const savedState = lsGetItem(LS_KEY, '{}');
  if (!savedState || typeof savedState !== 'string') return drawerState;
  const parsedSavedState = JSON.parse(savedState);
  drawerState = { ...drawerState, ...parsedSavedState };
  if (drawerState.isOpen) document.body.classList.add(DRAWER_OPEN_BODY_CLASS);
  return drawerState;
};

let tabsAndContainers: TabAndContainer[] = [];

const createTabMenuButtons = () => {
  for (let i = 0; i < tabsAndContainers.length; i++) {
    const data = tabsAndContainers[i];
    if (data.button) data.button.remove();
    const button = CMP({
      id: `debugTabsMenuButton-${data.id}`,
      class: styles.debugDrawerTabButton,
      html: () => `<button>${data.buttonText}</button>`,
      attr: data.title ? { title: data.title } : undefined,
      onClick: (_, cmp) => {
        if (cmp.elem.classList.contains(styles.debugDrawerTabButton_selected)) return;
        let container: TCMP | TCMP[] | null = null;
        if (typeof data.container !== 'function') {
          container = data.container.updateClass(styles.childContainer);
        } else {
          const containerOrcontainers = data.container();
          if (Array.isArray(containerOrcontainers)) {
            for (let i = 0; i < containerOrcontainers.length; i++) {
              containerOrcontainers[i].updateClass(styles.childContainer);
            }
            container = containerOrcontainers;
          } else {
            container = containerOrcontainers.updateClass(styles.childContainer);
          }
        }
        tabsContainerWrapper?.removeChildren();
        if (Array.isArray(container)) {
          for (let i = 0; i < container.length; i++) {
            tabsContainerWrapper?.add(container[i]);
          }
        } else {
          tabsContainerWrapper?.add(container);
        }
        for (let i = 0; i < tabsAndContainers.length; i++) {
          const btn = tabsAndContainers[i]?.button;
          if (btn) btn.updateClass(styles.debugDrawerTabButton_selected, 'remove');
        }
        data.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');
        saveDrawerState({ currentTabId: data.id, currentScrollPos: 0 });
      },
    });
    tabsAndContainers[i].button = button;
  }
};

let guiOpts: DebugGUIOpts | undefined = undefined;

export const _createDebugGui = (opts?: DebugGUIOpts) => {
  if (!isDebugEnvironment()) return;

  guiOpts = opts;
  initDrawerState();
  createTabMenuButtons();

  // Drawer
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
    class: [styles.debugDrawerToggler, opts?.drawerBtnPlace || 'MIDDLE'],
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
  const orderedTabsAndContainers = tabsAndContainers.sort((a, b) => {
    const maxOrderNr = 9999;
    let aOrderNr = a.orderNr;
    let bOrderNr = b.orderNr;
    if (aOrderNr === undefined) aOrderNr = maxOrderNr;
    if (bOrderNr === undefined) bOrderNr = maxOrderNr;
    if (aOrderNr < bOrderNr) return -1;
    if (aOrderNr > bOrderNr) return 1;
    return 0;
  });
  for (let i = 0; i < orderedTabsAndContainers.length; i++) {
    const button = orderedTabsAndContainers[i]?.button;
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

  // Show current tab
  let data = tabsAndContainers.find((tab) => drawerState.currentTabId === tab.id);
  let tabFound = true;
  if (!data) {
    data = tabsAndContainers[0];
    tabFound = false;
  }
  if (!data) return;

  if (typeof data.container !== 'function') {
    tabsContainerWrapper?.add(data.container.updateClass(styles.childContainer));
  } else {
    const container = data.container();
    if (Array.isArray(container)) {
      for (let i = 0; i < container.length; i++) {
        tabsContainerWrapper?.add(container[i].updateClass(styles.childContainer));
      }
    } else {
      tabsContainerWrapper?.add(container.updateClass(styles.childContainer));
    }
  }

  for (let i = 0; i < tabsAndContainers.length; i++) {
    const btn = tabsAndContainers[i]?.button;
    if (btn) btn.updateClass(styles.debugDrawerTabButton_selected, 'remove');
  }
  data.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');
  tabsContainerWrapper.elem.scrollTop = tabFound ? drawerState.currentScrollPos || 0 : 0;

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
  saveDrawerState({ isOpen: newState });
  if (drawerState.isOpen) {
    drawerCMP.updateClass(styles.debuggerGUI_open, 'add');
    drawerCMP.updateClass(styles.debuggerGUI_closed, 'remove');
    document.body.classList.add(DRAWER_OPEN_BODY_CLASS);
    return;
  }
  drawerCMP.updateClass(styles.debuggerGUI_open, 'remove');
  drawerCMP.updateClass(styles.debuggerGUI_closed, 'add');
  document.body.classList.remove(DRAWER_OPEN_BODY_CLASS);
};

export const _createDebuggerTab = (
  tabAndContainer: Omit<TabAndContainer, 'button'>,
  opts?: DebugGUIOpts
) => {
  tabsAndContainers.push({ ...tabAndContainer, button: null });
  createTabMenuButtons();
  if (!drawerCMP) return;
  const options = { ...guiOpts, ...opts };
  _createDebugGui(options);
};

export const _removeDebuggerTab = (id: string) => {
  const foundTabAndContainer = tabsAndContainers.find((tnc) => tnc.id === id);
  if (!foundTabAndContainer) {
    lwarn(`Could not find a tabAndContainer to remove with id "${id}" in removeDebuggerTab`);
    return;
  }
  tabsAndContainers = tabsAndContainers.filter((tnc) => tnc.id !== id);
  createTabMenuButtons();
  if (!drawerCMP) return;
  _createDebugGui(guiOpts);
};

export const _createNewDebuggerContainer = (id: string, heading?: string) => {
  const container = CMP({
    id: `debuggerPane-${id}`,
  });
  if (heading) container.add({ html: () => `<h3>${heading}</h3>`, class: 'debuggerTabHeading' });
  container.controls.id = id;
  return container;
};

export const _createNewDebuggerPane = (id: string, heading?: string) => {
  const container = _createNewDebuggerContainer(id, heading);
  container.update({ onRemoveCmp: () => debugGUI?.dispose() });
  const debugGUI = new Pane({ container: container.elem });

  return { container, debugGUI };
};

export const _getDrawerState = () => drawerState;

export const _updateDebuggerSceneTitle = (title: string) => {
  currentSceneTitleText = title;
  _createDebugGui(guiOpts);
};

export const _disableDebugger = (disable: boolean) => {
  if (!isDebugEnvironment) return;
  debuggerDisabled = disable;
  if (disable) {
    drawerCMP?.updateClass(styles.debuggerDisabled, 'add');
    return;
  }
  drawerCMP?.updateClass(styles.debuggerDisabled, 'remove');

  // @TODO: disable also the on screen tools
};

export const _isDebuggerDisabled = () => debuggerDisabled;
