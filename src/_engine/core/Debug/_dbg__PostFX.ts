/**
 * PostFX debugger tab (docs/plans/_DONE_p071_post-fx-debugger-ui.md). Debug-only, lazily loaded
 * through PostFX.ts's createPostFXDebugGUI().
 */
import { Pane, type BindingParams } from 'tweakpane';
import {
  createDebuggerTab,
  debuggerListCMP,
  updateDebuggerTab,
  type DebuggerListItem,
} from '../../debug/DebuggerGUI';
import { getConfig } from '../Config';
import {
  addPostFxChainListener,
  getPostFxPasses,
  isPostFxEnabled,
  setPostFxEnabled,
  setPostFxPassEnabled,
  setPostFxPassParam,
  type PostFxLiveParams,
  type PostFxPassInfo,
} from '../PostFX';
import { isPostFxMeasureEnabled, setPostFxMeasureEnabled } from '../../debug/PostFXProfiler';
import { getCurrentSceneId, getSceneOpts, registerOnAllSceneEnterings } from '../Scene';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowContentFn,
  registerDraggableWindowSceneTargetResolver,
  updateDraggableWindow,
} from '../UI/DraggableWindow';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import { CMP } from '../../utils/CMP';
import {
  confirmClearScope,
  createClearListLSButton,
  createClearTabLSButton,
  lsKeyHasData,
} from './_dbg__ClearLSButtons';
import { _recordUndoRedoAction, _registerUndoRedoActionHandler } from './_dbg__UndoRedo';
import { lwarn } from '../../utils/Logger';
import type { PostFxParamMeta } from '../../schemas/postFxSchema';

/** The structure of 'AEK_debugPostFxSettings' in LocalStorage. Only deviations are stored:
 * a scene missing from postFxEnabled means "as authored" (the scene's postFxEnabled), a
 * missing measureEnabled means "as configured" (AppConfig.postFx.measureEnabled). */
type PostFxSettingsLSData = {
  measureEnabled?: boolean;
  postFxEnabled?: { [sceneId: string]: boolean };
};

/** One PostFX pass's deviations from its authored state. */
type PostFxPassOverride = { enabled?: boolean; params?: Record<string, unknown> };

/** The structure of 'AEK_debugPostFx' in LocalStorage. Only deviations from the authored
 * PostFX passes are stored, and empty pass / scene entries are pruned. */
type PostFxPassesLSData = {
  [sceneId: string]: { [postFxPassId: string]: PostFxPassOverride };
};

const SETTINGS_LS_KEY = 'AEK_debugPostFxSettings';
const LS_KEY = 'AEK_debugPostFx';

const TAB_ID = 'postFxControls';
const EDIT_POSTFX_PASS_WIN_ID = 'postFxPassEditorWindow';

const UNDO_POSTFX_ENABLED = 'postFx.enabled';
const UNDO_POSTFX_PASS_ENABLED = 'postFx.passEnabled';
const UNDO_POSTFX_PASS_PARAM = 'postFx.passParam';
type PostFxEnabledPayload = { prev: boolean; next: boolean };
type PostFxPassEnabledPayload = { postFxPassId: string; prev: boolean; next: boolean };
type PostFxPassParamPayload = { postFxPassId: string; key: string; prev: unknown; next: unknown };

/** Tweakpane binds to object properties, so the live values are mirrored here (synced on every
 * tab refresh). */
const settingsProxy = { postFxEnabled: false, measureEnabled: false };
/** The current scene's PostFX passes as authored, taken on scene enter before the persisted
 * overrides are applied (the chain has just been set up from the scene data then). */
let authoredPostFxPasses = new Map<string, { enabled: boolean; params: Record<string, unknown> }>();
/** What the open edit window was built for, so a chain rebuild only rebuilds the window when
 * the PostFX pass's live param mode actually changed (eg. 'unknown' → 'setParam'). */
let windowBuiltFor: { postFxPassId: string; liveParams: PostFxLiveParams } | null = null;

const isMasterEnabled = () => getConfig().postFx?.enabled !== false;
const getAuthoredPostFxEnabled = (sceneId: string) =>
  getSceneOpts(sceneId)?.postFxEnabled !== false;
const getConfiguredMeasureEnabled = () => getConfig().postFx?.measureEnabled === true;

const readSettingsLS = () => lsGetItem(SETTINGS_LS_KEY, {}) as PostFxSettingsLSData;

const writeSettingsLSOrRemove = (data: PostFxSettingsLSData) => {
  if (data.postFxEnabled && !Object.keys(data.postFxEnabled).length) delete data.postFxEnabled;
  if (Object.keys(data).length) lsSetItem(SETTINGS_LS_KEY, data);
  else lsRemoveItem(SETTINGS_LS_KEY);
};

/** Refreshes the tab (its settings and the PostFX pass list), when it's the open one. */
const refreshGUI = () => updateDebuggerTab(TAB_ID);

/** The current scene's PostFX passes, in chain order. */
const getPostFxPassListData = (): DebuggerListItem[] =>
  getPostFxPasses().map(({ id, index, enabled, debugData }) => ({
    itemId: id,
    title: debugData?.name || `[${id}]`,
    titlePlaceholder: !debugData?.name,
    subTitle: `#${index + 1} [${id}]`,
    ...(!enabled ? { badge: '(disabled)', disabled: true } : {}),
    ...(debugData?.description ? { tooltip: debugData.description } : {}),
  }));

const toggleEditPostFxPassWindow = (id: string) => {
  const winState = getDraggableWindow(EDIT_POSTFX_PASS_WIN_ID);
  if (winState?.isOpen && winState.data?.id === id) {
    closeDraggableWindow(EDIT_POSTFX_PASS_WIN_ID);
    return;
  }
  const debugData = findPostFxPass(id)?.debugData;
  openDraggableWindow({
    id: EDIT_POSTFX_PASS_WIN_ID,
    title: `Edit PostFX pass: ${debugData?.name || `[${id}]`}`,
    isDebugWindow: true,
    content: createEditPostFxPassContent,
    data: { id, winId: EDIT_POSTFX_PASS_WIN_ID },
    closeOnSceneChange: true,
    saveToLS: true,
    onClose: onEditWindowClose,
  });
};

/** Switches the current scene's PostFX stack and persists it (only when it deviates from the
 * scene's authored value). */
const applyPostFxEnabled = (enabled: boolean) => {
  setPostFxEnabled(enabled);
  const sceneId = getCurrentSceneId();
  if (sceneId) {
    const data = readSettingsLS();
    const perScene = { ...data.postFxEnabled };
    if (enabled === getAuthoredPostFxEnabled(sceneId)) delete perScene[sceneId];
    else perScene[sceneId] = enabled;
    data.postFxEnabled = perScene;
    writeSettingsLSOrRemove(data);
  }
  refreshGUI();
};

/** Switches measuring and persists it (only when it deviates from the app config). */
const applyMeasureEnabled = async (enabled: boolean) => {
  await setPostFxMeasureEnabled(enabled);
  // The profiler can refuse to start (eg. no renderer), so persist what actually happened
  const isMeasuring = isPostFxMeasureEnabled();
  const data = readSettingsLS();
  if (isMeasuring === getConfiguredMeasureEnabled()) delete data.measureEnabled;
  else data.measureEnabled = isMeasuring;
  writeSettingsLSOrRemove(data);
  refreshGUI();
};

/** Re-applies the current scene's persisted PostFX enabled override. Runs on every scene
 * entering, after PostFX.ts's own 'postFxSceneEnter' (registered earlier, so it runs first)
 * has set the chain up with the authored value. */
const syncPostFxEnabledFromLS = () => {
  const sceneId = getCurrentSceneId();
  if (!sceneId || !isMasterEnabled()) return;
  const override = readSettingsLS().postFxEnabled?.[sceneId];
  if (override !== undefined) setPostFxEnabled(override);
};

// Per-PostFX pass overrides

const readPassesLS = () => lsGetItem(LS_KEY, {}) as PostFxPassesLSData;

const writePassesLSOrRemove = (data: PostFxPassesLSData) => {
  for (const sceneId of Object.keys(data)) {
    if (!Object.keys(data[sceneId] || {}).length) delete data[sceneId];
  }
  if (Object.keys(data).length) lsSetItem(LS_KEY, data);
  else lsRemoveItem(LS_KEY);
};

const isSameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const findPostFxPass = (postFxPassId: string) =>
  getPostFxPasses().find((p) => p.id === postFxPassId);

const snapshotAuthoredPostFxPasses = () => {
  authoredPostFxPasses = new Map(
    getPostFxPasses().map((p) => [p.id, { enabled: p.enabled, params: structuredClone(p.params) }])
  );
};

/** Persists a PostFX pass's current live state as its deviation from the authored state. */
const persistPostFxPassOverride = (postFxPassId: string) => {
  const sceneId = getCurrentSceneId();
  const live = findPostFxPass(postFxPassId);
  const authored = authoredPostFxPasses.get(postFxPassId);
  if (!sceneId || !live || !authored) return;

  const override: PostFxPassOverride = {};
  if (live.enabled !== authored.enabled) override.enabled = live.enabled;
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live.params)) {
    if (!isSameValue(value, authored.params[key])) params[key] = value;
  }
  if (Object.keys(params).length) override.params = params;

  const data = readPassesLS();
  const sceneData = { ...data[sceneId] };
  if (Object.keys(override).length) sceneData[postFxPassId] = override;
  else delete sceneData[postFxPassId];
  data[sceneId] = sceneData;
  writePassesLSOrRemove(data);
};

/** Re-applies the current scene's persisted PostFX pass overrides (after the snapshot). */
const applyPostFxPassOverridesFromLS = () => {
  const sceneId = getCurrentSceneId();
  if (!sceneId) return;
  const sceneData = readPassesLS()[sceneId] || {};
  for (const [postFxPassId, override] of Object.entries(sceneData)) {
    // The PostFX pass may have been removed from the scene data since, keep its entry though
    if (!authoredPostFxPasses.has(postFxPassId)) continue;
    for (const [key, value] of Object.entries(override.params || {})) {
      setPostFxPassParam(postFxPassId, key, value);
    }
    if (override.enabled !== undefined) setPostFxPassEnabled(postFxPassId, override.enabled);
  }
};

/** Rebuilds the open edit window when it shows this PostFX pass (or any, without an id). */
const refreshEditWindow = (postFxPassId?: string) => {
  const winState = getDraggableWindow(EDIT_POSTFX_PASS_WIN_ID);
  if (!winState?.isOpen) return;
  if (postFxPassId && winState.data?.id !== postFxPassId) return;
  updateDraggableWindow(EDIT_POSTFX_PASS_WIN_ID);
};

const applyPostFxPassEnabled = (postFxPassId: string, enabled: boolean) => {
  if (!findPostFxPass(postFxPassId)) {
    lwarn(`PostFX debugger: PostFX pass "${postFxPassId}" is not in the current scene, skipping.`);
    return;
  }
  setPostFxPassEnabled(postFxPassId, enabled);
  persistPostFxPassOverride(postFxPassId);
  refreshGUI();
};

const applyPostFxPassParam = (postFxPassId: string, key: string, value: unknown) => {
  if (!findPostFxPass(postFxPassId)) {
    lwarn(`PostFX debugger: PostFX pass "${postFxPassId}" is not in the current scene, skipping.`);
    return;
  }
  setPostFxPassParam(postFxPassId, key, value);
  persistPostFxPassOverride(postFxPassId);
};

/** Clears the per-PostFX pass overrides and moves the current scene's passes (when cleared)
 * back to their authored state, live. */
const clearPassesLS = (scope: 'ALL' | 'THIS_SCENE') => {
  const sceneId = getCurrentSceneId();
  if (scope === 'ALL') {
    lsRemoveItem(LS_KEY);
  } else if (sceneId) {
    const data = readPassesLS();
    delete data[sceneId];
    writePassesLSOrRemove(data);
  }
  for (const [postFxPassId, authored] of authoredPostFxPasses) {
    const live = findPostFxPass(postFxPassId);
    if (!live) continue;
    for (const [key, value] of Object.entries(authored.params)) {
      if (!isSameValue(value, live.params[key])) setPostFxPassParam(postFxPassId, key, value);
    }
    if (live.enabled !== authored.enabled) setPostFxPassEnabled(postFxPassId, authored.enabled);
  }
  refreshGUI();
  refreshEditWindow();
};

// Edit window

type ParamKind = 'number' | 'boolean' | 'string' | 'point' | 'color' | 'json';

const POINT_AXES = ['x', 'y', 'z', 'w'] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyNumberKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const valueKeys = Object.keys(value);
  return (
    valueKeys.length === keys.length &&
    keys.every((k) => typeof value[k] === 'number' && valueKeys.includes(k))
  );
};

const inferParamKind = (value: unknown): ParamKind => {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (isPlainObject(value)) {
    for (let n = 2; n <= 4; n++) {
      if (hasOnlyNumberKeys(value, POINT_AXES.slice(0, n))) return 'point';
    }
    if (
      hasOnlyNumberKeys(value, ['r', 'g', 'b']) ||
      hasOnlyNumberKeys(value, ['r', 'g', 'b', 'a'])
    ) {
      return 'color';
    }
  }
  return 'json';
};

/** Tweakpane binding options for a param: inferred from its value, upgraded by its paramsMeta. */
const getParamBindingParams = (
  kind: ParamKind,
  value: unknown,
  meta: PostFxParamMeta,
  label: string
): BindingParams => {
  const params: Record<string, unknown> = { label };
  if (meta.options && kind !== 'json') {
    params.options = meta.options;
    return params as BindingParams;
  }
  const range: Record<string, number> = {};
  if (meta.min !== undefined) range.min = meta.min;
  if (meta.max !== undefined) range.max = meta.max;
  if (meta.step !== undefined) range.step = meta.step;
  if (kind === 'number') Object.assign(params, range);
  if (kind === 'point') {
    for (const axis of POINT_AXES) {
      if ((value as Record<string, unknown>)[axis] !== undefined) params[axis] = range;
    }
  }
  if (kind === 'color') {
    // Components in 0..1 are linear floats (as TSL colors usually are), otherwise 0..255
    const isFloat = Object.values(value as Record<string, number>).every((c) => c <= 1);
    params.color = { type: isFloat ? 'float' : 'int' };
  }
  return params as BindingParams;
};

/** A fresh plain copy of an edited value, shaped like the original (never the proxy's object,
 * which Tweakpane keeps writing into). */
const toParamValue = (kind: ParamKind, value: unknown, original: unknown) => {
  if (kind !== 'point' && kind !== 'color') return value;
  const copy: Record<string, number> = {};
  for (const k of Object.keys(original as Record<string, unknown>)) {
    copy[k] = (value as Record<string, number>)[k];
  }
  return copy;
};

const LIVE_PARAMS_TEXT: Record<PostFxLiveParams, string> = {
  setParam: 'Live (the PostFX pass updates itself)',
  rebuild: 'Rebuild (each committed edit rebuilds the PostFX chain, a shader recompile)',
  unknown: 'Not built yet (edits apply when the PostFX pass is next built)',
};

const onEditWindowClose = () => {
  windowBuiltFor = null;
  refreshGUI();
};

const createEditPostFxPassContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string; winId: string };
  const info = findPostFxPass(d.id);
  if (!info) {
    // Eg. restored after a reload into a scene without this PostFX pass: close it, but return first
    setTimeout(() => closeDraggableWindow(EDIT_POSTFX_PASS_WIN_ID), 0);
    return CMP({ text: 'PostFX pass not found' });
  }

  // The content is built before the window state is open: refresh the list selection after it.
  // The onClose is set here too, because a window restored from LS has none.
  queueMicrotask(() => {
    addOnCloseToWindow(EDIT_POSTFX_PASS_WIN_ID, onEditWindowClose);
    refreshGUI();
  });
  windowBuiltFor = { postFxPassId: info.id, liveParams: info.liveParams };

  const container = CMP({ onRemoveCmp: () => pane.dispose() });
  const isLive = info.liveParams === 'setParam';
  if (!isLive) {
    container.add({
      class: 'winNotRightPaddedContent',
      html: () =>
        `<p>${info.liveParams === 'rebuild' ? 'This PostFX pass has no live param updates (no setParam): each edit is applied when released, and rebuilds the PostFX chain (a shader recompile).' : 'This PostFX pass has not been built yet (disabled, or not rendered): edits are applied when released, and take effect when it is next built.'}</p>`,
    });
  }
  const pane = new Pane({ container: container.elem });

  const enabledProxy = { enabled: info.enabled };
  pane
    .addBinding(enabledProxy, 'enabled', { label: 'Enabled (rebuilds the PostFX chain)' })
    .on('change', (e) => {
      applyPostFxPassEnabled(info.id, e.value);
      _recordUndoRedoAction<PostFxPassEnabledPayload>(
        UNDO_POSTFX_PASS_ENABLED,
        `PostFX ${info.debugData?.name || info.id}: ${e.value ? 'enable' : 'disable'}`,
        { postFxPassId: info.id, prev: !e.value, next: e.value }
      );
    });

  const paramKeys = Object.keys(info.params);
  if (paramKeys.length) pane.addBlade({ view: 'separator' });
  addParamBindings(pane, info, isLive);

  // Footer info
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">PostFX pass ID:</span> ${info.id}</div>
      <div><span class="winSmallLabel">Chain position:</span> #${info.index + 1}</div>
      <div><span class="winSmallLabel">Param edits:</span> ${LIVE_PARAMS_TEXT[info.liveParams]}</div>
    </div>`,
  });
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">Name:</span> ${info.debugData?.name || ''}</div>
    </div>`,
  });
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">Description:</span> ${info.debugData?.description || ''}</div>
    </div>`,
  });

  return container;
};

const addParamBindings = (pane: Pane, info: PostFxPassInfo, isLive: boolean) => {
  // Tweakpane writes into the proxy, and has already done so when 'change' fires, so the
  // committed (last recorded) values are kept apart for the undo/redo `prev`
  const paramsProxy = structuredClone(info.params);
  const committed = structuredClone(info.params);
  const passName = info.debugData?.name || info.id;

  for (const key of Object.keys(info.params)) {
    const meta = info.paramsMeta?.[key] || {};
    if (meta.hidden) continue;
    const value = info.params[key];
    const kind = inferParamKind(value);
    const label = meta.label || key;

    if (kind === 'json') {
      // Can't be edited with a control, but never silently left out either
      const jsonProxy = { [key]: JSON.stringify(value) };
      pane.addBinding(jsonProxy, key, { label: `${label} (JSON, readonly)`, readonly: true });
      continue;
    }

    pane
      .addBinding(paramsProxy, key, getParamBindingParams(kind, value, meta, label))
      .on('change', (e) => {
        const next = toParamValue(kind, e.value, value);
        // A live PostFX pass follows the drag, the others only get the released value
        if (isLive) setPostFxPassParam(info.id, key, next);
        if (!e.last) return;
        applyPostFxPassParam(info.id, key, next);
        const prev = committed[key];
        committed[key] = structuredClone(next);
        if (isSameValue(prev, next)) return;
        _recordUndoRedoAction<PostFxPassParamPayload>(
          UNDO_POSTFX_PASS_PARAM,
          `PostFX ${passName}: ${label}`,
          { postFxPassId: info.id, key, prev, next }
        );
      });
  }
};

registerDraggableWindowContentFn(EDIT_POSTFX_PASS_WIN_ID, createEditPostFxPassContent);
// Kept open on a scene change when the next scene's PostFX chain has the same pass
registerDraggableWindowSceneTargetResolver(EDIT_POSTFX_PASS_WIN_ID, (data) =>
  Boolean(findPostFxPass(String(data?.id)))
);

const clearSettingsLS = (scope: 'ALL' | 'THIS_SCENE') => {
  const sceneId = getCurrentSceneId();
  if (scope === 'ALL') {
    lsRemoveItem(SETTINGS_LS_KEY);
  } else if (sceneId) {
    const data = readSettingsLS();
    if (data.postFxEnabled) delete data.postFxEnabled[sceneId];
    writeSettingsLSOrRemove(data);
  }
  // Back to the authored / configured values, live
  if (sceneId && isMasterEnabled()) setPostFxEnabled(getAuthoredPostFxEnabled(sceneId));
  if (scope === 'ALL') {
    void setPostFxMeasureEnabled(getConfiguredMeasureEnabled()).then(refreshGUI);
  }
  refreshGUI();
};

export const _createPostFXDebugGUI = async () => {
  _registerUndoRedoActionHandler<PostFxEnabledPayload>(UNDO_POSTFX_ENABLED, {
    undo: ({ prev }) => applyPostFxEnabled(prev),
    redo: ({ next }) => applyPostFxEnabled(next),
  });
  _registerUndoRedoActionHandler<PostFxPassEnabledPayload>(UNDO_POSTFX_PASS_ENABLED, {
    undo: ({ postFxPassId, prev }) => {
      applyPostFxPassEnabled(postFxPassId, prev);
      refreshEditWindow(postFxPassId);
    },
    redo: ({ postFxPassId, next }) => {
      applyPostFxPassEnabled(postFxPassId, next);
      refreshEditWindow(postFxPassId);
    },
  });
  _registerUndoRedoActionHandler<PostFxPassParamPayload>(UNDO_POSTFX_PASS_PARAM, {
    undo: ({ postFxPassId, key, prev }) => {
      applyPostFxPassParam(postFxPassId, key, prev);
      refreshEditWindow(postFxPassId);
    },
    redo: ({ postFxPassId, key, next }) => {
      applyPostFxPassParam(postFxPassId, key, next);
      refreshEditWindow(postFxPassId);
    },
  });

  // A PostFX pass only shows whether it has a live setParam once it's built: rebuild the open
  // edit window when that changed (deferred, as the chain is built mid-frame)
  addPostFxChainListener(() => {
    setTimeout(() => {
      if (!windowBuiltFor) return;
      const info = findPostFxPass(windowBuiltFor.postFxPassId);
      if (info && info.liveParams !== windowBuiltFor.liveParams) {
        refreshEditWindow(info.id);
      }
    }, 0);
  });

  // The first scene is entered before the debug GUIs are created (inside appStartFn), so the
  // persisted state is applied here once, and from then on by the scene enter hook.
  const measureOverride = readSettingsLS().measureEnabled;
  if (measureOverride !== undefined) await setPostFxMeasureEnabled(measureOverride);
  snapshotAuthoredPostFxPasses();
  syncPostFxEnabledFromLS();
  applyPostFxPassOverridesFromLS();
  registerOnAllSceneEnterings('postFxDebugSync', () => {
    snapshotAuthoredPostFxPasses();
    syncPostFxEnabledFromLS();
    applyPostFxPassOverridesFromLS();
    // The drawer is rebuilt on scene change before the new scene's PostFX passes are set up
    refreshGUI();
  });

  const masterEnabled = isMasterEnabled();
  createDebuggerTab({
    id: TAB_ID,
    title: 'PostFX controls',
    icon: 'postFx',
    // Both LS keys are scene-scoped / deviation-only (module-owned), so both buttons are custom
    clearLSButton: false,
    headerButtons: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => lsKeyHasData(SETTINGS_LS_KEY),
        watchKey: SETTINGS_LS_KEY,
        onClear: () => {
          const data = readSettingsLS();
          const sceneIdsWithData = Object.keys(data.postFxEnabled || {});
          if (sceneIdsWithData.length > 1) {
            confirmClearScope({
              onClearAllScenes: () => clearSettingsLS('ALL'),
              onClearThisScene: () => clearSettingsLS('THIS_SCENE'),
            });
          } else {
            clearSettingsLS('ALL');
          }
        },
      });
      const clearListBtn = createClearListLSButton({
        hasData: () => lsKeyHasData(LS_KEY),
        watchKey: LS_KEY,
        onClear: () => {
          if (Object.keys(readPassesLS()).length > 1) {
            confirmClearScope({
              onClearAllScenes: () => clearPassesLS('ALL'),
              onClearThisScene: () => clearPassesLS('THIS_SCENE'),
            });
          } else {
            clearPassesLS('ALL');
          }
        },
      });
      return [clearTabBtn, clearListBtn];
    },
    onRefresh: () => {
      settingsProxy.postFxEnabled = isPostFxEnabled();
      settingsProxy.measureEnabled = isPostFxMeasureEnabled();
    },
    content: () => [
      {
        pane: true,
        content: [
          {
            key: 'postFxEnabled',
            target: settingsProxy,
            label: masterEnabled ? 'PostFX enabled' : 'PostFX enabled (off in AppConfig.postFx)',
            disabled: !masterEnabled,
            onChange: (value, e) => {
              applyPostFxEnabled(Boolean(value));
              _recordUndoRedoAction<PostFxEnabledPayload>(
                UNDO_POSTFX_ENABLED,
                `PostFX: ${value ? 'enable' : 'disable'} PostFX`,
                { prev: Boolean(e.prev), next: Boolean(value) }
              );
            },
          },
          {
            key: 'measureEnabled',
            target: settingsProxy,
            label: 'Measuring enabled (see getPostFxPassStats())',
            onChange: (value) => void applyMeasureEnabled(Boolean(value)),
          },
        ],
      },
      debuggerListCMP({
        id: 'postFxPasses',
        heading: 'PostFX passes (in chain order)',
        emptyText: 'No PostFX passes in this scene..',
        data: getPostFxPassListData,
        selectedItemId: () => {
          const winState = getDraggableWindow(EDIT_POSTFX_PASS_WIN_ID);
          return winState?.isOpen ? (winState.data?.id as string | undefined) : null;
        },
        // No row toggle (p071 Design decision 9): the pass toggle rebuilds the PostFX chain (a
        // shader recompile), so it stays in the edit window
        perItemConfig: { onClick: toggleEditPostFxPassWindow },
      }),
    ],
  });
};
