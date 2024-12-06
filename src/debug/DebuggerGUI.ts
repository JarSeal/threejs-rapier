import * as dat from 'dat.gui';
import { CMP, TCMP } from '../utils/CMP';
import { lerror } from '../utils/Logger';
import styles from './DebuggerGUI.module.scss';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';

let debugGui: dat.GUI | null = null;
let tabsContainerWrapper: null | TCMP = null;
const GUI_CONTAINER_ID = 'guiContainer';

type DrawerState = {
  isOpen: boolean;
  currentTabId: string;
};

let drawerState: DrawerState = {
  isOpen: false,
  currentTabId: 'stats',
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
  scrollPos: number;
  container: TCMP;
  button: null | TCMP;
};

const tabsAndContainers: TabAndContainer[] = [
  {
    id: 'stats',
    buttonText: 'S',
    scrollPos: 0,
    button: null,
    container: CMP({ id: 'debuggerStatsContainer', text: 'STATISICTIFSFS' }),
  },
  {
    id: 'otherstats',
    buttonText: 'M',
    scrollPos: 0,
    button: null,
    container: CMP({ id: 'debuggerOtherStatsContainer', text: 'OTHER STATS' }),
  },
];

for (let i = 0; i < tabsAndContainers.length; i++) {
  const data = tabsAndContainers[i];
  const button = CMP({
    id: `debugTabsMenuButton-${data.id}`,
    tag: 'button',
    text: data.buttonText,
    onClick: () => {
      const container = data.container;
      tabsContainerWrapper?.removeChildren();
      tabsContainerWrapper?.add(container);
      for (let i = 0; i < tabsAndContainers.length; i++) {
        const btn = tabsAndContainers[i].button;
        if (btn) btn.updateClass(styles.debugDrawerTabButton_selected, 'remove');
      }
      data.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');
      saveDrawerState({ currentTabId: data.id });
    },
  });
  tabsAndContainers[i].button = button;
}

export const initDebugGUI = () => {
  debugGui = new dat.GUI({ autoPlace: false, closeOnTop: false });
  debugGui.useLocalStorage = true;

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
  const drawerCMP = createDebugGuiCmp(guiContainerElem);
  // 3. Add opening and closing logic to drawer
  // 4. Attach gui to drawer
  drawerCMP.elem.append(debugGui.domElement);
  // 5. Add drawer states to localStorage (bring helper util from Lighter)

  // gui.domElement =
  //   document.getElementById('mainCanvas') || document.getElementsByTagName('body')[0];

  const testMenu = debugGui.addFolder('Stats');
  testMenu.add({ message: 'dat.gui' }, 'message');

  // 6. Create sub menus for different debuggers (for now "Stats" only)
  // 7. Create "Stats" gui controllers
};

export const getDebugGUI = () => debugGui;

const createDebugGuiCmp = (guiContainerElem: HTMLElement) => {
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
    class: styles.debugDrawerToggler,
    onClick: () => {
      saveDrawerState({ isOpen: !drawerState.isOpen });
      if (drawerState.isOpen) {
        drawerCMP.updateClass(styles.debuggerGUI_open, 'add');
        drawerCMP.updateClass(styles.debuggerGUI_closed, 'remove');
        return;
      }
      drawerCMP.updateClass(styles.debuggerGUI_open, 'remove');
      drawerCMP.updateClass(styles.debuggerGUI_closed, 'add');
    },
  });
  drawerCMP.add(toggleDrawerButton);

  // Tabs container wrapper
  tabsContainerWrapper = CMP({
    id: 'debugDrawerTabsContainerWrapper',
    class: styles.debugDrawerTabsContainer,
  });

  // Tabs menu container
  const tabsMenuContainer = CMP({
    id: 'debugDrawerTabsMenu',
    class: styles.debugDrawerTabsMenu,
  });
  for (let i = 0; i < tabsAndContainers.length; i++) {
    const button = tabsAndContainers[i].button;
    if (button) tabsMenuContainer.add(button);
  }

  drawerCMP.add(tabsMenuContainer);
  drawerCMP.add(tabsContainerWrapper);

  // Show current tab
  let data = tabsAndContainers.find((tab) => drawerState.currentTabId === tab.id);
  if (!data) data = tabsAndContainers[0];
  tabsContainerWrapper?.add(data.container);
  for (let i = 0; i < tabsAndContainers.length; i++) {
    const btn = tabsAndContainers[i].button;
    if (btn) btn.updateClass(styles.debugDrawerTabButton_selected, 'remove');
  }
  data.button?.updateClass(styles.debugDrawerTabButton_selected, 'add');

  return drawerCMP;
};
