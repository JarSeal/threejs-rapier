import * as dat from 'dat.gui';
import { CMP, TCMP } from '../utils/CMP';
import { lerror } from '../utils/Logger';
import styles from './DebuggerGUI.module.scss';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getWindowSize } from '../utils/Window';

// @TODO: add window size listener to update the scrollable area

let debugGui: dat.GUI | null = null;
let tabsContainerWrapper: null | TCMP = null;
const GUI_CONTAINER_ID = 'guiContainer';

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

const tabsAndContainers: TabAndContainer[] = [
  {
    id: 'stats',
    buttonText: 'S',
    title: 'Statistics',
    button: null,
    container: () => {
      const container = CMP({ id: 'debuggerStatsContainer' });
      container.add({ tag: 'h3', text: 'Statistics', class: 'debuggerHeading' });
      const debugGui = new dat.GUI({ autoPlace: false, closeOnTop: false });
      debugGui.useLocalStorage = true;
      const testMenu = debugGui.addFolder('Stats');
      testMenu.add({ message: 'dat.gui' }, 'message');
      container.elem.append(debugGui.domElement);
      return container;
    },
    orderNr: 0,
  },
  {
    id: 'otherstats',
    buttonText: 'M',
    title: 'Other stats',
    button: null,
    container: CMP({
      id: 'debuggerOtherStatsContainer',
      html: `<div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div style="height:300px;background:red;">LONG stuff</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div style="height:300px;background:yellow;">LONG stuff</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div style="height:300px;background:green;">LONG stuff</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div>MYSTATAFFA</div>
      <div style="height:300px;background:blue;">LONG stuff</div>
      </div>`,
    }),
    orderNr: 1,
  },
];

for (let i = 0; i < tabsAndContainers.length; i++) {
  const data = tabsAndContainers[i];
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
        const btn = tabsAndContainers[i].button;
        if (btn) btn.updateClass(styles.debugDrawerTabButton_selected, 'remove');
      }
      data.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');
      saveDrawerState({ currentTabId: data.id, currentScrollPos: 0 });
    },
  });
  tabsAndContainers[i].button = button;
}

export const getGUIContainerElem = () => {
  const guiContainerElem = document.getElementById(GUI_CONTAINER_ID);
  if (!guiContainerElem) {
    throw new Error(`GUI container parent element with id "${GUI_CONTAINER_ID}" was not found.`);
  }
  return guiContainerElem;
};

export type DebugGUIOpts = { drawerBtnPlace: 'TOP' | 'MIDDLE' | 'BOTTOM' };

export const initDebugGUI = (opts?: DebugGUIOpts) => {
  // debugGui = new dat.GUI({ autoPlace: false, closeOnTop: false });
  // debugGui.useLocalStorage = true;

  const guiContainerElem = document.getElementById(GUI_CONTAINER_ID);
  if (!guiContainerElem) {
    lerror(`Could not find GUI container element with id: ${GUI_CONTAINER_ID}`);
    return;
  }

  // Create custom GUI drawer
  // const drawerCMP = CMP({
  //   id: 'debugDrawer',
  //   class: styles.debuggerGUI,
  //   attach: guiContainerElem,
  //   settings: { replaceRootDom: false },
  // });
  const drawerCMP = createDebugGuiCmp(guiContainerElem, opts);
  // 3. Add opening and closing logic to drawer
  // 4. Attach gui to drawer
  // drawerCMP.elem.append(debugGui.domElement);
  // 5. Add drawer states to localStorage (bring helper util from Lighter)

  // gui.domElement =
  //   document.getElementById('mainCanvas') || document.getElementsByTagName('body')[0];

  // const testMenu = debugGui.addFolder('Stats');
  // testMenu.add({ message: 'dat.gui' }, 'message');

  // 6. Create sub menus for different debuggers (for now "Stats" only)
  // 7. Create "Stats" gui controllers
};

export const getDebugGUI = () => debugGui;

const createDebugGuiCmp = (guiContainerElem: HTMLElement, opts?: DebugGUIOpts) => {
  getDrawerState();

  // Drawer
  const drawerCMP = CMP({
    id: 'debugDrawer',
    class: [
      styles.debuggerGUI,
      drawerState.isOpen ? styles.debuggerGUI_open : styles.debuggerGUI_closed,
    ],
    attach: guiContainerElem,
    settings: { replaceRootDom: false },
  });

  // Drawer toggle button
  const toggleDrawerButton = CMP({
    id: 'debugDrawerToggler',
    tag: 'button',
    text: 'Debug',
    class: [styles.debugDrawerToggler, opts?.drawerBtnPlace],
    onClick: () => toggleDrawer(drawerCMP),
  });
  drawerCMP.add(toggleDrawerButton);

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
    const button = orderedTabsAndContainers[i].button;
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
  if (!data) data = tabsAndContainers[0];
  tabsContainerWrapper?.add(
    typeof data.container === 'function' ? data.container() : data.container
  );
  for (let i = 0; i < tabsAndContainers.length; i++) {
    const btn = tabsAndContainers[i].button;
    if (btn) btn.updateClass(styles.debugDrawerTabButton_selected, 'remove');
  }
  data.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');
  tabsContainerWrapper.elem.scrollTop = drawerState.currentScrollPos || 0;

  return drawerCMP;
};

const toggleDrawer = (drawerCMP: TCMP, openOrClose?: 'OPEN' | 'CLOSE') => {
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
