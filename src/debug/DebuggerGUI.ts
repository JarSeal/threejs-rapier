import * as dat from 'dat.gui';
import { CMP } from '../utils/CMP';
import { lerror } from '../utils/Logger';

let gui: dat.GUI | null = null;
const GUI_CONTAINER_ID = 'guiContainer';

export const initDebugGUI = () => {
  gui = new dat.GUI({ autoPlace: false, closeOnTop: false });
  gui.useLocalStorage = true;

  const guiContainerElem = document.getElementById(GUI_CONTAINER_ID);
  if (!guiContainerElem) {
    lerror(`Could not find GUI container element with id: ${GUI_CONTAINER_ID}`);
    return;
  }

  // Create custom GUI drawer
  const drawerCMP = CMP({
    id: 'debugDrawer',
    class: 'debuggerGUI',
    attach: guiContainerElem,
    settings: { replaceRootDom: false },
  });
  // 3. Add opening and closing logic to drawer
  // 4. Attach gui to drawer
  drawerCMP.elem.append(gui.domElement);
  // 5. Add drawer states to localStorage (bring helper util from Lighter)

  // gui.domElement =
  //   document.getElementById('mainCanvas') || document.getElementsByTagName('body')[0];

  const testMenu = gui.addFolder('TADAA');
  testMenu.add({ message: 'dat.gui' }, 'message');

  // 6. Create sub menus for different debuggers (for now "Stats" only)
  // 7. Create "Stats" gui controllers

  console.log(gui.getRoot());
};

export const getGUI = () => gui;
