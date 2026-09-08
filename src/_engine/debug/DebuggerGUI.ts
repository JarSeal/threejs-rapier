import { type TCMP } from '../utils/CMP';
import { loadDebugModuleAsync, useDebug, type DebugModuleRef } from '../utils/helpers';
import { lerror } from '../utils/Logger';

export const DEBUGGER_SCENE_LOADER_ID = '__debugger-scene-loader';

type DebuggerGUIModule = typeof import('../core/Debug/_dbg__DebuggerGUI');
let debugGUI: DebugModuleRef<DebuggerGUIModule> | null = null;

export type DebugGUIOpts = { drawerBtnPlace?: 'TOP' | 'MIDDLE' | 'BOTTOM' };

export type TabAndContainer = {
  id: string;
  buttonText: string | TCMP;
  title?: string;
  container: TCMP | (() => TCMP | TCMP[]);
  button: null | TCMP;
  orderNr?: number;
};

export const registerDebuggerGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__DebuggerGUI'), true);
};

/**
 * Creates the debug GUI (the root functionality)
 * @param opts (object) optional debug GUI options {@link DebugGUIOpts}
 * @returns TCMP or undefined
 */
export const createDebugGui = (opts?: DebugGUIOpts) => useDebug(debugGUI)?._createDebugGui(opts);

/**
 * Toggles the drawer open or closed
 * @param openOrClose ('OPEN' | 'CLOSE') optional next state of the drawer, if not provided then the opposite of the current state is the next state
 */
export const toggleDrawer = (openOrClose?: 'OPEN' | 'CLOSE') => {
  useDebug(debugGUI)?._toggleDrawer(openOrClose);
};

/**
 * Creates a debugger tab (and container)
 * @param tabAndContainer (object: Omit<TabAndContainer, 'button'>) {@link TabAndContainer}
 * @param opts (object: DebugGUIOpts) optional debug GUI options {@link DebugGUIOpts}
 */
export const createDebuggerTab = (
  tabAndContainer: Omit<TabAndContainer, 'button'>,
  opts?: DebugGUIOpts
) => {
  useDebug(debugGUI)?._createDebuggerTab(tabAndContainer, opts);
};

/**
 * Removes a tab and container
 * @param id (string) tabsAndContainers id to be removed
 */
export const removeDebuggerTab = (id: string) => {
  useDebug(debugGUI)?._removeDebuggerTab(id);
};

export const createNewDebuggerContainer = (id: string, heading?: string) => {
  const debugContainer = useDebug(debugGUI)?._createNewDebuggerContainer(id, heading);
  if (!debugContainer) {
    const msg =
      'Failed to create a new debugger container (in createNewDebuggerContainer). It could be that the a new pane is being created in production mode.';
    lerror(msg);
    throw new Error(msg);
  }
  return debugContainer;
};

/**
 * Creates a new debugger pane (in a CMP container).
 * @param id (string) debugger pane id
 * @param heading (string) optional heading for the section
 * @returns (object: { container, debugGUI }) the container component and the debugGUI parent object
 */
export const createNewDebuggerPane = (id: string, heading?: string) => {
  const debugPane = useDebug(debugGUI)?._createNewDebuggerPane(id, heading);
  if (!debugPane) {
    const msg =
      'Failed to create a new debugger pane (in createNewDebuggerPane). It could be that the a new pane is being created in production mode.';
    lerror(msg);
    throw new Error(msg);
  }
  return debugPane;
};

/**
 * Returns the current drawerState
 * @returns object {@link DrawerState}
 */
export const getDrawerState = () => useDebug(debugGUI)?._getDrawerState();

export const updateDebuggerSceneTitle = (title: string) => {
  useDebug(debugGUI)?._updateDebuggerSceneTitle(title);
};

export const disableDebugger = (disable: boolean) => {
  useDebug(debugGUI)?._disableDebugger(disable);
};

export const isDebuggerDisabled = () => useDebug(debugGUI)?._isDebuggerDisabled();
