import { IS_DEBUG_ENV } from '../core/Config';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

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
  timestamp: number;
  payload: TPayload;
};

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

export type UndoRedoClearScope = 'currentScene' | 'all';

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
 */
export const registerUndoRedoActionHandler = <TPayload>(
  actionType: string,
  handler: UndoRedoActionHandler<TPayload>
) => {
  useDebug(debugGUI)?._registerUndoRedoActionHandler(actionType, handler);
};

/**
 * Records an already-applied action to the current scene's history, dropping any redo tail.
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
 * Undoes the current scene's last applied action.
 * @returns (boolean) whether an action was undone
 */
export const undoLastAction = () => useDebug(debugGUI)?._undoLastAction() ?? false;

/**
 * Redoes the current scene's next undone action.
 * @returns (boolean) whether an action was redone
 */
export const redoLastAction = () => useDebug(debugGUI)?._redoLastAction() ?? false;

export const canUndo = () => useDebug(debugGUI)?._canUndo() ?? false;

export const canRedo = () => useDebug(debugGUI)?._canRedo() ?? false;

/**
 * Returns a copy of the current scene's history
 * @returns ({@link UndoRedoHistoryState} | undefined)
 */
export const getUndoRedoHistory = () => useDebug(debugGUI)?._getUndoRedoHistory();

/**
 * Clears the history of the current scene or of all scenes
 * @param scope ({@link UndoRedoClearScope})
 */
export const clearUndoRedoHistory = (scope: UndoRedoClearScope) => {
  useDebug(debugGUI)?._clearUndoRedoHistory(scope);
};
