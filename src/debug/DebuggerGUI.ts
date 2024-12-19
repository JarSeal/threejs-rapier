import GUI from 'lil-gui';
import { CMP, TCMP } from '../utils/CMP';
import styles from './DebuggerGUI.module.scss';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getWindowSize } from '../utils/Window';
import { getHUDRootCMP } from '../core/HUD';

// @TODO: add window size listener to update the scrollable area

let drawerCMP: TCMP | null = null;
let tabsContainerWrapper: null | TCMP = null;
const LS_PREFIX = 'debug-folders-';

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
  lsSetItem('debugDrawerState', JSON.stringify(updatedState));
};

const getDrawerState = () => {
  const savedState = lsGetItem('debugDrawerState', '{}');
  if (!savedState || typeof savedState !== 'string') return drawerState;
  const parsedSavedState = JSON.parse(savedState);
  drawerState = { ...drawerState, ...parsedSavedState };
  return drawerState;
};

type TabAndContainer = {
  id: string;
  buttonText: string;
  title?: string;
  container: TCMP | (() => TCMP);
  button: null | TCMP;
  orderNr?: number;
};

const tabsAndContainers: TabAndContainer[] = [];

// @TODO: add JSDoc comment
const createTabMenuButtons = () => {
  for (let i = 0; i < tabsAndContainers.length; i++) {
    const data = tabsAndContainers[i];
    if (data.button) data.button.remove();
    const button = CMP({
      id: `debugTabsMenuButton-${data.id}`,
      tag: 'button',
      class: styles.debugDrawerTabButton,
      text: data.buttonText,
      attr: data.title ? { title: data.title } : undefined,
      onClick: (_, cmp) => {
        if (cmp.elem.classList.contains(styles.debugDrawerTabButton_selected)) return;
        const container = typeof data.container === 'function' ? data.container() : data.container;
        tabsContainerWrapper?.removeChildren();
        tabsContainerWrapper?.add(container);
        for (let i = 0; i < tabsAndContainers.length; i++) {
          const btn = tabsAndContainers[i]?.button;
          if (btn) btn.updateClass(styles.debugDrawerTabButton_selected, 'remove');
        }
        data.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');
        saveDrawerState({ currentTabId: data.id, currentScrollPos: 0 });
        setFolderData(container.controls?.id as string, container.controls?.debugGui as GUI);
      },
    });
    tabsAndContainers[i].button = button;
  }
};
createTabMenuButtons();

export type DebugGUIOpts = { drawerBtnPlace?: 'TOP' | 'MIDDLE' | 'BOTTOM' };
let guiOpts: DebugGUIOpts | undefined = undefined;

// @TODO: add JSDoc comment
export const createDebugGui = (opts?: DebugGUIOpts) => {
  guiOpts = opts;
  getDrawerState();

  // Drawer
  if (drawerCMP) drawerCMP.remove();
  drawerCMP = getHUDRootCMP().add({
    id: 'debugDrawer',
    class: [
      styles.debuggerGUI,
      drawerState.isOpen ? styles.debuggerGUI_open : styles.debuggerGUI_closed,
    ],
    settings: { replaceRootDom: false },
  });

  // Drawer toggle button
  drawerCMP.add({
    id: 'debugDrawerToggler',
    tag: 'button',
    text: 'Debug',
    class: [styles.debugDrawerToggler, opts?.drawerBtnPlace],
    onClick: () => toggleDrawer(drawerCMP),
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

  tabsMenuContainer.add({
    id: 'debugCloseBtn',
    tag: 'button',
    class: styles.closeBtn,
    attr: { title: 'Close' },
    onClick: () => toggleDrawer(drawerCMP, 'CLOSE'),
  });

  drawerCMP.add(tabsMenuContainer);
  drawerCMP.add(tabsContainerWrapper);
  const containerHeight = getWindowSize().height - tabsMenuContainer.elem.offsetHeight - 24; // 24 is padding

  tabsContainerWrapper.update({
    attr: { style: `height: ${containerHeight}px` },
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

  // Show current tab
  let data = tabsAndContainers.find((tab) => drawerState.currentTabId === tab.id);
  let tabFound = true;
  if (!data) {
    data = tabsAndContainers[0];
    tabFound = false;
  }
  if (!data) return;
  const container = tabsContainerWrapper?.add(
    typeof data.container === 'function' ? data.container() : data.container
  );
  setFolderData(container.controls?.id as string, container.controls?.debugGui as GUI);

  for (let i = 0; i < tabsAndContainers.length; i++) {
    const btn = tabsAndContainers[i]?.button;
    if (btn) btn.updateClass(styles.debugDrawerTabButton_selected, 'remove');
  }
  data.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');
  tabsContainerWrapper.elem.scrollTop = tabFound ? drawerState.currentScrollPos || 0 : 0;

  return drawerCMP;
};

const toggleDrawer = (drawerCMP: TCMP | null, openOrClose?: 'OPEN' | 'CLOSE') => {
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
    return;
  }
  drawerCMP.updateClass(styles.debuggerGUI_open, 'remove');
  drawerCMP.updateClass(styles.debuggerGUI_closed, 'add');
};

// @TODO: add JSDoc comment
export const setDebuggerTabAndContainer = (
  tabAndContainer: Omit<TabAndContainer, 'button'>,
  opts?: DebugGUIOpts
) => {
  tabsAndContainers.push({ ...tabAndContainer, button: null });
  createTabMenuButtons();
  if (!drawerCMP) return;
  const options = { ...guiOpts, ...opts };
  createDebugGui(options);
};

// @TODO: add JSDoc comment
export const createNewDebuggerGUI = (id: string, heading?: string) => {
  const idAndName = `debuggerContainer-${id}`;
  const container = CMP({
    id: idAndName,
    onRemoveCmp: () => debugGui.destroy(),
  });
  if (heading) container.add({ tag: 'h3', text: heading, class: 'debuggerHeading' });
  const debugGui = new GUI({
    autoPlace: false,
    title: '',
  });
  debugGui.open();

  debugGui.onOpenClose(() => {
    const rootFolder = debugGui.folders[0].root;
    rootFolder.open();
    const folderData = debugGui
      .foldersRecursive()
      .map((folder) => ({ closed: folder._closed, hidden: folder._hidden }));
    lsSetItem(LS_PREFIX + id, JSON.stringify(folderData));
  });

  container.elem.append(debugGui.domElement);
  container.controls.debugGui = debugGui;
  container.controls.id = id;
  return { container, debugGui };
};

const setFolderData = (id?: string, debugGui?: GUI) => {
  if (!id || !debugGui) return;

  const folderData = lsGetItem(LS_PREFIX + id, []);
  const folders = debugGui.foldersRecursive();

  if (folderData.length !== folders.length) return;
  for (let i = 0; i < folders.length; i++) {
    const closed = folderData[i].closed;
    if (closed) {
      folders[i].close();
      continue;
    }
    folders[i].open();
  }
};
