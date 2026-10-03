import { addDebugToast } from '../../../debug/DebuggerGUI';
import { CMP, type TCMP } from '../../../utils/CMP';
import { lsGetItem, lsSetItem, lsSubscribe } from '../../../utils/LocalAndSessionStorage';
import { llog } from '../../../utils/Logger';
import { getCharacterById } from '../../Character';
import { getPhysGameTime } from '../../PhysicsAPI';
import type { CharacterObject } from '../../Character/CharacterTypes';
import { createSceneMainLooper, deleteSceneMainLooper, getCurrentSceneId } from '../../Scene';
import {
  getDraggableWindow,
  getKindWindowId,
  openDraggableWindow,
  registerDraggableWindowKind,
  toggleDraggableWindow,
  type OpenDraggableWindowProps,
} from '../../UI/DraggableWindow';
import { getSvgIcon, type SvgIconKey } from '../../UI/icons/SvgIcon';
import {
  acquireCharacterGizmos,
  CHARACTER_GIZMOS,
  isCharacterGizmoAvailable,
  isCharacterGizmosPinned,
  onCharacterGizmoPinsChange,
  releaseCharacterGizmos,
  setCharacterGizmoDepthTest,
  setCharacterGizmoEnabled,
  setCharacterGizmosFrozen,
  setCharacterGizmosPinned,
  setCharacterGizmoVectorScale,
  type CharacterGizmoSet,
} from './_dbg__CharacterGizmos';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from '../_dbg__UndoRedo';
import { getConfigKeyHint, type ConfigKeyHint } from './_dbg__CharacterConfigHints';
import {
  CHAR_CONFIG_LS_KEY,
  clearSavedCharacterConfig,
  getSavedCharacterConfig,
  isSameConfigValue,
  saveCharacterConfig,
} from './_dbg__CharacterConfigOverrides';
import styles from './CharacterStateWindow.module.scss';

/**
 * The Character state window: a character's live `data`, split into groups by key prefix (see
 * `CharacterObject.data`). Rows are built once, and each update writes only the values that
 * changed, in open groups only.
 */

// The windows' kind: one window per character, keyed by its id. Kept from the legacy tracker
// window, so saved window positions and sizes still apply.
export const CHAR_STATE_WIN_ID = 'characterDataTrackerWindow';
export const getCharacterStateWindowId = (charId: string) =>
  getKindWindowId(CHAR_STATE_WIN_ID, charId);

/** Listeners of the state windows' open and close (the Characters tab's row toggles). */
const openStateListeners = new Set<() => void>();
const notifyOpenStateChange = () => {
  for (const listener of openStateListeners) listener();
};

const LS_KEY = 'AEK_charStateWin';
const COST_READOUT_INTERVAL_MS = 250;
const ARRAY_MAX_ITEMS = 8;
const OTHER_MAX_CHARS = 120;
const FLASH_KEYFRAMES: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];
const FLASH_OPTIONS: KeyframeAnimationOptions = { duration: 400, pseudoElement: '::before' };

type GroupId = 'state' | 'props' | 'internal';
const GROUPS: { id: GroupId; title: string }[] = [
  { id: 'state', title: 'State' },
  { id: 'props', title: 'Properties' },
  { id: 'internal', title: 'Internal memory' },
];

/** Per viewer, shared by all character windows: the last used values are the next window's. */
type StateWindowSettings = {
  intervalMs: number;
  flash: boolean;
  groupsOpen: Record<GroupId, boolean>;
};
const DEFAULT_SETTINGS: StateWindowSettings = {
  intervalMs: 0,
  flash: true,
  groupsOpen: { state: true, props: true, internal: false },
};

type RowKind = 'BOOL' | 'NUMBER' | 'STRING' | 'VECTOR' | 'NUM_ARRAY' | 'OTHER';
/** A known number key's display: a `getPhysGameTime()` timestamp, or an angle in radians */
type NumberFormat = 'MS_AGO' | 'RAD_DEG';
type RawValue = number | boolean | string | undefined;
type ConfigValue = number | boolean;
/** A configuration (`_`) row's editor. */
type ConfigEditor = {
  /** The window the row is in (its changed keys and Properties actions) */
  inst: StateWindowInstance;
  hint: ConfigKeyHint;
  /** NUMBER only: the value input (null: a BOOL row's toggle, or a locked key) */
  input: HTMLInputElement | null;
  /** Baked into the body at creation (the controller's `bakedKeys`): shown, never written */
  isLocked: boolean;
  /** The creation-time value (`initialConfig`), undefined when the character wasn't created with
   * this key (or with another type): no marker, no reset */
  initial: ConfigValue | undefined;
  /** Whether the value differs from `initial` (the row is marked and gets a reset button) */
  isChanged: boolean;
};
type Row = {
  key: string;
  kind: RowKind;
  /** NUMBER only: a known key's display (null: the generic number) */
  format: NumberFormat | null;
  elem: HTMLElement;
  /** Whether a raw value change flashes the row (see `rowFlashes`) */
  flashes: boolean;
  /** The flash, created on the first one and restarted after that */
  flashAnim: Animation | null;
  /** The value text nodes (VECTOR: one per component, BOOL: none) */
  texts: Text[];
  /** VECTOR only: the component keys, in the object's key order */
  vecKeys: string[];
  /** The last raw values (per component for vectors and arrays), never object references. MS_AGO
   * also keeps the last shown ms at index 1. */
  last: RawValue[];
  /** A Properties number or boolean row's editor (null: a read-only row) */
  editor: ConfigEditor | null;
};
type Group = { id: GroupId; details: HTMLDetailsElement; rows: Row[] };

type StateWindowInstance = {
  charId: string;
  winId: string;
  sceneId: string | null;
  looperIndex: number;
  isDisposed: boolean;
  body: HTMLElement;
  groups: Group[];
  keyCount: number;
  settings: StateWindowSettings;
  /** Updates are skipped and the snapshot stays on screen (per window, not persisted) */
  isFrozen: boolean;
  /** The character's gizmo set, owned by this window while it lives (null: no character) */
  gizmos: CharacterGizmoSet | null;
  /** Stops the pin button following pin changes made elsewhere (the Characters tab) */
  unsubscribePin: (() => void) | null;
  lastUpdate: number;
  costSum: number;
  costCount: number;
  costShownAt: number;
  costText: Text;
  /** The Properties rows whose value differs from the creation-time one */
  changedKeys: Set<string>;
  /** The Properties group's header actions (built with the groups) */
  configActions: {
    copy: HTMLButtonElement;
    resetAll: HTMLButtonElement;
    changedText: HTMLElement;
  } | null;
  /** The window header's saved count and its clear button (hidden while nothing is saved) */
  savedActions: { wrap: HTMLElement; text: HTMLElement };
  /** Stops following the saved overrides' LS key */
  unsubscribeSaved: (() => void) | null;
};

const instances = new Map<string, StateWindowInstance>();

// Settings

const sanitizeInterval = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const loadSettings = (): StateWindowSettings => {
  let saved: Partial<StateWindowSettings> | null = null;
  try {
    saved = lsGetItem(LS_KEY, {}) as Partial<StateWindowSettings> | null;
  } catch {
    saved = null;
  }
  return {
    intervalMs: sanitizeInterval(saved?.intervalMs),
    flash: typeof saved?.flash === 'boolean' ? saved.flash : DEFAULT_SETTINGS.flash,
    groupsOpen: { ...DEFAULT_SETTINGS.groupsOpen, ...(saved?.groupsOpen || {}) },
  };
};

const saveSettings = (settings: StateWindowSettings) => lsSetItem(LS_KEY, settings);

// Classifying and formatting

/** Readable displays for known keys (any other key gets its type's display) */
const NUMBER_FORMATS: Record<string, NumberFormat> = {
  __jumpTime: 'MS_AGO',
  __isFallingStartTime: 'MS_AGO',
  __isTumblingStartTime: 'MS_AGO',
  __isGettingUpStartTime: 'MS_AGO',
  __locomotionStateStartTime: 'MS_AGO',
  charRotation: 'RAD_DEG',
  _maxWalkableAngle: 'RAD_DEG',
};

/** Values written by an async physics query, so they can trail the other values by a step */
const LATE_VALUE_NOTE = 'Set by an async physics query: can be a physics step behind.';
const LATE_KEYS = new Set([
  'groundNormal',
  'groundIsWalkable',
  'isNearWall',
  '__touchingWallColliders',
]);

const getGroupId = (key: string): GroupId =>
  key.startsWith('__') ? 'internal' : key.startsWith('_') ? 'props' : 'state';

const VECTOR_KEYS = new Set(['x', 'y', 'z', 'w', 'length']);

const getRowKind = (value: unknown): RowKind => {
  if (typeof value === 'boolean') return 'BOOL';
  if (typeof value === 'number') return 'NUMBER';
  if (typeof value === 'string') return 'STRING';
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'number') ? 'NUM_ARRAY' : 'OTHER';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const obj = value as Record<string, unknown>;
    if (keys.length && keys.every((k) => VECTOR_KEYS.has(k) && typeof obj[k] === 'number')) {
      return 'VECTOR';
    }
  }
  return 'OTHER';
};

/** Vectors and State numbers change almost every frame, so they never flash. Everything else
 * changes on an event worth seeing (eg. a one-frame `isGrounded` flip, a stamped timestamp). */
const rowFlashes = (groupId: GroupId, kind: RowKind) =>
  groupId === 'props' || (kind !== 'VECTOR' && !(groupId === 'state' && kind === 'NUMBER'));

/** A cheap per-update check that a row's value still has the shape the row was built for. */
const matchesRowKind = (kind: RowKind, value: unknown) => {
  switch (kind) {
    case 'BOOL':
      return typeof value === 'boolean';
    case 'NUMBER':
      return typeof value === 'number';
    case 'STRING':
      return typeof value === 'string';
    case 'VECTOR':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'NUM_ARRAY':
      return Array.isArray(value);
    default:
      return true;
  }
};

/** `!==`, except that NaN equals NaN (otherwise a NaN value would be rewritten every update). */
const hasChanged = (prev: RawValue, next: RawValue) =>
  prev !== next && (prev === prev || next === next);

const formatNumber = (value: unknown) =>
  typeof value === 'number' ? value.toFixed(3) : String(value);

const RAD_TO_DEG = 180 / Math.PI;
const formatRadians = (value: number) =>
  `${value.toFixed(3)} rad (${(value * RAD_TO_DEG).toFixed(1)}°)`;

const NUMBER_FORMAT_CELL_CLASSES: Record<NumberFormat, string> = {
  MS_AGO: styles.numAgo,
  RAD_DEG: styles.numRad,
};

const formatNumArray = (arr: unknown[]) => {
  const shown = arr.length > ARRAY_MAX_ITEMS ? arr.slice(0, ARRAY_MAX_ITEMS) : arr;
  const more = arr.length - shown.length;
  return `(${arr.length}) ${shown.join(', ')}${more > 0 ? ` … +${more}` : ''}`;
};

const stringifyOther = (value: unknown) => {
  try {
    const str = JSON.stringify(value);
    return str === undefined ? String(value) : str;
  } catch {
    return String(value);
  }
};

const truncate = (str: string, max: number) => (str.length > max ? `${str.slice(0, max)}…` : str);

const formatRawForTitle = (value: unknown) =>
  typeof value === 'object' && value !== null ? stringifyOther(value) : String(value);

// Building

const createElem = (tag: string, className?: string, text?: string) => {
  const elem = document.createElement(tag);
  if (className) elem.className = className;
  if (text !== undefined) elem.textContent = text;
  return elem;
};

const createTextCell = (parent: HTMLElement, className: string) => {
  const cell = createElem('span', className);
  const text = document.createTextNode('');
  cell.appendChild(text);
  parent.appendChild(cell);
  return text;
};

const createLabel = (key: string) => {
  const label = createElem('span', styles.label);
  const prefixLength = key.startsWith('__') ? 2 : key.startsWith('_') ? 1 : 0;
  if (prefixLength)
    label.appendChild(createElem('span', styles.prefix, key.slice(0, prefixLength)));
  label.appendChild(document.createTextNode(key.slice(prefixLength)));
  return label;
};

// Configuration editing

const BAKED_KEY_NOTE =
  'Sized into the colliders at creation. Editing needs a body rebuild (not available yet).';

/**
 * Writes a configuration value to the character's live data, where the controller reads it from
 * its next sub-step, and lets the controller recompute what it derives from it. The one write path
 * of the editors, the resets and undo.
 */
const writeConfig = (character: CharacterObject, key: string, value: number | boolean) => {
  character.data[key] = value;
  character.controller?.config?.onChange(key);
};

/** Shows a row's current value right away (no flash: the user caused the change). A row whose
 * value changed its shape is left to the next update's rebuild. */
const refreshRow = (row: Row, charId: string) => {
  const character = getCharacterById(charId);
  if (character) updateRow(row, character.data[row.key], true, false);
};

/** Writes several configuration values, saves them (only the ones that differ from the
 * creation-time values, so they survive a reload), then shows them in the character's open window
 * (if any). The edits, the resets and undo all write through here. */
const applyConfigValues = (character: CharacterObject, values: Record<string, ConfigValue>) => {
  const keys = Object.keys(values);
  for (let i = 0; i < keys.length; i++) writeConfig(character, keys[i], values[keys[i]]);
  saveCharacterConfig(character, keys);
  const inst = instances.get(character.id);
  const props = inst?.groups.find((group) => group.id === 'props');
  if (!props) return;
  for (const row of props.rows) {
    if (Object.prototype.hasOwnProperty.call(values, row.key)) refreshRow(row, character.id);
  }
};

// Undo/redo

const CONFIG_UNDO_ACTION = 'character.config';
/** One edit (one key), a row reset (one key) or a Reset all (every reset key). Character ids are
 * app-supplied, so they are stable across reloads. */
type ConfigUndoPayload = {
  charId: string;
  prev: Record<string, ConfigValue>;
  next: Record<string, ConfigValue>;
};

/** Writes the values the character still has with the same type (a deleted character, a scene
 * without it or a renamed key is a quiet no-op, so the history pointer still moves). */
const applyConfigUndo = (charId: string, values: Record<string, ConfigValue>) => {
  const character = getCharacterById(charId);
  if (!character) return;
  const writable: Record<string, ConfigValue> = {};
  for (const key of Object.keys(values)) {
    if (typeof character.data[key] === typeof values[key]) writable[key] = values[key];
  }
  applyConfigValues(character, writable);
};

_registerUndoRedoActionHandler<ConfigUndoPayload>(
  CONFIG_UNDO_ACTION,
  {
    undo: ({ charId, prev }) => applyConfigUndo(charId, prev),
    redo: ({ charId, next }) => applyConfigUndo(charId, next),
  },
  'perScene'
);

const getUndoLabel = (character: CharacterObject, action: string) =>
  `Character ${character.name || character.id}: ${action}`;

/** A value for an undo label: numbers to 3 decimals (degrees for a degree editor). */
const formatLabelValue = (editor: ConfigEditor | null, value: ConfigValue) => {
  if (typeof value !== 'number') return String(value);
  const isDeg = editor !== null && isDegreeEditor(editor);
  return `${parseFloat((isDeg ? value * RAD_TO_DEG : value).toFixed(3))}${isDeg ? '°' : ''}`;
};

/** Marks the row when its value differs from the creation-time one. Runs only when the row's raw
 * value is written, so it costs nothing per frame. */
const updateConfigMarker = (row: Row, value: unknown) => {
  const editor = row.editor;
  if (!editor || editor.isLocked || editor.initial === undefined) return;
  const isChanged = !isSameConfigValue(value, editor.initial);
  if (isChanged === editor.isChanged) return;
  editor.isChanged = isChanged;
  row.elem.classList.toggle(styles.isChanged, isChanged);
  const { changedKeys } = editor.inst;
  if (isChanged) changedKeys.add(row.key);
  else changedKeys.delete(row.key);
  renderConfigActions(editor.inst);
};

const renderConfigActions = (inst: StateWindowInstance) => {
  if (!inst.configActions) return;
  const count = inst.changedKeys.size;
  inst.configActions.copy.disabled = count === 0;
  inst.configActions.resetAll.disabled = count === 0;
  inst.configActions.changedText.textContent = count ? `${count} changed` : '';
};

// Saved values (they survive a reload)

const SAVED_NOTE = 'Saved: applied again when the character is created (eg. after a reload).';

/** Marks the rows with a saved value and shows the saved count. Runs on the window's build and on
 * every write to the saved values' LS key (never per frame). */
const renderSavedState = (inst: StateWindowInstance) => {
  if (inst.isDisposed) return;
  const character = getCharacterById(inst.charId);
  const saved = character ? getSavedCharacterConfig(character) : null;
  const props = inst.groups.find((group) => group.id === 'props');
  for (const row of props?.rows ?? []) {
    if (!row.editor || row.editor.isLocked) continue;
    const isSaved = saved !== null && Object.prototype.hasOwnProperty.call(saved, row.key);
    row.elem.classList.toggle(styles.isSaved, isSaved);
  }
  const keys = saved ? Object.keys(saved) : [];
  inst.savedActions.wrap.hidden = keys.length === 0;
  inst.savedActions.text.textContent = `${keys.length} saved`;
  inst.savedActions.text.title = `Saved values (applied on the character's next creation):\n${keys.join('\n')}`;
};

/** The window header's saved count and its clear button. */
const createSavedActions = (charId: string) => {
  const wrap = createElem('span', styles.savedActions);
  wrap.hidden = true;
  const text = createElem('span', styles.savedCount);
  const clear = createIconButton(
    `winSmallIconButton ${styles.headerButton}`,
    'databaseX',
    "Clear this character's saved values (this scene). The live values stay as they are: the code values return the next time the character is created."
  );
  clear.addEventListener('click', () => {
    const character = getCharacterById(charId);
    if (!character) return;
    clearSavedCharacterConfig(character);
    addDebugToast({
      title: 'Saved character values cleared',
      message: `${character.name || `[${character.id}]`}: the code values return on its next creation`,
    });
  });
  wrap.append(text, clear);
  return { wrap, text };
};

/** Whether the row's value is edited in degrees (stored in radians). */
const isDegreeEditor = (editor: ConfigEditor) => editor.hint.deg === true;

/** The input's text for a data value: up to 4 decimals, no trailing zeros. */
const formatInputValue = (editor: ConfigEditor, value: number) =>
  String(parseFloat((isDegreeEditor(editor) ? value * RAD_TO_DEG : value).toFixed(4)));

/** An input value (in the editor's unit) as a data value: clamped to the hint, rounded to 6
 * decimals (no float noise from steps), then in radians for a degree editor. Null when it isn't a
 * finite number. */
const toDataValue = (editor: ConfigEditor, inputValue: number) => {
  if (!Number.isFinite(inputValue)) return null;
  const { min, max } = editor.hint;
  let value = inputValue;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  value = Math.round(value * 1e6) / 1e6;
  return isDegreeEditor(editor) ? value / RAD_TO_DEG : value;
};

/** The input's text as a number: a decimal comma works too, and an empty text is invalid (NaN). */
const parseInputValue = (text: string) => {
  const trimmed = text.trim().replace(',', '.');
  return trimmed ? Number(trimmed) : NaN;
};

/**
 * Writes a finished edit or a row reset and records it for undo, or only shows the current value
 * again (`next` null or unchanged). A value equal to the creation-time one but for float noise is
 * written as that value exactly. Number edits of one key coalesce (eg. a held ArrowUp is one undo
 * step), so their label names the value they started from, which coalescing keeps.
 */
const commitConfigEdit = (row: Row, charId: string, next: ConfigValue | null, isReset = false) => {
  const character = getCharacterById(charId);
  const initial = row.editor?.initial;
  const value = isSameConfigValue(next, initial) ? initial! : next;
  const prev = character?.data[row.key];
  if (
    character &&
    value !== null &&
    typeof prev === typeof value &&
    !isSameConfigValue(prev, value)
  ) {
    const key = row.key;
    const prevValue = prev as ConfigValue;
    applyConfigValues(character, { [key]: value });
    const payload: ConfigUndoPayload = {
      charId,
      prev: { [key]: prevValue },
      next: { [key]: value },
    };
    if (isReset) {
      _recordUndoRedoAction(CONFIG_UNDO_ACTION, getUndoLabel(character, `reset ${key}`), payload);
    } else if (typeof value === 'boolean') {
      _recordUndoRedoAction(
        CONFIG_UNDO_ACTION,
        getUndoLabel(character, `${key} → ${value}`),
        payload
      );
    } else {
      const from = formatLabelValue(row.editor, prevValue);
      _recordOrCoalesceUndoRedoAction(
        CONFIG_UNDO_ACTION,
        getUndoLabel(character, `${key} (from ${from})`),
        payload,
        `${charId}:${key}`
      );
    }
  }
  refreshRow(row, charId);
};

/** Resets every changed Properties row of the window to its creation-time value. */
const resetAllConfig = (inst: StateWindowInstance) => {
  const character = getCharacterById(inst.charId);
  if (!character) return;
  const prev: Record<string, ConfigValue> = {};
  const next: Record<string, ConfigValue> = {};
  for (const key of inst.changedKeys) {
    const initial = character.initialConfig[key];
    const current = character.data[key];
    if (typeof current !== typeof initial) continue;
    if (typeof initial === 'number' || typeof initial === 'boolean') {
      prev[key] = current as ConfigValue;
      next[key] = initial;
    }
  }
  const count = Object.keys(next).length;
  if (!count) return;
  applyConfigValues(character, next);
  _recordUndoRedoAction<ConfigUndoPayload>(
    CONFIG_UNDO_ACTION,
    getUndoLabel(character, `reset all (${count})`),
    { charId: character.id, prev, next }
  );
};

// Copy changes

/** The configuration keys whose live value differs from the creation-time one, in the creation
 * order (a controller's defaults first, eg. createDynamicCharacter's). Read from the data, not the
 * markers, so it is right whatever groups are open. Baked keys are left out: they can't be edited
 * (and would need the visual resized too). */
const getChangedConfig = (character: CharacterObject) => {
  const baked = character.controller?.config?.bakedKeys;
  const changed: [string, ConfigValue][] = [];
  for (const key of Object.keys(character.initialConfig)) {
    if (baked?.has(key)) continue;
    const initial = character.initialConfig[key];
    const current = character.data[key];
    if (typeof current !== 'number' && typeof current !== 'boolean') continue;
    if (typeof current === typeof initial && !isSameConfigValue(current, initial)) {
      changed.push([key, current]);
    }
  }
  return changed;
};

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/** A `charData` snippet (an object literal) of the changed keys. Numbers are rounded to 4
 * decimals, except radians: they are written in full (4 decimals would move them by up to 0.003°),
 * with their degrees in a comment. */
const formatConfigSnippet = (changed: [string, ConfigValue][]) => {
  const lines = changed.map(([key, value]) => {
    const prop = IDENTIFIER_RE.test(key) ? key : JSON.stringify(key);
    if (typeof value !== 'number') return `  ${prop}: ${value},`;
    if (getConfigKeyHint(key).deg || NUMBER_FORMATS[key] === 'RAD_DEG') {
      return `  ${prop}: ${value}, // ${(value * RAD_TO_DEG).toFixed(1)}°`;
    }
    return `  ${prop}: ${parseFloat(value.toFixed(4))},`;
  });
  return `{\n${lines.join('\n')}\n}`;
};

/** Copies the changed configuration as a `charData` snippet, to make the tuning permanent in the
 * scene's code. Logs it when the clipboard fails. */
const copyConfigChanges = async (charId: string) => {
  const character = getCharacterById(charId);
  if (!character) return;
  const name = character.name || `[${character.id}]`;
  const changed = getChangedConfig(character);
  if (!changed.length) {
    addDebugToast({ title: 'No changes to copy', message: name });
    return;
  }
  const snippet = formatConfigSnippet(changed);
  const count = `${changed.length} ${changed.length === 1 ? 'key' : 'keys'}`;
  try {
    await navigator.clipboard.writeText(snippet);
    addDebugToast({
      title: 'Character changes copied',
      message: `${name}: ${count}, as charData overrides`,
    });
  } catch {
    llog(`CHARACTER CONFIG CHANGES (${name}, charData overrides):`, snippet);
    addDebugToast({
      type: 'warning',
      title: 'Copy failed',
      message: 'The clipboard is not available: the changes were logged to the console instead',
    });
  }
};

/** Keys pressed in an editor: only their keyups are kept from the key bindings, so a key held
 * down before the editor got the focus is still released. */
const editorKeysDown = new Set<string>();
const isFunctionKey = (key: string) => /^F\d{1,2}$/.test(key);

/** Keys typed into an editor never reach the game's key bindings on `window` (eg. the arrow keys
 * that move a character, or `h` toggling the drawer). The function keys (the debug keys) do. */
const isolateEditorKeys = (elem: HTMLElement) => {
  elem.addEventListener('keydown', (e) => {
    if (isFunctionKey(e.key)) return;
    editorKeysDown.add(e.key);
    e.stopPropagation();
  });
  elem.addEventListener('keyup', (e) => {
    if (editorKeysDown.delete(e.key)) e.stopPropagation();
  });
};

/** A number row's input: a text input, so the value reads like the rest of the window whatever
 * the browser's locale (a number input shows a decimal comma in some). `change` (Enter or blur)
 * commits, ArrowUp/ArrowDown step (Shift ×10) and commit, Escape shows the current value again.
 * The looper leaves it alone while it has the focus. */
const createNumberInput = (row: Row, editor: ConfigEditor, charId: string) => {
  const input = createElem('input', styles.configInput) as HTMLInputElement;
  input.type = 'text';
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.spellcheck = false;
  isolateEditorKeys(input);
  input.addEventListener('change', () =>
    commitConfigEdit(row, charId, toDataValue(editor, parseInputValue(input.value)))
  );
  input.addEventListener('blur', () => refreshRow(row, charId));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const current = getCharacterById(charId)?.data[row.key];
      if (typeof current !== 'number') return;
      const shown = isDegreeEditor(editor) ? current * RAD_TO_DEG : current;
      const step = editor.hint.step * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      commitConfigEdit(row, charId, toDataValue(editor, shown + step));
    } else if (e.key === 'Enter') {
      // Commits (the change event) and hands the keys back to the game
      input.blur();
    } else if (e.key === 'Escape') {
      refreshRow(row, charId);
      input.blur();
    }
  });
  return input;
};

/** A boolean row's toggle: the true/false icon as a button. It never takes the focus, so a later
 * Space or Enter (eg. a jump) can't toggle it again. */
const createBoolButton = (row: Row, charId: string) => {
  const button = createElem('button', `${styles.boolIcon} ${styles.boolButton}`);
  button.setAttribute('type', 'button');
  button.addEventListener('mousedown', (e) => e.preventDefault());
  isolateEditorKeys(button);
  button.addEventListener('click', () => {
    const current = getCharacterById(charId)?.data[row.key];
    if (typeof current === 'boolean') commitConfigEdit(row, charId, !current);
  });
  return button;
};

/** A small icon button that never takes the focus (so a later Space or Enter can't press it). */
const createIconButton = (className: string, icon: SvgIconKey, title: string) => {
  const button = createElem('button', className) as HTMLButtonElement;
  button.setAttribute('type', 'button');
  button.tabIndex = -1;
  button.innerHTML = getSvgIcon(icon);
  button.title = title;
  button.addEventListener('mousedown', (e) => e.preventDefault());
  return button;
};

/** The row's reset button, shown while the value differs from the creation-time one. */
const createResetButton = (row: Row, editor: ConfigEditor, charId: string) => {
  const initial = editor.initial!;
  const shown =
    typeof initial === 'number'
      ? isDegreeEditor(editor)
        ? `${formatInputValue(editor, initial)}°`
        : formatInputValue(editor, initial)
      : String(initial);
  const button = createIconButton(
    styles.resetButton,
    'arrowCounterClockwise',
    `Reset to the creation-time value (${shown})`
  );
  button.addEventListener('click', () => commitConfigEdit(row, charId, initial, true));
  return button;
};

/** A Properties number or boolean row gets an editor (any controller's `_` keys), locked when the
 * controller bakes the key into the body at creation. */
const getConfigEditor = (
  key: string,
  kind: RowKind,
  format: NumberFormat | null,
  character: CharacterObject,
  inst: StateWindowInstance
): ConfigEditor | null => {
  if (getGroupId(key) !== 'props') return null;
  if (kind !== 'BOOL' && (kind !== 'NUMBER' || format === 'MS_AGO')) return null;
  const isLocked = character.controller?.config?.bakedKeys.has(key) ?? false;
  const initial = character.initialConfig[key];
  const hasInitial = typeof initial === (kind === 'BOOL' ? 'boolean' : 'number');
  return {
    inst,
    hint: getConfigKeyHint(key),
    input: null,
    isLocked,
    initial: hasInitial ? (initial as ConfigValue) : undefined,
    isChanged: false,
  };
};

const createRow = (
  key: string,
  value: unknown,
  character: CharacterObject,
  inst: StateWindowInstance
): Row => {
  const charId = character.id;
  const kind = getRowKind(value);
  const elem = createElem('div', styles.row);
  elem.appendChild(createLabel(key));
  const valueElem = createElem('span', styles.value);
  elem.appendChild(valueElem);
  const format = (kind === 'NUMBER' && NUMBER_FORMATS[key]) || null;
  const editor = getConfigEditor(key, kind, format, character, inst);
  const row: Row = {
    key,
    kind,
    format,
    elem,
    flashes: rowFlashes(getGroupId(key), kind),
    flashAnim: null,
    texts: [],
    vecKeys: [],
    last: [],
    editor,
  };

  // Fixed slots first, so the values line up whether a row is saved or changed or not
  if (editor && !editor.isLocked) {
    const savedDot = createElem('span', styles.savedDot);
    savedDot.title = SAVED_NOTE;
    valueElem.appendChild(savedDot);
    if (editor.initial !== undefined) {
      valueElem.appendChild(createResetButton(row, editor, charId));
    } else {
      valueElem.appendChild(createElem('span', styles.resetButton));
    }
  }

  if (kind === 'BOOL') {
    const icon =
      editor && !editor.isLocked
        ? createBoolButton(row, charId)
        : createElem('span', styles.boolIcon);
    icon.innerHTML = `${getSvgIcon('xBold')}${getSvgIcon('circleCheckCutout')}`;
    valueElem.appendChild(icon);
  } else if (kind === 'NUMBER') {
    if (editor && !editor.isLocked) {
      // A degree editor keeps the radians as text beside it
      if (format === 'RAD_DEG') row.texts.push(createTextCell(valueElem, styles.numRadShort));
      editor.input = createNumberInput(row, editor, charId);
      valueElem.appendChild(editor.input);
    } else {
      if (editor) {
        const lock = createElem('span', styles.lockIcon);
        lock.innerHTML = getSvgIcon('lock');
        lock.title = BAKED_KEY_NOTE;
        valueElem.appendChild(lock);
      }
      row.texts.push(
        createTextCell(valueElem, format ? NUMBER_FORMAT_CELL_CLASSES[format] : styles.num)
      );
    }
  } else if (kind === 'VECTOR') {
    row.vecKeys = Object.keys(value as object);
    for (let i = 0; i < row.vecKeys.length; i++) {
      const vecKey = row.vecKeys[i];
      const comp = createElem('span', styles.vecComp);
      const compLabel = vecKey === 'length' ? 'len' : vecKey;
      comp.appendChild(createElem('span', styles.vecLabel, compLabel));
      row.texts.push(createTextCell(comp, styles.num));
      valueElem.appendChild(comp);
    }
  } else {
    row.texts.push(createTextCell(valueElem, styles.text));
  }
  // A fixed-width unit slot, so the editors and the toggles line up
  if (editor) {
    valueElem.appendChild(createElem('span', styles.unit, editor.hint.unit ?? ''));
  }

  // The raw value, refreshed only when hovered
  const notes = [
    LATE_KEYS.has(key) ? LATE_VALUE_NOTE : '',
    editor?.hint.note ?? '',
    editor?.isLocked ? BAKED_KEY_NOTE : '',
  ]
    .filter(Boolean)
    .map((note) => `\n${note}`)
    .join('');
  elem.addEventListener('mouseenter', () => {
    elem.title = `${key}: ${formatRawForTitle(getCharacterById(charId)?.data[key])}${notes}`;
  });

  return row;
};

const createEmptyState = (text: string) => createElem('div', styles.emptyState, text);

// Updating

/** Restarts the row's flash (no class toggling, no forced reflow, so it is safe every frame). */
const flashRow = (row: Row) => {
  if (!row.flashAnim) {
    row.flashAnim = row.elem.animate(FLASH_KEYFRAMES, FLASH_OPTIONS);
    return;
  }
  row.flashAnim.currentTime = 0;
  row.flashAnim.play();
};

/** A timestamp row: the age changes with the clock, so it is checked on every update (shown in
 * whole ms, written only when that changes). 0 = unset. */
const updateMsAgoRow = (row: Row, value: number, force: boolean, flash: boolean) => {
  const last = row.last;
  if (flash && hasChanged(last[0], value)) flashRow(row);
  last[0] = value;
  const shown = value ? Math.max(0, Math.round(getPhysGameTime() - value)) : -1;
  if (!force && shown === last[1]) return;
  last[1] = shown;
  row.texts[0].nodeValue = shown < 0 ? '—' : `${shown} ms ago`;
};

/** Writes the row's value if it changed since the last write (`force`: always, never flashes).
 * Returns false when the value no longer has the row's shape (the group needs a rebuild). */
const updateRow = (row: Row, value: unknown, force: boolean, flashOn: boolean) => {
  if (!matchesRowKind(row.kind, value)) return false;
  const last = row.last;
  const flash = flashOn && row.flashes && !force;

  switch (row.kind) {
    case 'BOOL': {
      const next = value as boolean;
      if (force || last[0] !== next) {
        if (flash) flashRow(row);
        last[0] = next;
        row.elem.classList.toggle(styles.isTrue, next);
        updateConfigMarker(row, next);
      }
      return true;
    }
    case 'NUMBER': {
      const next = value as number;
      if (row.format === 'MS_AGO') {
        updateMsAgoRow(row, next, force, flash);
      } else if (force || hasChanged(last[0], next)) {
        const input = row.editor?.input;
        // Never overwritten while being typed in (`last` stays, so it is written after the blur)
        if (input && !force && input === document.activeElement) return true;
        if (flash) flashRow(row);
        last[0] = next;
        if (input) {
          if (row.format === 'RAD_DEG') row.texts[0].nodeValue = `${next.toFixed(3)} rad`;
          input.value = formatInputValue(row.editor!, next);
          updateConfigMarker(row, next);
        } else {
          row.texts[0].nodeValue =
            row.format === 'RAD_DEG' ? formatRadians(next) : formatNumber(next);
        }
      }
      return true;
    }
    case 'STRING': {
      const next = value as string;
      if (force || last[0] !== next) {
        if (flash) flashRow(row);
        last[0] = next;
        row.texts[0].nodeValue = next;
      }
      return true;
    }
    case 'VECTOR': {
      // Mutated in place: compare the components, never the object reference
      const obj = value as Record<string, RawValue>;
      let changed = false;
      for (let i = 0; i < row.vecKeys.length; i++) {
        const next = obj[row.vecKeys[i]];
        if (force || hasChanged(last[i], next)) {
          changed = true;
          last[i] = next;
          row.texts[i].nodeValue = formatNumber(next);
        }
      }
      if (flash && changed) flashRow(row);
      return true;
    }
    case 'NUM_ARRAY': {
      const arr = value as RawValue[];
      let changed = force || arr.length !== last.length;
      for (let i = 0; !changed && i < arr.length; i++) changed = hasChanged(last[i], arr[i]);
      if (changed) {
        if (flash) flashRow(row);
        last.length = arr.length;
        for (let i = 0; i < arr.length; i++) last[i] = arr[i];
        row.texts[0].nodeValue = formatNumArray(arr);
      }
      return true;
    }
    default: {
      const next = stringifyOther(value);
      if (force || last[0] !== next) {
        if (flash) flashRow(row);
        last[0] = next;
        row.texts[0].nodeValue = truncate(next, OTHER_MAX_CHARS);
      }
      return true;
    }
  }
};

/** Updates an open group's rows. Returns false when a row needs a rebuild. */
const updateGroup = (
  group: Group,
  data: Record<string, unknown>,
  force: boolean,
  flash: boolean
) => {
  const rows = group.rows;
  for (let i = 0; i < rows.length; i++) {
    if (!updateRow(rows[i], data[rows[i].key], force, flash)) return false;
  }
  return true;
};

const countKeys = (data: Record<string, unknown>) => {
  let count = 0;
  for (const key in data) if (Object.prototype.hasOwnProperty.call(data, key)) count++;
  return count;
};

const buildGroups = (inst: StateWindowInstance, character: CharacterObject) => {
  const data = character.data;
  inst.body.textContent = '';
  inst.changedKeys.clear();
  inst.configActions = null;
  const rowsByGroup: Record<GroupId, Row[]> = { state: [], props: [], internal: [] };
  const keys = Object.keys(data);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    rowsByGroup[getGroupId(key)].push(createRow(key, data[key], character, inst));
  }
  inst.keyCount = keys.length;

  inst.groups = GROUPS.map(({ id, title }) => {
    const details = createElem('details', styles.group) as HTMLDetailsElement;
    const summary = createElem('summary', undefined, `${title} `);
    summary.appendChild(createElem('span', styles.groupCount, `(${rowsByGroup[id].length})`));
    if (id === 'props') summary.appendChild(createConfigActions(inst));
    details.appendChild(summary);
    const rowsElem = createElem('div');
    for (const row of rowsByGroup[id]) rowsElem.appendChild(row.elem);
    details.appendChild(rowsElem);
    details.open = inst.settings.groupsOpen[id];
    inst.body.appendChild(details);

    const group: Group = { id, details, rows: rowsByGroup[id] };
    details.addEventListener('toggle', () => {
      if (inst.settings.groupsOpen[id] !== details.open) {
        inst.settings.groupsOpen[id] = details.open;
        saveSettings(inst.settings);
      }
      // Refreshed right away, so an opened group never shows stale values until the next tick.
      // While frozen it keeps the freeze-time values (`setFrozen` filled every group).
      if (details.open && !inst.isFrozen) refreshGroup(inst, group);
    });
    return group;
  });

  for (const group of inst.groups) updateGroup(group, data, true, false);
  renderConfigActions(inst);
  renderSavedState(inst);
};

/** The Properties header's actions: the changed count, "Copy changes" and "Reset all". Shown while
 * the group is open (the markers are only up to date then). */
const createConfigActions = (inst: StateWindowInstance) => {
  const actions = createElem('span', styles.groupActions);
  // A click in the summary would toggle the group
  actions.addEventListener('click', (e) => e.preventDefault());
  const changedText = createElem('span', styles.changedCount);
  const resetAll = createIconButton(
    `winSmallIconButton ${styles.groupActionButton}`,
    'arrowCounterClockwise',
    'Reset all: every changed value back to its creation-time value'
  );
  resetAll.addEventListener('click', () => resetAllConfig(inst));
  const copy = createIconButton(
    `winSmallIconButton ${styles.groupActionButton}`,
    'fileAsterix',
    'Copy changes: the changed values as a charData snippet, to paste into the scene code'
  );
  copy.addEventListener('click', () => void copyConfigChanges(inst.charId));
  actions.append(changedText, copy, resetAll);
  inst.configActions = { copy, resetAll, changedText };
  return actions;
};

const refreshGroup = (inst: StateWindowInstance, group: Group) => {
  const character = getCharacterById(inst.charId);
  if (!character) return;
  if (!updateGroup(group, character.data, true, false)) buildGroups(inst, character);
};

/** Freezing first fills every group, closed ones too, so a group opened while frozen shows the
 * same moment. Unfreezing refreshes the open groups without flashing everything since the freeze. */
const setFrozen = (inst: StateWindowInstance, isFrozen: boolean) => {
  if (inst.isFrozen === isFrozen) return;
  if (!inst.isDisposed) {
    for (const group of inst.groups) {
      if (isFrozen || group.details.open) refreshGroup(inst, group);
    }
  }
  inst.isFrozen = isFrozen;
  inst.lastUpdate = performance.now();
  // The gizmos hold the same moment as the table
  if (inst.gizmos) setCharacterGizmosFrozen(inst.gizmos, isFrozen);
};

/** Copies the character's live data (also while frozen). Logs it when the clipboard fails. */
const copyDataAsJson = async (charId: string) => {
  const character = getCharacterById(charId);
  if (!character) return;
  const json = JSON.stringify(character.data, null, 2);
  const name = character.name || `[${character.id}]`;
  try {
    await navigator.clipboard.writeText(json);
    addDebugToast({ title: 'Character data copied', message: name });
  } catch {
    llog(`CHARACTER DATA (${name}):`, json);
    addDebugToast({
      type: 'warning',
      title: 'Copy failed',
      message: 'The clipboard is not available: the data was logged to the console instead',
    });
  }
};

const disposeInstance = (inst: StateWindowInstance) => {
  inst.isDisposed = true;
  if (inst.looperIndex > -1) {
    deleteSceneMainLooper(inst.looperIndex, inst.sceneId || undefined, true);
    inst.looperIndex = -1;
  }
  inst.unsubscribePin?.();
  inst.unsubscribePin = null;
  inst.unsubscribeSaved?.();
  inst.unsubscribeSaved = null;
  if (inst.gizmos) {
    releaseCharacterGizmos(inst.gizmos, inst);
    inst.gizmos = null;
  }
  // A rebuilt window's new instance may already be registered under the same character
  if (instances.get(inst.charId) === inst) instances.delete(inst.charId);
};

/** Disposes from inside the looper. Deferred, so the late loopers array isn't replaced while it
 * is being iterated (that would skip the next looper for a frame). */
const disposeFromLooper = (inst: StateWindowInstance) => {
  inst.isDisposed = true;
  queueMicrotask(() => disposeInstance(inst));
};

const showCharacterNotFound = (inst: StateWindowInstance) => {
  inst.groups = [];
  inst.body.textContent = '';
  inst.body.appendChild(createEmptyState('Character not found (deleted?)'));
  disposeFromLooper(inst);
};

const updateInstance = (inst: StateWindowInstance, character: CharacterObject) => {
  const data = character.data;
  // Keys added or removed: rebuild (rare)
  if (countKeys(data) !== inst.keyCount) {
    buildGroups(inst, character);
    return;
  }
  for (let i = 0; i < inst.groups.length; i++) {
    const group = inst.groups[i];
    if (!group.details.open) continue;
    if (!updateGroup(group, data, false, inst.settings.flash)) {
      // A value changed its shape: rebuild (rare)
      buildGroups(inst, character);
      return;
    }
  }
};

const updateCostReadout = (inst: StateWindowInstance, now: number) => {
  if (now - inst.costShownAt < COST_READOUT_INTERVAL_MS) return;
  inst.costShownAt = now;
  if (!inst.costCount) return;
  inst.costText.nodeValue = `upd ${(inst.costSum / inst.costCount).toFixed(3)} ms`;
  inst.costSum = 0;
  inst.costCount = 0;
};

/** Runs on every rendered frame, also while the app is paused (a scene main late looper). */
const createLooper = (inst: StateWindowInstance, rootElem: HTMLElement) => () => {
  if (inst.isDisposed) return;
  // Safety net for a close path that detaches the DOM without removing the CMP
  if (!rootElem.isConnected) {
    disposeFromLooper(inst);
    return;
  }
  if (inst.isFrozen || getDraggableWindow(inst.winId)?.isCollapsed) return;

  const start = performance.now();
  if (inst.settings.intervalMs > 0 && start - inst.lastUpdate < inst.settings.intervalMs) return;
  inst.lastUpdate = start;

  const character = getCharacterById(inst.charId);
  if (!character) {
    showCharacterNotFound(inst);
    return;
  }
  updateInstance(inst, character);

  const end = performance.now();
  inst.costSum += end - start;
  inst.costCount++;
  updateCostReadout(inst, end);
};

/** A compact checkbox label (the header rows' toggles). */
const createToggle = (
  text: string,
  title: string,
  checked: boolean,
  onChange: (checked: boolean) => void
) => {
  const label = createElem('label', `winSmallLabel ${styles.toggle}`);
  label.title = title;
  const input = createElem('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  label.appendChild(input);
  label.appendChild(document.createTextNode(text));
  return label;
};

/** The pin: the gizmos stay after the window closes. Also set from the Characters tab. */
const createPinButton = (inst: StateWindowInstance) => {
  const button = createElem('button', `winSmallIconButton ${styles.headerButton}`);
  button.innerHTML = getSvgIcon('pin');
  const render = () => {
    const isPinned = isCharacterGizmosPinned(inst.charId);
    button.title = isPinned
      ? 'Unpin the gizmos (they go when this window closes)'
      : 'Pin the gizmos (they stay after this window closes, until unpinned here or in the Characters tab)';
    button.classList.toggle('current', isPinned);
    button.setAttribute('aria-pressed', String(isPinned));
  };
  render();
  button.addEventListener('click', () =>
    setCharacterGizmosPinned(inst.charId, !isCharacterGizmosPinned(inst.charId))
  );
  inst.unsubscribePin = onCharacterGizmoPinsChange(render);
  return button;
};

/** The gizmo toggles, the depth test, the vector scale and the pin. Wraps on a narrow window. */
const createGizmoRow = (inst: StateWindowInstance, gizmos: CharacterGizmoSet) => {
  const row = createElem('div', styles.gizmoRow);
  row.appendChild(createElem('span', 'winSmallLabel', 'Gizmos:'));

  for (const { id, label, title, isLate } of CHARACTER_GIZMOS) {
    const toggle = createToggle(
      label,
      isLate ? `${title}\n${LATE_VALUE_NOTE}` : title,
      gizmos.settings.enabled[id],
      (checked) => setCharacterGizmoEnabled(gizmos, id, checked)
    );
    if (!isCharacterGizmoAvailable(id)) {
      (toggle.firstChild as HTMLInputElement).disabled = true;
      toggle.classList.add(styles.isDisabled);
    }
    row.appendChild(toggle);
  }

  row.appendChild(createElem('span', styles.rowSeparator));

  row.appendChild(
    createToggle(
      'Depth',
      'Hide the gizmos behind geometry (off: drawn on top of everything)',
      gizmos.settings.depthTest,
      (checked) => setCharacterGizmoDepthTest(gizmos, checked)
    )
  );

  const scaleLabel = createElem('label', `winSmallLabel ${styles.toggle}`);
  scaleLabel.title = "The velocity arrows' length per m/s (m)";
  scaleLabel.appendChild(document.createTextNode('Scale'));
  const scaleInput = createElem('input', styles.scaleInput) as HTMLInputElement;
  scaleInput.type = 'number';
  scaleInput.min = '0.01';
  scaleInput.step = '0.05';
  scaleInput.value = String(gizmos.settings.vectorScale);
  scaleInput.addEventListener('input', () => {
    // An emptied or invalid input keeps the last valid scale
    if (Number(scaleInput.value) > 0) setCharacterGizmoVectorScale(gizmos, scaleInput.value);
  });
  // Shows the value in use once editing is done
  scaleInput.addEventListener(
    'change',
    () => (scaleInput.value = String(gizmos.settings.vectorScale))
  );
  scaleLabel.appendChild(scaleInput);
  row.appendChild(scaleLabel);

  row.appendChild(createElem('span', styles.rowSeparator));
  row.appendChild(createPinButton(inst));

  return row;
};

const createHeader = (inst: StateWindowInstance) => {
  const header = createElem('div', styles.header);

  header.appendChild(createElem('span', 'winSmallLabel', 'Interval'));
  const input = createElem('input', styles.intervalInput) as HTMLInputElement;
  input.type = 'number';
  input.min = '0';
  input.step = '10';
  input.value = String(inst.settings.intervalMs);
  input.title = 'Update interval in ms (0 = every rendered frame)';
  input.addEventListener('input', () => {
    const intervalMs = sanitizeInterval(input.value);
    if (intervalMs === inst.settings.intervalMs) return;
    inst.settings.intervalMs = intervalMs;
    saveSettings(inst.settings);
  });
  // Shows the clamped value once editing is done (eg. an emptied or negative input)
  input.addEventListener('change', () => (input.value = String(inst.settings.intervalMs)));
  header.appendChild(input);
  header.appendChild(createElem('span', 'winSmallLabel', 'ms'));

  const flashToggle = createToggle(
    'Flash',
    'Flash a row when its value changes (not vectors or State numbers)',
    inst.settings.flash,
    (checked) => {
      inst.settings.flash = checked;
      saveSettings(inst.settings);
    }
  );
  flashToggle.classList.add(styles.flashToggle);
  header.appendChild(flashToggle);

  const freezeButton = createElem('button', `winSmallIconButton ${styles.headerButton}`);
  const frozenBadge = createElem('span', styles.frozenBadge, 'FROZEN');
  frozenBadge.hidden = true;
  const renderFreezeButton = () => {
    freezeButton.innerHTML = getSvgIcon(inst.isFrozen ? 'playFill' : 'pause');
    freezeButton.title = inst.isFrozen
      ? 'Resume updates'
      : 'Freeze the view (keeps the current values on screen)';
    freezeButton.classList.toggle('current', inst.isFrozen);
    frozenBadge.hidden = !inst.isFrozen;
  };
  renderFreezeButton();
  freezeButton.addEventListener('click', () => {
    setFrozen(inst, !inst.isFrozen);
    renderFreezeButton();
  });
  header.appendChild(freezeButton);

  const copyButton = createElem('button', `winSmallIconButton ${styles.headerButton}`);
  copyButton.innerHTML = getSvgIcon('fileCode');
  copyButton.title = "Copy the character's data as JSON (the live data, also while frozen)";
  copyButton.addEventListener('click', () => void copyDataAsJson(inst.charId));
  header.appendChild(copyButton);

  header.appendChild(inst.savedActions.wrap);
  header.appendChild(frozenBadge);

  const cost = createElem('span', styles.costReadout);
  cost.title = 'Average cost of one update of this window';
  cost.appendChild(inst.costText);
  header.appendChild(cost);

  return header;
};

// Public (debug module) API

/** The window's content function: rebuilds the whole window for `winData.id`'s character. */
export const _createCharacterStateWindowContent = (winData?: { [key: string]: unknown }) => {
  const charId = String((winData as { id?: string } | undefined)?.id ?? '');
  const prevInst = instances.get(charId);
  if (prevInst) disposeInstance(prevInst);

  const sceneId = getCurrentSceneId();
  const inst: StateWindowInstance = {
    charId,
    winId: getCharacterStateWindowId(charId),
    sceneId,
    looperIndex: -1,
    isDisposed: false,
    body: createElem('div'),
    groups: [],
    keyCount: 0,
    settings: loadSettings(),
    isFrozen: false,
    gizmos: null,
    unsubscribePin: null,
    lastUpdate: 0,
    costSum: 0,
    costCount: 0,
    costShownAt: 0,
    costText: document.createTextNode('upd – ms'),
    changedKeys: new Set(),
    configActions: null,
    savedActions: createSavedActions(charId),
    unsubscribeSaved: null,
  };

  const rootCmp: TCMP = CMP({
    class: styles.root,
    onRemoveCmp: () => disposeInstance(inst),
  });
  const headerRows = createElem('div', styles.headerRows);
  headerRows.appendChild(createHeader(inst));
  rootCmp.elem.appendChild(headerRows);
  rootCmp.elem.appendChild(inst.body);

  const character = getCharacterById(charId);
  if (!character) {
    inst.body.appendChild(createEmptyState('Character not found (deleted?)'));
    return rootCmp;
  }

  inst.gizmos = acquireCharacterGizmos(charId, inst);
  if (inst.gizmos) headerRows.appendChild(createGizmoRow(inst, inst.gizmos));
  buildGroups(inst, character);
  // Saves from this window, the Characters tab's clear button and undo all write through LS
  inst.unsubscribeSaved = lsSubscribe(CHAR_CONFIG_LS_KEY, () => renderSavedState(inst));
  if (sceneId) {
    inst.looperIndex = createSceneMainLooper(createLooper(inst, rootCmp.elem), sceneId, true);
  }
  instances.set(charId, inst);
  // The content is built before the window state is open: notify after it
  queueMicrotask(notifyOpenStateChange);
  return rootCmp;
};

registerDraggableWindowKind(CHAR_STATE_WIN_ID, {
  content: _createCharacterStateWindowContent,
  onClose: notifyOpenStateChange,
  // The window stays open over a scene change when the next scene has a character with the same
  // id
  sceneTargetResolver: (data) => {
    const charId = (data as { id?: string } | undefined)?.id;
    return Boolean(charId && getCharacterById(charId));
  },
});

const getStateWindowProps = (character: CharacterObject): OpenDraggableWindowProps => ({
  id: getCharacterStateWindowId(character.id),
  kind: CHAR_STATE_WIN_ID,
  position: { x: 130, y: 80 },
  size: { w: 460, h: 520 },
  saveToLS: true,
  title: `Character state: ${character.name || `[${character.id}]`}`,
  isDebugWindow: true,
  data: { id: character.id },
  closeOnSceneChange: true,
});

/** Opens the character's state window (or brings it to the front). */
export const _openCharacterStateWindow = (character: CharacterObject) => {
  openDraggableWindow(getStateWindowProps(character));
};

/** The list row toggle: opens the character's state window, brings it to the front, or closes
 * it when on top. */
export const _toggleCharacterStateWindow = (character: CharacterObject) => {
  toggleDraggableWindow(getStateWindowProps(character));
};

export const isCharacterStateWindowOpen = (charId: string) =>
  Boolean(getDraggableWindow(getCharacterStateWindowId(charId))?.isOpen);

/** Calls `listener` when a state window opens or closes. Returns the unsubscriber. */
export const onCharacterStateWindowsChange = (listener: () => void) => {
  openStateListeners.add(listener);
  return () => {
    openStateListeners.delete(listener);
  };
};
