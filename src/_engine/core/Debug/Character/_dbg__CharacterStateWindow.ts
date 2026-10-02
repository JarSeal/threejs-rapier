import { addDebugToast } from '../../../debug/DebuggerGUI';
import { CMP, type TCMP } from '../../../utils/CMP';
import { lsGetItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { llog } from '../../../utils/Logger';
import { getCharacterById } from '../../Character';
import { getPhysGameTime } from '../../PhysicsAPI';
import type { CharacterObject } from '../../Character/CharacterTypes';
import { createSceneMainLooper, deleteSceneMainLooper, getCurrentSceneId } from '../../Scene';
import {
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowCmp,
  registerDraggableWindowSceneTargetResolver,
} from '../../UI/DraggableWindow';
import { getSvgIcon } from '../../UI/icons/SvgIcon';
import styles from './CharacterStateWindow.module.scss';

/**
 * The Character state window: a character's live `data`, split into groups by key prefix (see
 * `CharacterObject.data`). Rows are built once, and each update writes only the values that
 * changed, in open groups only.
 */

// Kept from the legacy tracker window, so saved window positions and sizes still apply
export const CHAR_STATE_WIN_ID = 'characterDataTrackerWindow';
export const getCharacterStateWindowId = (charId: string) => `${CHAR_STATE_WIN_ID}_${charId}`;

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
  lastUpdate: number;
  costSum: number;
  costCount: number;
  costShownAt: number;
  costText: Text;
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

const createRow = (key: string, value: unknown, charId: string): Row => {
  const kind = getRowKind(value);
  const elem = createElem('div', styles.row);
  elem.appendChild(createLabel(key));
  const valueElem = createElem('span', styles.value);
  elem.appendChild(valueElem);
  const format = (kind === 'NUMBER' && NUMBER_FORMATS[key]) || null;
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
  };

  if (kind === 'BOOL') {
    const icon = createElem('span', styles.boolIcon);
    icon.innerHTML = `${getSvgIcon('circleXCutout')}${getSvgIcon('circleCheckCutout')}`;
    valueElem.appendChild(icon);
  } else if (kind === 'NUMBER') {
    row.texts.push(
      createTextCell(valueElem, format ? NUMBER_FORMAT_CELL_CLASSES[format] : styles.num)
    );
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

  // The raw value, refreshed only when hovered
  const note = LATE_KEYS.has(key) ? `\n${LATE_VALUE_NOTE}` : '';
  elem.addEventListener('mouseenter', () => {
    elem.title = `${key}: ${formatRawForTitle(getCharacterById(charId)?.data[key])}${note}`;
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
      }
      return true;
    }
    case 'NUMBER': {
      const next = value as number;
      if (row.format === 'MS_AGO') {
        updateMsAgoRow(row, next, force, flash);
      } else if (force || hasChanged(last[0], next)) {
        if (flash) flashRow(row);
        last[0] = next;
        row.texts[0].nodeValue =
          row.format === 'RAD_DEG' ? formatRadians(next) : formatNumber(next);
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

const buildGroups = (inst: StateWindowInstance, data: Record<string, unknown>) => {
  inst.body.textContent = '';
  const rowsByGroup: Record<GroupId, Row[]> = { state: [], props: [], internal: [] };
  const keys = Object.keys(data);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    rowsByGroup[getGroupId(key)].push(createRow(key, data[key], inst.charId));
  }
  inst.keyCount = keys.length;

  inst.groups = GROUPS.map(({ id, title }) => {
    const details = createElem('details', styles.group) as HTMLDetailsElement;
    const summary = createElem('summary', undefined, `${title} `);
    summary.appendChild(createElem('span', styles.groupCount, `(${rowsByGroup[id].length})`));
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
};

const refreshGroup = (inst: StateWindowInstance, group: Group) => {
  const character = getCharacterById(inst.charId);
  if (!character) return;
  if (!updateGroup(group, character.data, true, false)) buildGroups(inst, character.data);
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

const updateInstance = (inst: StateWindowInstance, data: Record<string, unknown>) => {
  // Keys added or removed: rebuild (rare)
  if (countKeys(data) !== inst.keyCount) {
    buildGroups(inst, data);
    return;
  }
  for (let i = 0; i < inst.groups.length; i++) {
    const group = inst.groups[i];
    if (!group.details.open) continue;
    if (!updateGroup(group, data, false, inst.settings.flash)) {
      // A value changed its shape: rebuild (rare)
      buildGroups(inst, data);
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
  updateInstance(inst, character.data);

  const end = performance.now();
  inst.costSum += end - start;
  inst.costCount++;
  updateCostReadout(inst, end);
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

  const flashToggle = createElem('label', `winSmallLabel ${styles.flashToggle}`);
  flashToggle.title = 'Flash a row when its value changes (not vectors or State numbers)';
  const flashInput = createElem('input') as HTMLInputElement;
  flashInput.type = 'checkbox';
  flashInput.checked = inst.settings.flash;
  flashInput.addEventListener('change', () => {
    inst.settings.flash = flashInput.checked;
    saveSettings(inst.settings);
  });
  flashToggle.appendChild(flashInput);
  flashToggle.appendChild(document.createTextNode('Flash'));
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
    lastUpdate: 0,
    costSum: 0,
    costCount: 0,
    costShownAt: 0,
    costText: document.createTextNode('upd – ms'),
  };

  const rootCmp: TCMP = CMP({
    class: styles.root,
    onRemoveCmp: () => disposeInstance(inst),
  });
  rootCmp.elem.appendChild(createHeader(inst));
  rootCmp.elem.appendChild(inst.body);

  const character = getCharacterById(charId);
  if (!character) {
    inst.body.appendChild(createEmptyState('Character not found (deleted?)'));
    return rootCmp;
  }

  buildGroups(inst, character.data);
  if (sceneId) {
    inst.looperIndex = createSceneMainLooper(createLooper(inst, rootCmp.elem), sceneId, true);
  }
  instances.set(charId, inst);
  return rootCmp;
};

// The window stays open over a scene change when the next scene has a character with the same id
const characterStateWindowTarget = (data?: { [key: string]: unknown }) => {
  const charId = (data as { id?: string } | undefined)?.id;
  return Boolean(charId && getCharacterById(charId));
};

/** Attaches the content function and the scene target resolver to a window (eg. one restored
 * from LS, which has neither). */
export const _registerCharacterStateWindowCmp = (winId: string) => {
  registerDraggableWindowSceneTargetResolver(winId, characterStateWindowTarget);
  registerDraggableWindowCmp(winId, { content: _createCharacterStateWindowContent });
};

/** Opens the character's state window. */
export const _openCharacterStateWindow = (character: CharacterObject) => {
  const winId = getCharacterStateWindowId(character.id);
  registerDraggableWindowSceneTargetResolver(winId, characterStateWindowTarget);
  openDraggableWindow({
    id: winId,
    position: { x: 130, y: 80 },
    size: { w: 460, h: 520 },
    saveToLS: true,
    title: `Character state: ${character.name || `[${character.id}]`}`,
    isDebugWindow: true,
    content: _createCharacterStateWindowContent,
    data: { id: character.id, winId },
    closeOnSceneChange: true,
    // @TODO: Without this the window won't work on the second open (DraggableWindow close vs. remove)
    removeOnClose: true,
  });
};
