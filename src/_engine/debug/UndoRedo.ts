import { IS_DEBUG_ENV } from '../core/Config';
import type { DebugModuleRef } from '../utils/helpers';
import { loadDebugModuleAsync, useDebug } from '../utils/helpers';

/**
 * One recorded debugger action. Entries are persisted to LocalStorage, so everything in
 * here (payload included) must be plain JSON-serializable data: ids, field names,
 * prev/next values. No object references, no functions.
 */
export type UndoRedoEntry<TPayload = unknown> = {
  id: string;
  /** Namespaced action type (e.g. 'camera.setTransform'), used to look up the handler. */
  actionType: string;
  /** Human-readable label for a history list UI. */
  label: string;
  /** Strictly increasing; orders the merged scene + global timeline. */
  timestamp: number;
  payload: TPayload;
  /** Set by {@link recordOrCoalesceUndoRedoAction}: ticks with the same key merge into this entry. */
  coalesceKey?: string;
};

/**
 * Where an action type's entries are kept. 'perScene' entries are only undoable while their
 * scene is current; 'global' entries (settings that aren't scene data, e.g. the renderer's) are
 * undoable in every scene. Undo/redo walk both as one timeline, ordered by timestamp.
 */
export type UndoRedoScope = 'perScene' | 'global';

/** Applies an action type's payload in either direction. Registered once per action type. */
export type UndoRedoActionHandler<TPayload = unknown> = {
  undo: (payload: TPayload) => void;
  redo: (payload: TPayload) => void;
};

export type UndoRedoHistoryState = {
  entries: UndoRedoEntry[];
  /** Index of the last applied entry, -1 = nothing applied. */
  pointer: number;
};

/** One entry of the merged history returned by {@link getUndoRedoHistory}. */
export type UndoRedoHistoryEntry = UndoRedoEntry & {
  scope: UndoRedoScope;
  /** False when the entry has been undone (redo would reapply it). */
  applied: boolean;
};

export type UndoRedoClearScope = 'currentScene' | 'all';

/** Debugger undo/redo settings, persisted to LocalStorage once changed in the debugger. */
export type UndoRedoSettings = {
  /** Max number of history entries kept per bucket (each scene's and the global one). Min 1,
   * defaults to `AppConfig.undoRedo.historySize`. */
  historySize: number;
  /** Whether each undo/redo shows an info toast (in the debug toaster). Default true. */
  showToasts: boolean;
};

type UndoRedoModule = typeof import('../core/Debug/_dbg__UndoRedo');
let debugGUI: DebugModuleRef<UndoRedoModule> | null = null;

export const registerUndoRedoModule = async () => {
  if (!IS_DEBUG_ENV) return;
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__UndoRedo'));
};

/** Loads the persisted history from LocalStorage. */
export const initUndoRedo = () => {
  useDebug(debugGUI)?._initUndoRedo();
};

/**
 * Registers the undo/redo handler for an action type. Call once per action type, at module
 * load time.
 * @param actionType (string) the action type
 * @param handler ({@link UndoRedoActionHandler}) applies the payload in either direction
 * @param scope ({@link UndoRedoScope}) where the entries are kept, default 'perScene'
 */
export const registerUndoRedoActionHandler = <TPayload>(
  actionType: string,
  handler: UndoRedoActionHandler<TPayload>,
  scope?: UndoRedoScope
) => {
  useDebug(debugGUI)?._registerUndoRedoActionHandler(actionType, handler, scope);
};

/**
 * Records an already-applied action to its scope's history (the current scene's or the global
 * one), dropping the redo tail of the current scene + global timeline.
 * @param actionType (string) the registered action type
 * @param label (string) human-readable label
 * @param payload (TPayload) plain JSON-serializable data the handler needs
 */
export const recordUndoRedoAction = <TPayload>(
  actionType: string,
  label: string,
  payload: TPayload
) => {
  useDebug(debugGUI)?._recordUndoRedoAction(actionType, label, payload);
};

/**
 * Records a tick of a continuous edit (slider/color drag, typing). Ticks with the same
 * `actionType` and `coalesceKey` that arrive within `coalesceWindowMs` of each other merge into
 * one entry that keeps the first tick's `prev` and the latest tick's `next`.
 * @param actionType (string) the registered action type
 * @param label (string) human-readable label (the first tick's label is kept)
 * @param payload (TPayload) plain JSON-serializable data with `prev` and `next`
 * @param coalesceKey (string) identifies the edited field, e.g. `${appId}.fov`
 * @param coalesceWindowMs (number) idle time that ends the gesture, default 800
 */
export const recordOrCoalesceUndoRedoAction = <TPayload extends { prev: unknown; next: unknown }>(
  actionType: string,
  label: string,
  payload: TPayload,
  coalesceKey: string,
  coalesceWindowMs?: number
) => {
  useDebug(debugGUI)?._recordOrCoalesceUndoRedoAction(
    actionType,
    label,
    payload,
    coalesceKey,
    coalesceWindowMs
  );
};

/**
 * Undoes the newest applied action of the current scene + global timeline.
 * @returns (boolean) whether an action was undone
 */
export const undoLastAction = () => useDebug(debugGUI)?._undoLastAction() ?? false;

/**
 * Redoes the oldest undone action of the current scene + global timeline.
 * @returns (boolean) whether an action was redone
 */
export const redoLastAction = () => useDebug(debugGUI)?._redoLastAction() ?? false;

export const canUndo = () => useDebug(debugGUI)?._canUndo() ?? false;

export const canRedo = () => useDebug(debugGUI)?._canRedo() ?? false;

/**
 * Returns a copy of the current scene's and the global history, merged and ordered by timestamp
 * @returns ({@link UndoRedoHistoryEntry}[] | undefined)
 */
export const getUndoRedoHistory = () => useDebug(debugGUI)?._getUndoRedoHistory();

/**
 * Returns a copy of the current undo/redo settings
 * @returns ({@link UndoRedoSettings} | undefined) undefined outside the debug environment
 */
export const getUndoRedoSettings = () => useDebug(debugGUI)?._getUndoRedoSettings();

/**
 * Sets and persists undo/redo settings (only the given fields). Takes effect immediately: a
 * smaller `historySize` trims every scene's and the global history from the oldest end.
 * @param settings (Partial<{@link UndoRedoSettings}>) the settings to change
 */
export const setUndoRedoSettings = (settings: Partial<UndoRedoSettings>) => {
  useDebug(debugGUI)?._setUndoRedoSettings(settings);
};

/**
 * Clears the history of the current scene or of all scenes
 * @param scope ({@link UndoRedoClearScope})
 */
export const clearUndoRedoHistory = (scope: UndoRedoClearScope) => {
  useDebug(debugGUI)?._clearUndoRedoHistory(scope);
};
