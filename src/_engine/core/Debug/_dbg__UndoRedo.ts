import * as THREE from 'three/webgpu';
import { getConfig } from '../Config';
import { getCurrentSceneId } from '../Scene';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { lerror, lwarn } from '../../utils/Logger';
import type {
  UndoRedoActionHandler,
  UndoRedoClearScope,
  UndoRedoEntry,
  UndoRedoHistoryEntry,
  UndoRedoHistoryState,
  UndoRedoScope,
} from '../../debug/UndoRedo';

/** The structure of 'AEK_debugUndoRedo' in LocalStorage */
type UndoRedoLSData = {
  [sceneId: string]: UndoRedoHistoryState;
};

/** The structure of 'AEK_debugUndoRedoSettings' in LocalStorage (global, not scene data) */
type UndoRedoSettingsLSData = {
  historySize: number;
};

type RegisteredHandler = UndoRedoActionHandler & { scope: UndoRedoScope };

const LS_KEY = 'AEK_debugUndoRedo';
const SETTINGS_LS_KEY = 'AEK_debugUndoRedoSettings';
/** Bucket for 'global' scoped actions, and for 'perScene' ones recorded while no scene is current. */
const GLOBAL_BUCKET_ID = '_global';
const DEFAULT_HISTORY_SIZE = 50;
const DEFAULT_COALESCE_WINDOW_MS = 800;

let state: UndoRedoLSData = {};
let lastTimestamp = 0;
let historySize = DEFAULT_HISTORY_SIZE;
const actionHandlers = new Map<string, RegisteredHandler>();

const toValidHistorySize = (size: number) => Math.max(1, Math.round(size));

const getSceneBucketId = () => getCurrentSceneId() ?? GLOBAL_BUCKET_ID;

/** The buckets undo/redo work on: the current scene's and the global one (merged by timestamp). */
const getVisibleBucketIds = () => {
  const sceneBucketId = getSceneBucketId();
  return sceneBucketId === GLOBAL_BUCKET_ID
    ? [GLOBAL_BUCKET_ID]
    : [sceneBucketId, GLOBAL_BUCKET_ID];
};

const getScope = (actionType: string): UndoRedoScope => {
  const handler = actionHandlers.get(actionType);
  if (!handler) {
    lwarn(
      `Recording undo/redo action "${actionType}" before its handler is registered, assuming 'perScene' scope.`
    );
    return 'perScene';
  }
  return handler.scope;
};

const getBucketIdForScope = (scope: UndoRedoScope) =>
  scope === 'global' ? GLOBAL_BUCKET_ID : getSceneBucketId();

const getBucket = (bucketId: string) => {
  if (!state[bucketId]) state[bucketId] = { entries: [], pointer: -1 };
  return state[bucketId];
};

/** Entry timestamps order the merged timeline, so they must be strictly increasing. */
const nextTimestamp = () => {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return lastTimestamp;
};

/** Newest applied entry across the visible buckets (what undo reverts). */
const findUndoTarget = () => {
  let target: { bucket: UndoRedoHistoryState; entry: UndoRedoEntry } | null = null;
  for (const bucketId of getVisibleBucketIds()) {
    const bucket = state[bucketId];
    const entry = bucket?.entries[bucket.pointer];
    if (entry && (!target || entry.timestamp > target.entry.timestamp)) target = { bucket, entry };
  }
  return target;
};

/** Oldest undone entry across the visible buckets (what redo reapplies). */
const findRedoTarget = () => {
  let target: { bucket: UndoRedoHistoryState; entry: UndoRedoEntry } | null = null;
  for (const bucketId of getVisibleBucketIds()) {
    const bucket = state[bucketId];
    const entry = bucket?.entries[bucket.pointer + 1];
    if (entry && (!target || entry.timestamp < target.entry.timestamp)) target = { bucket, entry };
  }
  return target;
};

/** Drops a bucket's oldest entries over the history size. Returns whether anything was dropped. */
const trimBucket = (bucket: UndoRedoHistoryState) => {
  const overflow = bucket.entries.length - historySize;
  if (overflow <= 0) return false;
  bucket.entries.splice(0, overflow);
  // Below -1 when applied entries were dropped along with the oldest undone ones
  bucket.pointer = Math.max(-1, bucket.pointer - overflow);
  return true;
};

const persist = () => {
  if (!Object.keys(state).length) {
    lsRemoveItem(LS_KEY);
    return;
  }
  lsSetItem(LS_KEY, state);
};

/** Stores data exactly as it will come back from LocalStorage, so an undo right away and an
 * undo after a reload see the same payload (e.g. undefined fields are already gone). */
const toStoredData = <T>(data: T): T => JSON.parse(JSON.stringify(data ?? null));

export const _initUndoRedo = () => {
  // The debugger's history size setting overrides CONFIG.ts once it has been changed
  const configHistorySize = getConfig().undoRedo?.historySize ?? DEFAULT_HISTORY_SIZE;
  const settings = lsGetItem(SETTINGS_LS_KEY, {
    historySize: configHistorySize,
  }) as UndoRedoSettingsLSData;
  historySize = toValidHistorySize(settings.historySize ?? configHistorySize);

  state = lsGetItem(LS_KEY, {}) as UndoRedoLSData;
  lastTimestamp = 0;
  for (const bucket of Object.values(state)) {
    for (const entry of bucket.entries) lastTimestamp = Math.max(lastTimestamp, entry.timestamp);
  }
};

export const _registerUndoRedoActionHandler = <TPayload>(
  actionType: string,
  handler: UndoRedoActionHandler<TPayload>,
  scope: UndoRedoScope = 'perScene'
) => {
  actionHandlers.set(actionType, { ...(handler as UndoRedoActionHandler), scope });
};

export const _recordUndoRedoAction = <TPayload>(
  actionType: string,
  label: string,
  payload: TPayload,
  coalesceKey?: string
) => {
  // A new action ends the redo tail of the whole visible timeline, not just its own bucket.
  for (const bucketId of getVisibleBucketIds()) {
    const bucket = state[bucketId];
    if (bucket) bucket.entries.splice(bucket.pointer + 1);
  }

  const bucket = getBucket(getBucketIdForScope(getScope(actionType)));
  bucket.entries.push({
    id: THREE.MathUtils.generateUUID(),
    actionType,
    label,
    timestamp: nextTimestamp(),
    payload: toStoredData(payload),
    ...(coalesceKey !== undefined ? { coalesceKey } : {}),
  });
  bucket.pointer = bucket.entries.length - 1;
  trimBucket(bucket);

  persist();
};

export const _recordOrCoalesceUndoRedoAction = <TPayload extends { prev: unknown; next: unknown }>(
  actionType: string,
  label: string,
  payload: TPayload,
  coalesceKey: string,
  coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS
) => {
  // Only the newest entry of the timeline can absorb the tick, and only while nothing has been
  // undone (an undone entry means the user has stepped out of the gesture).
  const top = _canRedo() ? null : findUndoTarget();
  if (
    top &&
    top.bucket === state[getBucketIdForScope(getScope(actionType))] &&
    top.entry.actionType === actionType &&
    top.entry.coalesceKey === coalesceKey &&
    Date.now() - top.entry.timestamp < coalesceWindowMs
  ) {
    // Same gesture: keep the original `prev`, take the latest `next`.
    top.entry.payload = { ...(top.entry.payload as TPayload), next: toStoredData(payload.next) };
    top.entry.timestamp = nextTimestamp();
    persist();
    return;
  }
  _recordUndoRedoAction(actionType, label, payload, coalesceKey);
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
  const target = findUndoTarget();
  if (!target || !applyEntry(target.entry, 'undo')) return false;
  target.bucket.pointer--;
  persist();
  return true;
};

export const _redoLastAction = () => {
  const target = findRedoTarget();
  if (!target || !applyEntry(target.entry, 'redo')) return false;
  target.bucket.pointer++;
  persist();
  return true;
};

export const _canUndo = () => Boolean(findUndoTarget());

export const _canRedo = () => Boolean(findRedoTarget());

export const _getUndoRedoHistory = (): UndoRedoHistoryEntry[] =>
  getVisibleBucketIds()
    .flatMap((bucketId) => {
      const bucket = state[bucketId];
      if (!bucket) return [];
      const scope: UndoRedoScope = bucketId === GLOBAL_BUCKET_ID ? 'global' : 'perScene';
      return bucket.entries.map((entry, i) => ({ ...entry, scope, applied: i <= bucket.pointer }));
    })
    .sort((a, b) => a.timestamp - b.timestamp);

export const _getUndoRedoHistorySize = () => historySize;

/** Takes effect immediately: every bucket (all scenes and the global one) is trimmed to the new
 * size right away, not just on the next recorded action. */
export const _setUndoRedoHistorySize = (size: number) => {
  historySize = toValidHistorySize(size);
  lsSetItem(SETTINGS_LS_KEY, { historySize } satisfies UndoRedoSettingsLSData);

  let trimmed = false;
  for (const bucket of Object.values(state)) trimmed = trimBucket(bucket) || trimmed;
  if (trimmed) persist();
};

export const _clearUndoRedoHistory = (scope: UndoRedoClearScope) => {
  if (scope === 'all') {
    state = {};
  } else {
    delete state[getSceneBucketId()];
  }
  persist();
};
