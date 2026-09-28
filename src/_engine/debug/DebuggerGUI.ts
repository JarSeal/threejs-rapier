import { type TCMP } from '../utils/CMP';
import type { SvgIconKey } from '../core/UI/icons/SvgIcon';
import { loadDebugModuleAsync, useDebug, type DebugModuleRef } from '../utils/helpers';
import { lerror } from '../utils/Logger';

export const DEBUGGER_SCENE_LOADER_ID = '__debugger-scene-loader';
export const DEBUG_TOASTER_ID = 'debugToaster';

type DebuggerGUIModule = typeof import('../core/Debug/_dbg__DebuggerGUI');
let debugGUI: DebugModuleRef<DebuggerGUIModule> | null = null;

export type DebugGUIOpts = { drawerBtnPlace?: 'TOP' | 'MIDDLE' | 'BOTTOM' };

/**
 * Legacy tab shape (menu button text + a hand-built container).
 * @deprecated Use {@link DebuggerTabDef} with {@link createDebuggerTab} instead.
 */
export type TabAndContainer = {
  id: string;
  buttonText: string | TCMP;
  title?: string;
  container: TCMP | (() => TCMP | TCMP[]);
  button: null | TCMP;
  orderNr?: number;
};

/** One section of a debugger tab's content, mounted in array order. */
export type DebuggerTabSection = TCMP;

/**
 * Declarative debugger tab definition for {@link createDebuggerTab}. The call builds the menu
 * button, the heading row (icon, title, clear-LS button, header buttons) and the content.
 */
export type DebuggerTabDef = {
  /** Unique tab id. Registering the same id again replaces the tab. */
  id: string;
  /** Heading text and menu button tooltip. */
  title: string;
  /** Menu button and heading icon. */
  icon: SvgIconKey;
  /** Explicit place in the menu, overriding `AppConfig.debugDrawer.tabOrder`. It is on the same
   * 0-based scale as the tabOrder indexes (eg. 1.5 = between the 2nd and the 3rd tab). */
  orderNr?: number;
  /** LocalStorage key of this tab's own data. When set, the heading gets a clear-LS button for
   * it (see `clearLSButton`). */
  lsKey?: string;
  /** Extra heading row buttons, after the clear-LS button (eg. a clear list LS button). */
  headerButtons?: () => TCMP[];
  /** Whether the heading has the clear tab LS button. Default: true when `lsKey` is set. Set to
   * true without `lsKey` for a permanently disabled button (consistency with other tabs). */
  clearLSButton?: boolean;
  /** Called after the clear-LS button has removed `lsKey`, eg. to reset the live state. */
  onClearLS?: () => void;
  /** When set, the tab is refreshed ({@link updateDebuggerTab}) at this interval, but only
   * while it is visible (drawer open and this tab selected). */
  refreshIntervalMs?: number;
  /** Runs every time the tab content is mounted. The returned function runs on unmount (tab
   * switch, rebuild or drawer rebuild). */
  onOpen?: () => void | (() => void);
  /** Content factory. Runs on every mount and rebuild, because a removed CMP can't be mounted
   * again. */
  content: () => DebuggerTabSection[];
};

/** Options for {@link updateDebuggerTab}. */
export type UpdateDebuggerTabOpts = {
  /** Re-run the tab's content factory instead of refreshing the mounted content (for
   * structural changes). The scroll position is kept. */
  rebuild?: boolean;
};

export const registerDebuggerGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__DebuggerGUI'), true);
  // Debug env only: the first loadScene may target this loader ("Use debugger scene loader for start scene")
  useDebug(debugGUI)?._ensureDebuggerSceneLoader();
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
 * Creates (or replaces, by id) a debugger tab.
 * @param def (object) tab definition {@link DebuggerTabDef}, or the deprecated legacy shape
 * {@link TabAndContainer} (without `button`)
 * @param opts (object: DebugGUIOpts) optional debug GUI options {@link DebugGUIOpts}
 */
export const createDebuggerTab = (
  def: DebuggerTabDef | Omit<TabAndContainer, 'button'>,
  opts?: DebugGUIOpts
) => {
  useDebug(debugGUI)?._createDebuggerTab(def, opts);
};

/**
 * Refreshes a debugger tab, but only if it is the visible one (see {@link isDebuggerTabOpen}),
 * otherwise it does nothing (a closed tab is built fresh on its next mount anyway).
 * A refresh updates the tab's dynamic content (CMP sections with an `html` function); legacy
 * tabs are only affected by `rebuild`.
 * @param id (string) tab id
 * @param opts (object) optional {@link UpdateDebuggerTabOpts}
 */
export const updateDebuggerTab = (id: string, opts?: UpdateDebuggerTabOpts) => {
  useDebug(debugGUI)?._updateDebuggerTab(id, opts);
};

/**
 * Whether a debugger tab is visible: the drawer is built and open, and the tab is the mounted one.
 * @param id (string) tab id
 * @returns boolean
 */
export const isDebuggerTabOpen = (id: string) =>
  useDebug(debugGUI)?._isDebuggerTabOpen(id) ?? false;

/**
 * Removes a tab and container
 * @param id (string) tabsAndContainers id to be removed
 */
export const removeDebuggerTab = (id: string) => {
  useDebug(debugGUI)?._removeDebuggerTab(id);
};

export const createNewDebuggerContainer = (
  id: string,
  heading?: string,
  headerButtons?: TCMP[]
) => {
  const debugContainer = useDebug(debugGUI)?._createNewDebuggerContainer(
    id,
    heading,
    headerButtons
  );
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
export const createNewDebuggerPane = (id: string, heading?: string, headerButtons?: TCMP[]) => {
  const debugPane = useDebug(debugGUI)?._createNewDebuggerPane(id, heading, headerButtons);
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
