import { Pane, type FolderApi } from 'tweakpane';
import type { BindingApi } from '@tweakpane/core';
import { CMP, type TCMP } from '../../utils/CMP';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { lwarn } from '../../utils/Logger';
import type {
  AnyDebuggerTabDef,
  DebuggerDyn,
  DebuggerPaneBinding,
  DebuggerPaneItem,
  DebuggerPaneSection,
} from '../../debug/DebuggerGUI';

type AnyState = Record<string, unknown>;

/** A built pane section of a mounted tab. */
export type BuiltDebuggerPane = {
  cmp: TCMP;
  /** Re-evaluates hidden/disabled and refreshes the bound values, without firing onChange. */
  refresh: () => void;
};

type UIState = { folders?: { [folderId: string]: boolean } };

/** What a pane needs of its owner: a debugger tab, or eg. a debug window with its own state. */
export type DebuggerPaneOwner = Pick<
  AnyDebuggerTabDef,
  'id' | 'state' | 'lsKey' | 'persistKeys' | 'uiLsKey'
>;

const resolveDyn = <T>(value: DebuggerDyn<T>) =>
  typeof value === 'function' ? (value as () => T)() : value;

const snapshot = (value: unknown) => {
  if (typeof value !== 'object' || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

/** LS key of a tab's UI state (folder open/closed states), if it has one. */
const getDebuggerTabUIKey = (def: DebuggerPaneOwner) =>
  def.uiLsKey ?? (def.lsKey ? `${def.lsKey}UI` : undefined);

/**
 * Writes one state key of a tab to its lsKey: the other persistKeys already saved are kept, any
 * other (legacy) field of the saved object is dropped.
 */
export const persistDebuggerTabStateValue = (def: DebuggerPaneOwner, key: string) => {
  const { lsKey, state, persistKeys } = def;
  if (!lsKey || !state || !persistKeys?.includes(key)) {
    lwarn(`Debugger tab "${def.id}" has no persisted state key "${key}" (see persistKeys).`);
    return;
  }
  const saved = lsGetItem(lsKey, {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (let i = 0; i < persistKeys.length; i++) {
    const persistKey = persistKeys[i];
    if (persistKey in saved) next[persistKey] = saved[persistKey];
  }
  next[key] = state[key];
  lsSetItem(lsKey, next);
};

const saveFolderExpanded = (uiKey: string, folderId: string, expanded: boolean) => {
  // Merged: a module may keep other UI fields in the same key
  const uiState = lsGetItem(uiKey, {}) as UIState;
  lsSetItem(uiKey, { ...uiState, folders: { ...uiState.folders, [folderId]: expanded } });
};

/**
 * Builds a declarative pane section of a debugger tab, or of any other {@link DebuggerPaneOwner}
 * (eg. a debug window), as Tweakpane in its own container CMP.
 * The pane is disposed when the container CMP is removed.
 */
export const _buildDebuggerPane = (
  def: DebuggerPaneOwner,
  section: DebuggerPaneSection<AnyState>
): BuiltDebuggerPane => {
  const uiKey = getDebuggerTabUIKey(def);
  const savedFolders = uiKey ? (lsGetItem(uiKey, {}) as UIState).folders || {} : {};

  // True while values are pushed into the pane (refresh): Tweakpane's refresh() emits `change`
  let isSuppressed = false;
  // Per refresh: hidden/disabled re-evaluation, value snapshots (for `prev`), custom refreshers
  const refreshers: (() => void)[] = [];

  let pane: Pane | null = null;
  // onRemoveCmp is set here: a later container.update() would replace the element the pane is in
  const container = CMP({ class: 'debuggerPaneSection', onRemoveCmp: () => pane?.dispose() });

  const getFolderExpanded = (folderId: string, expanded: boolean | undefined, persist: boolean) =>
    persist && folderId in savedFolders ? savedFolders[folderId] : expanded !== false;

  const bindFolderPersistence = (folder: FolderApi | Pane, folderId: string, persist: boolean) => {
    if (!persist || !uiKey) return;
    folder.on('fold', (e) => saveFolderExpanded(uiKey, folderId, e.expanded));
  };

  const addBinding = (parent: Pane | FolderApi, item: DebuggerPaneBinding<AnyState>) => {
    const { key, target, hidden, disabled, onChange, onCreate, ...params } = item;
    delete params.type;
    // A state key can be a path one level deep ('nested.prop'); the top-level key is persisted
    const dotIndex = target ? -1 : key.indexOf('.');
    const rootKey = dotIndex === -1 ? key : key.slice(0, dotIndex);
    const prop = dotIndex === -1 ? key : key.slice(dotIndex + 1);
    const obj =
      (target as AnyState | undefined) ||
      (dotIndex === -1 ? def.state : (def.state?.[rootKey] as AnyState | undefined));
    if (!obj) {
      lwarn(`Debugger tab "${def.id}" binding "${key}" has no target object.`);
      return;
    }
    const isPersisted = !target && Boolean(def.persistKeys?.includes(rootKey));
    const api: BindingApi = parent.addBinding(obj, prop, {
      ...params,
      ...(hidden !== undefined ? { hidden: resolveDyn(hidden) } : {}),
      ...(disabled !== undefined ? { disabled: resolveDyn(disabled) } : {}),
    });

    let lastValue = snapshot(obj[prop]);
    api.on('change', (e) => {
      if (isSuppressed) return;
      const prev = lastValue;
      lastValue = snapshot(e.value);
      if (isPersisted && e.last) persistDebuggerTabStateValue(def, rootKey);
      onChange?.(e.value, { prev, last: e.last, api });
    });
    refreshers.push(() => {
      if (hidden !== undefined) api.hidden = resolveDyn(hidden);
      if (disabled !== undefined) api.disabled = resolveDyn(disabled);
      lastValue = snapshot(obj[prop]);
    });
    onCreate?.(api);
  };

  const addItems = (
    parent: Pane | FolderApi,
    items: DebuggerPaneItem<AnyState>[],
    path: string
  ) => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'folder') {
        const folderPath = path ? `${path}/${item.title}` : item.title;
        const folderId = item.id || folderPath;
        const persist = item.persistExpanded ?? Boolean(uiKey);
        const folder = parent.addFolder({
          title: item.title,
          expanded: getFolderExpanded(folderId, item.expanded, persist),
          ...(item.hidden !== undefined ? { hidden: resolveDyn(item.hidden) } : {}),
        });
        bindFolderPersistence(folder, folderId, persist);
        const folderHidden = item.hidden;
        if (folderHidden !== undefined) {
          refreshers.push(() => (folder.hidden = resolveDyn(folderHidden)));
        }
        addItems(folder, item.content, folderPath);
      } else if (item.type === 'button') {
        const { hidden, disabled } = item;
        const button = parent.addButton({
          title: item.title,
          label: item.label,
          ...(hidden !== undefined ? { hidden: resolveDyn(hidden) } : {}),
          ...(disabled !== undefined ? { disabled: resolveDyn(disabled) } : {}),
        });
        button.on('click', () => item.onClick());
        if (hidden !== undefined || disabled !== undefined) {
          refreshers.push(() => {
            if (hidden !== undefined) button.hidden = resolveDyn(hidden);
            if (disabled !== undefined) button.disabled = resolveDyn(disabled);
          });
        }
      } else if (item.type === 'separator') {
        const hidden = item.hidden;
        const separator = parent.addBlade({
          view: 'separator',
          ...(hidden !== undefined ? { hidden: resolveDyn(hidden) } : {}),
        });
        if (hidden !== undefined) refreshers.push(() => (separator.hidden = resolveDyn(hidden)));
      } else if (item.type === 'custom') {
        const customRefresh = item.build(parent);
        if (customRefresh) refreshers.push(customRefresh);
      } else {
        addBinding(parent, item);
      }
    }
  };

  const paneId = section.id || section.title || '';
  const persistPane = Boolean(section.title && uiKey);
  pane = new Pane({
    container: container.elem,
    ...(section.title
      ? { title: section.title, expanded: getFolderExpanded(paneId, section.expanded, persistPane) }
      : {}),
  });
  bindFolderPersistence(pane, paneId, persistPane);
  addItems(pane, section.content, section.title || '');
  const builtPane = pane;

  return {
    cmp: container,
    refresh: () => {
      isSuppressed = true;
      try {
        builtPane.refresh();
        for (let i = 0; i < refreshers.length; i++) refreshers[i]();
      } finally {
        isSuppressed = false;
      }
    },
  };
};
