import { type TCMP } from '../utils/CMP';
import type { FolderApi, Pane } from 'tweakpane';
import type { BindingApi } from '@tweakpane/core';
import type { SvgIconKey } from '../core/UI/icons/SvgIcon';
import { IS_DEBUG_ENV, IS_PROD_TEST_MODE } from '../core/Config';
import { lsGetItem } from '../utils/LocalAndSessionStorage';
import { loadDebugModuleAsync, useDebug, type DebugModuleRef } from '../utils/helpers';
import { lerror } from '../utils/Logger';

export const DEBUGGER_SCENE_LOADER_ID = '__debugger-scene-loader';
export const DEBUG_TOASTER_ID = 'debugToaster';

type DebuggerGUIModule = typeof import('../core/Debug/_dbg__DebuggerGUI');
let debugGUI: DebugModuleRef<DebuggerGUIModule> | null = null;

export type DebugGUIOpts = { drawerBtnPlace?: 'TOP' | 'MIDDLE' | 'BOTTOM' };

/** A key of a tab's state, or a one level deep path into a nested object of it
 * (eg. 'helpers.showGrid'). */
export type DebuggerStateKey<S> = {
  [K in keyof S & string]: S[K] extends readonly unknown[]
    ? K
    : S[K] extends object
      ? K | `${K}.${keyof S[K] & string}`
      : K;
}[keyof S & string];

/** A static value or a function that is re-evaluated on every tab refresh. */
export type DebuggerDyn<T> = T | (() => T);

/**
 * A Tweakpane binding. Any other field (label, min, max, step, options, readonly, view,
 * format...) is passed as is to Tweakpane's `addBinding` params.
 */
export type DebuggerPaneBinding<S extends object = object> = {
  type?: 'binding';
  hidden?: DebuggerDyn<boolean>;
  disabled?: DebuggerDyn<boolean>;
  /** Called on user input only (never on hydration, refresh or rebuild). `e.prev` is the value
   * before this change, `e.last` is false for the intermediate ticks of a drag. The value is
   * persisted (see `DebuggerTabDef.persistKeys`) before this is called. */
  onChange?: (value: unknown, e: { prev: unknown; last: boolean; api: BindingApi }) => void;
  /** Called with the created binding (escape hatch for anything else). */
  onCreate?: (api: BindingApi) => void;
  [tweakpaneParam: string]: unknown;
} & (
  | {
      /** Property of the tab's `state`, or a path one level into it (eg. 'helpers.showGrid').
       * It is persisted when its top-level key is one of the tab's persistKeys. */
      key: DebuggerStateKey<S>;
      target?: undefined;
    }
  | {
      /** Property of `target`. */
      key: string;
      /** A foreign object to bind to (never persisted). */
      target: object;
    }
);

/** A Tweakpane folder. Its open/closed state is persisted to the tab's UI key (see
 * `DebuggerTabDef.uiLsKey`) when it has one. */
export type DebuggerPaneFolder<S extends object = object> = {
  type: 'folder';
  /** Folder state id. Default: the title path (eg. 'Parent/Child'). */
  id?: string;
  title: string;
  /** Initial open state (before any persisted state). Default true. */
  expanded?: boolean;
  /** Whether the open/closed state is persisted. Default true when the tab has a UI key. */
  persistExpanded?: boolean;
  hidden?: DebuggerDyn<boolean>;
  content: DebuggerPaneItem<S>[];
};

export type DebuggerPaneButton = {
  type: 'button';
  title: string;
  label?: string;
  hidden?: DebuggerDyn<boolean>;
  disabled?: DebuggerDyn<boolean>;
  onClick: () => void;
};

export type DebuggerPaneSeparator = { type: 'separator'; hidden?: DebuggerDyn<boolean> };

/** Escape hatch for anything the format doesn't cover (plugins, special blades). The returned
 * function (if any) is called on every tab refresh. */
export type DebuggerPaneCustom = {
  type: 'custom';
  build: (parent: Pane | FolderApi) => void | (() => void);
};

export type DebuggerPaneItem<S extends object = object> =
  | DebuggerPaneBinding<S>
  | DebuggerPaneFolder<S>
  | DebuggerPaneButton
  | DebuggerPaneSeparator
  | DebuggerPaneCustom;

/** A Tweakpane instance built from a declarative item list. Disposed when the tab unmounts. */
export type DebuggerPaneSection<S extends object = object> = {
  pane: true;
  /** Folder state id of a titled pane. Default: the title. */
  id?: string;
  /** Makes the whole pane a foldable root with this title. */
  title?: string;
  /** Initial open state of a titled pane. Default true. */
  expanded?: boolean;
  content: DebuggerPaneItem<S>[];
};

/** One section of a debugger tab's content, mounted in array order: a CMP (mounted as is) or a
 * declarative pane. */
export type DebuggerTabSection<S extends object = object> = TCMP | DebuggerPaneSection<S>;

/**
 * Declarative debugger tab definition for {@link createDebuggerTab}. The call builds the menu
 * button, the heading row (icon, title, clear-LS button, header buttons) and the content.
 */
export type DebuggerTabDef<S extends object = object> = {
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
  /** Module-owned object the pane bindings bind to by default (bindings without a `target`). */
  state?: S;
  /** The `state` keys that are persisted under `lsKey` (as a flat object). They are hydrated
   * into `state` synchronously at registration (also in prod test mode), and written on each
   * finished user change. No other key is ever read from or written to `lsKey`. A nested
   * object is persisted (and hydrated) whole. */
  persistKeys?: readonly (keyof S & string)[];
  /** LocalStorage key of the tab's UI state (folder open/closed states). Default:
   * `${lsKey}UI` when `lsKey` is set, otherwise none (nothing is persisted). */
  uiLsKey?: string;
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
  /** Runs before the content is built and before every refresh, eg. to sync live values into
   * the objects the panes bind to. */
  onRefresh?: () => void;
  /** Runs every time the tab content is mounted. The returned function runs on unmount (tab
   * switch, rebuild or drawer rebuild). */
  onOpen?: () => void | (() => void);
  /** Content factory. Runs on every mount and rebuild, because a removed CMP can't be mounted
   * again. */
  content: () => DebuggerTabSection<S>[];
};

/** A small icon toggle on the right side of each list row. */
export type DebuggerListToggle = {
  icon: SvgIconKey;
  /** Icon when off. Default: `icon` (dimmed). */
  iconOff?: SvgIconKey;
  title: string;
  /** Called with the new value. Use the same setter the item's edit window uses, so undo,
   * LS and an open edit window stay consistent. */
  fn: (itemId: string, nextValue: boolean) => void;
};

export type DebuggerListItem = {
  itemId: string;
  title: string;
  /** Small line at the top of the row (eg. '[appId] [entityId]'). */
  subTitle?: string;
  icon?: SvgIconKey;
  /** Short text before the title (eg. a type shorthand). */
  badge?: string;
  /** Short text after the title (eg. a count). */
  suffix?: string;
  /** A dimmed line under the title. */
  description?: string;
  /** Index-aligned with `perItemConfig.toggles`; null (or missing) = no toggle on this row. */
  toggleValues?: (boolean | null)[];
  /** Dimmed row. */
  disabled?: boolean;
  tooltip?: string;
  /** Italic title (eg. a fallback name). */
  titlePlaceholder?: boolean;
};

/** Definition for {@link debuggerListCMP}. */
export type DebuggerListDef = {
  /** CMP id `debuggerList-${id}`, automatic if omitted. */
  id?: string;
  /** Rendered above the list, with the item count. */
  heading?: string;
  emptyText?: string;
  perItemConfig?: {
    toggles?: DebuggerListToggle[];
    /** Row click, usually opens the edit window. */
    onClick?: (itemId: string) => void;
  };
  /** The selected row(s), re-read on every render and refresh. */
  selectedItemId?: () => string | string[] | null | undefined;
  /** The rows. A function is re-read on every refresh (the list re-renders only when the rows
   * or the selection changed). */
  data: DebuggerListItem[] | (() => DebuggerListItem[]);
};

/** A tab definition with its state type erased (the builder's view of any tab). */
export type AnyDebuggerTabDef = DebuggerTabDef<Record<string, unknown>>;

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
 * Creates (or replaces, by id) a debugger tab: the menu button, the heading row and the content
 * (CMP sections, declarative Tweakpane panes and lists). Persisted `state` values are hydrated
 * right away (also in prod test mode, where the drawer itself doesn't exist).
 * @param def (object) tab definition {@link DebuggerTabDef}
 * @param opts (object: DebugGUIOpts) optional debug GUI options {@link DebugGUIOpts}
 */
export const createDebuggerTab = <S extends object>(
  def: DebuggerTabDef<S>,
  opts?: DebugGUIOpts
) => {
  hydrateDebuggerTabState(def);
  // The builder only works with string keys, S only types the call site
  useDebug(debugGUI)?._createDebuggerTab(def as unknown as AnyDebuggerTabDef, opts);
};

/**
 * Restores a tab's persisted values into its state. Runs at registration (not on the first tab
 * open, and also in prod test mode), so the module can use the values at boot.
 */
const hydrateDebuggerTabState = <S extends object>(def: DebuggerTabDef<S>) => {
  if (!IS_DEBUG_ENV && !IS_PROD_TEST_MODE) return;
  const { lsKey, state, persistKeys } = def;
  if (!lsKey || !state || !persistKeys?.length) return;
  const saved = lsGetItem(lsKey, {});
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
  for (let i = 0; i < persistKeys.length; i++) {
    const key = persistKeys[i];
    if (key in saved) (state as Record<string, unknown>)[key] = saved[key];
  }
};

/**
 * Persists one `persistKeys` value of a tab's state, for changes made outside the tab's own
 * inputs (eg. undo/redo handlers). Input changes are persisted automatically.
 * @param id (string) tab id
 * @param key (string) state key (must be one of the tab's persistKeys)
 */
export const persistDebuggerTabValue = (id: string, key: string) => {
  useDebug(debugGUI)?._persistDebuggerTabValue(id, key);
};

/**
 * Refreshes a debugger tab, but only if it is the visible one (see {@link isDebuggerTabOpen}),
 * otherwise it does nothing (a closed tab is built fresh on its next mount anyway).
 * A refresh runs the tab's `onRefresh`, then updates its panes (hidden/disabled and the bound
 * values, without firing onChange), its lists and its CMP sections with an `html` function.
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
 * Opens the drawer on a debugger tab (switching to it if another one is showing).
 * @param id (string) tab id
 */
export const openDebuggerTab = (id: string) => {
  useDebug(debugGUI)?._openDebuggerTab(id);
};

/**
 * Removes a debugger tab
 * @param id (string) tab id
 */
export const removeDebuggerTab = (id: string) => {
  useDebug(debugGUI)?._removeDebuggerTab(id);
};

/**
 * Creates a debugger list (the shared list component of debugger tabs). A list inside the open
 * tab is refreshed by {@link updateDebuggerTab}.
 * @param def (object) {@link DebuggerListDef}
 * @returns TCMP
 */
export const debuggerListCMP = (def: DebuggerListDef) => {
  const list = useDebug(debugGUI)?._debuggerListCMP(def);
  if (!list) {
    const msg =
      'Failed to create a debugger list (in debuggerListCMP). It could be that it is being created in production mode.';
    lerror(msg);
    throw new Error(msg);
  }
  return list;
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
