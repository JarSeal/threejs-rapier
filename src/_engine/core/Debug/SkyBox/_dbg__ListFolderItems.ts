import { updateDebuggerTab, type DebuggerPaneItem } from '../../../debug/DebuggerGUI';
import { getActiveSkyBox } from '../../SkyBox/SkyBox';
import {
  getListEntries,
  getSelectedIndex,
  getSkyBoxDef,
  LIST_MAX,
  selectListEntry,
  setSkyBoxArray,
  SKYBOX_TAB_ID,
  type SkyBoxListKey,
} from './_dbg__SkyBoxShared';

/**
 * The list controls of a definition's list (suns, moons, nebulae; p114): the entry dropdown,
 * "Add", "Duplicate", "Remove" and "Reset list". A list edit writes the whole array as one undo
 * step (setSkyBoxArray, `skybox.param` on the list's path) and selects the entry it made.
 */
export type ListConfig<T extends object> = {
  list: SkyBoxListKey;
  /** The entry's name in the undo history, eg. 'sun'. */
  name: string;
  /** The dropdown's text for an entry. */
  describe: (entry: T, index: number) => string;
  /** A new entry (at `index`, the end of the list). */
  create: (index: number) => T;
  /** A copy of an entry, placed right after it. */
  duplicate: (entry: T) => T;
  /** Default 'Add'. */
  addTitle?: string;
};

export const hasNoEntries = (list: SkyBoxListKey) => getListEntries(list).length === 0;
const isFull = (list: SkyBoxListKey) => getListEntries(list).length >= LIST_MAX[list];

const selectAndRebuild = (list: SkyBoxListKey, index: number) => {
  selectListEntry(list, index);
  updateDebuggerTab(SKYBOX_TAB_ID, { rebuild: true });
};

const addEntry = <T extends object>(config: ListConfig<T>) => {
  const prev = getListEntries<T>(config.list);
  if (prev.length >= LIST_MAX[config.list]) return;
  selectListEntry(config.list, prev.length);
  setSkyBoxArray(config.list, `add ${config.name}`, prev, [...prev, config.create(prev.length)]);
};

const duplicateEntry = <T extends object>(config: ListConfig<T>) => {
  const prev = getListEntries<T>(config.list);
  const index = getSelectedIndex(config.list);
  if (prev.length >= LIST_MAX[config.list] || !prev[index]) return;
  const copy = config.duplicate(structuredClone(prev[index]));
  selectListEntry(config.list, index + 1);
  setSkyBoxArray(config.list, `duplicate ${config.name}`, prev, [
    ...prev.slice(0, index + 1),
    copy,
    ...prev.slice(index + 1),
  ]);
};

const removeEntry = <T extends object>(config: ListConfig<T>) => {
  const prev = getListEntries<T>(config.list);
  const index = getSelectedIndex(config.list);
  if (!prev[index]) return;
  selectListEntry(config.list, Math.max(0, index - 1));
  setSkyBoxArray(
    config.list,
    `remove ${config.name}`,
    prev,
    prev.filter((_, i) => i !== index)
  );
};

/** Drops every override of the list (the list and its values): back to the definition's
 * (writing a value equal to the definition's removes the override). */
const resetList = (list: SkyBoxListKey) => {
  const active = getActiveSkyBox();
  if (!active) return;
  const registered = getSkyBoxDef(active.sceneId, active.id)?.[list] ?? [];
  setSkyBoxArray(list, `reset ${list}`, getListEntries(list), registered.slice(0, LIST_MAX[list]));
};

/** The dropdown and the Add, Duplicate and Remove buttons. */
export const buildListItems = <T extends object>(config: ListConfig<T>): DebuggerPaneItem[] => {
  const { list } = config;
  const entries = getListEntries<T>(list);
  const selection = {
    index: Math.min(getSelectedIndex(list), Math.max(0, entries.length - 1)),
  };
  return [
    {
      key: 'index',
      target: selection,
      label: config.name[0].toUpperCase() + config.name.slice(1),
      options: entries.length
        ? entries.map((entry, i) => ({ text: config.describe(entry, i), value: i }))
        : [{ text: '(none)', value: 0 }],
      disabled: () => hasNoEntries(list),
      onChange: (value) => selectAndRebuild(list, Number(value)),
    },
    {
      type: 'button',
      title: config.addTitle ?? 'Add',
      disabled: () => isFull(list),
      onClick: () => addEntry(config),
    },
    {
      type: 'button',
      title: 'Duplicate',
      disabled: () => hasNoEntries(list) || isFull(list),
      onClick: () => duplicateEntry(config),
    },
    {
      type: 'button',
      title: 'Remove',
      disabled: () => hasNoEntries(list),
      onClick: () => removeEntry(config),
    },
  ];
};

/** The "Reset <list> list" button: drops the list's overrides, back to the definition's. */
export const buildResetListButton = <T extends object>(
  config: ListConfig<T>
): DebuggerPaneItem => ({
  type: 'button',
  title: `Reset ${config.list} list`,
  onClick: () => resetList(config.list),
});

/** " (off)" for a disabled entry, for the dropdown's text. */
export const offSuffix = (entry: { enabled?: boolean }) =>
  entry.enabled === false ? ' (off)' : '';
