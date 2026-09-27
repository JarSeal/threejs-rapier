import * as THREE from 'three/webgpu';
import { getConfig } from '../Config';
import { getCurrentSceneId } from '../Scene';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { lerror, lwarn } from '../../utils/Logger';
import type {
  UndoRedoActionHandler,
  UndoRedoClearScope,
  UndoRedoEntry,
  UndoRedoHistoryState,
} from '../../debug/UndoRedo';

/** The structure of 'AEK_debugUndoRedo' in LocalStorage */
type UndoRedoLSData = {
  [sceneId: string]: UndoRedoHistoryState;
};

const LS_KEY = 'AEK_debugUndoRedo';
/** Bucket for actions recorded while no scene is current. */
const GLOBAL_BUCKET_ID = '_global';
const DEFAULT_HISTORY_SIZE = 50;

let state: UndoRedoLSData = {};
const actionHandlers = new Map<string, UndoRedoActionHandler>();

const getHistorySize = () => Math.max(1, getConfig().undoRedo?.historySize ?? DEFAULT_HISTORY_SIZE);

const getBucketId = () => getCurrentSceneId() ?? GLOBAL_BUCKET_ID;

const getBucket = () => {
  const bucketId = getBucketId();
  if (!state[bucketId]) state[bucketId] = { entries: [], pointer: -1 };
  return state[bucketId];
};

const persist = () => {
  if (!Object.keys(state).length) {
    lsRemoveItem(LS_KEY);
    return;
  }
  lsSetItem(LS_KEY, state);
};

export const _initUndoRedo = () => {
  state = lsGetItem(LS_KEY, {}) as UndoRedoLSData;
};

export const _registerUndoRedoActionHandler = <TPayload>(
  actionType: string,
  handler: UndoRedoActionHandler<TPayload>
) => {
  actionHandlers.set(actionType, handler as UndoRedoActionHandler);
};

export const _recordUndoRedoAction = <TPayload>(
  actionType: string,
  label: string,
  payload: TPayload
) => {
  const bucket = getBucket();
  bucket.entries.splice(bucket.pointer + 1);
  bucket.entries.push({
    id: THREE.MathUtils.generateUUID(),
    actionType,
    label,
    timestamp: Date.now(),
    // Stored exactly as it will come back from LocalStorage, so an undo right away and an
    // undo after a reload see the same payload (e.g. undefined fields are already gone).
    payload: JSON.parse(JSON.stringify(payload ?? null)),
  });
  bucket.pointer = bucket.entries.length - 1;

  const overflow = bucket.entries.length - getHistorySize();
  if (overflow > 0) {
    bucket.entries.splice(0, overflow);
    bucket.pointer -= overflow;
  }

  persist();
};

/** Runs one direction of an entry's handler. Returns false (pointer must not move) when the
 * handler is missing or throws. */
const applyEntry = (entry: UndoRedoEntry, direction: 'undo' | 'redo') => {
  const handler = actionHandlers.get(entry.actionType);
  if (!handler) {
    lwarn(
      `Could not ${direction} "${entry.label}": no undo/redo handler registered for action type "${entry.actionType}".`
    );
    return false;
  }
  try {
    handler[direction](entry.payload);
  } catch (err) {
    lerror(`Undo/redo handler for "${entry.actionType}" failed to ${direction}.`, err);
    return false;
  }
  return true;
};

export const _undoLastAction = () => {
  const bucket = getBucket();
  if (bucket.pointer < 0) return false;
  if (!applyEntry(bucket.entries[bucket.pointer], 'undo')) return false;
  bucket.pointer--;
  persist();
  return true;
};

export const _redoLastAction = () => {
  const bucket = getBucket();
  if (bucket.pointer >= bucket.entries.length - 1) return false;
  if (!applyEntry(bucket.entries[bucket.pointer + 1], 'redo')) return false;
  bucket.pointer++;
  persist();
  return true;
};

export const _canUndo = () => (state[getBucketId()]?.pointer ?? -1) >= 0;

export const _canRedo = () => {
  const bucket = state[getBucketId()];
  return !!bucket && bucket.pointer < bucket.entries.length - 1;
};

export const _getUndoRedoHistory = (): UndoRedoHistoryState => {
  const bucket = state[getBucketId()];
  if (!bucket) return { entries: [], pointer: -1 };
  return { entries: bucket.entries.map((entry) => ({ ...entry })), pointer: bucket.pointer };
};

export const _clearUndoRedoHistory = (scope: UndoRedoClearScope) => {
  if (scope === 'all') {
    state = {};
  } else {
    delete state[getBucketId()];
  }
  persist();
};
