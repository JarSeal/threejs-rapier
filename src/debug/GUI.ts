import * as dat from 'dat.gui';

let gui: dat.GUI | null = null;

export const initDebugGUI = () => {
  gui = new dat.GUI({ autoPlace: true, closeOnTop: false });
  gui.useLocalStorage = true;

  // Create custom GUI drawer
  // 1. Create HTML elem (with CMP)
  // 2. Attach to DOM
  // 3. Add opening and closing logic to drawer
  // 4. Attach gui to drawer
  // 5. Add drawer states to localStorage (bring helper util from Lighter)

  gui.domElement =
    document.getElementById('mainCanvas') || document.getElementsByTagName('body')[0];

  const testMenu = gui.addFolder('TADAA');
  testMenu.add({ message: 'dat.gui' }, 'message');

  // 6. Create sub menus for different debuggers (for now "Stats" only)
  // 7. Create "Stats" gui controllers

  console.log(gui.getRoot());
};
