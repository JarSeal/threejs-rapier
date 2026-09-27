/**
 * PostFX debugger tab (docs/plans/p071_post-fx-debugger-ui.md). Debug-only, lazily loaded
 * through PostFX.ts's createPostFXDebugGUI().
 */
import type { Pane } from 'tweakpane';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { getConfig } from '../Config';
import { isPostFxEnabled, setPostFxEnabled } from '../PostFX';
import { isPostFxMeasureEnabled, setPostFxMeasureEnabled } from '../../debug/PostFXProfiler';
import { getCurrentSceneId, getSceneOpts, registerOnAllSceneEnterings } from '../Scene';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import {
  confirmClearScope,
  createClearListLSButton,
  createClearTabLSButton,
  lsKeyHasData,
} from './_dbg__ClearLSButtons';
import { _recordUndoRedoAction, _registerUndoRedoActionHandler } from './_dbg__UndoRedo';

/** The structure of 'AEK_debugPostFxSettings' in LocalStorage. Only deviations are stored:
 * a scene missing from postFxEnabled means "as authored" (the scene's postFxEnabled), a
 * missing measureEnabled means "as configured" (AppConfig.postFx.measureEnabled). */
type PostFxSettingsLSData = {
  measureEnabled?: boolean;
  postFxEnabled?: { [sceneId: string]: boolean };
};

const SETTINGS_LS_KEY = 'AEK_debugPostFxSettings';

const UNDO_POSTFX_ENABLED = 'postFx.enabled';
type PostFxEnabledPayload = { prev: boolean; next: boolean };

/** The currently built pane (null until the tab is first opened, stale once it's closed). */
let postFxPane: Pane | null = null;
/** Tweakpane binds to object properties, so the live values are mirrored here. */
const settingsProxy = { postFxEnabled: false, measureEnabled: false };
/** True while undo/redo, clearing or a scene change pushes a value into the GUI, so the change
 * listeners don't record or persist it. */
let isSyncingGUI = false;

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

const refreshGUI = () => {
  settingsProxy.postFxEnabled = isPostFxEnabled();
  settingsProxy.measureEnabled = isPostFxMeasureEnabled();
  if (!postFxPane?.element.isConnected) return;
  isSyncingGUI = true;
  try {
    postFxPane.refresh();
  } finally {
    isSyncingGUI = false;
  }
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

  // The first scene is entered before the debug GUIs are created (inside appStartFn), so the
  // persisted state is applied here once, and from then on by the scene enter hook.
  const measureOverride = readSettingsLS().measureEnabled;
  if (measureOverride !== undefined) await setPostFxMeasureEnabled(measureOverride);
  syncPostFxEnabledFromLS();
  registerOnAllSceneEnterings('postFxDebugSync', () => {
    syncPostFxEnabledFromLS();
    refreshGUI();
  });

  const icon = getSvgIcon('postFx');
  createDebuggerTab({
    id: 'postFxControls',
    buttonText: icon,
    title: 'PostFX controls',
    orderNr: 9,
    container: () => {
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
      // The per-PostFX pass overrides (the list) arrive in Phase 4 of the plan
      const clearListBtn = createClearListLSButton({ hasData: () => false, onClear: () => {} });
      const { container, debugGUI } = createNewDebuggerPane('postFx', `${icon} PostFX Controls`, [
        clearTabBtn,
        clearListBtn,
      ]);
      postFxPane = debugGUI;
      settingsProxy.postFxEnabled = isPostFxEnabled();
      settingsProxy.measureEnabled = isPostFxMeasureEnabled();

      const masterEnabled = isMasterEnabled();
      debugGUI
        .addBinding(settingsProxy, 'postFxEnabled', {
          label: masterEnabled ? 'PostFX enabled' : 'PostFX enabled (off in AppConfig.postFx)',
          disabled: !masterEnabled,
        })
        .on('change', (e) => {
          if (isSyncingGUI) return;
          const prev = !e.value;
          applyPostFxEnabled(e.value);
          _recordUndoRedoAction<PostFxEnabledPayload>(
            UNDO_POSTFX_ENABLED,
            `PostFX: ${e.value ? 'enable' : 'disable'} PostFX`,
            { prev, next: e.value }
          );
        });
      debugGUI
        .addBinding(settingsProxy, 'measureEnabled', {
          label: 'Measuring enabled (see getPostFxPassStats())',
        })
        .on('change', (e) => {
          if (isSyncingGUI) return;
          void applyMeasureEnabled(e.value);
        });

      return container;
    },
  });
};
