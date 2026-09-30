import {
  createDebuggerTab,
  DEBUG_TOASTER_ID,
  updateDebuggerTab,
  type DebuggerPaneItem,
} from '../../debug/DebuggerGUI';
import { IS_DEBUG_ENV } from '../Config';
import { lsRemoveItem } from '../../utils/LocalAndSessionStorage';
import { llog, lwarn } from '../../utils/Logger';
import { addToast } from '../UI/Toaster';
import {
  confirmClearScope,
  createClearListLSButton,
  createClearTabLSButton,
  lsKeyHasData,
} from './_dbg__ClearLSButtons';
import {
  _getSkyBoxRegistry,
  getActiveSkyBox,
  getSceneDefaultSkyBoxId,
  setActiveSkyBox,
  SKYBOX_DEBUG_OVERRIDES_LS_KEY,
  SKYBOX_MANAGER_ID,
} from '../SkyBox/SkyBox';
import { _registerManagerDebugInfo } from './_dbg__ManagedEntities';
import { getCurrentSceneId } from '../Scene';
import { _recordUndoRedoAction, _registerUndoRedoActionHandler } from './_dbg__UndoRedo';
import {
  clearSkyBoxOverrides,
  getSceneIdsWithOverrides,
  migrateLegacySkyBoxLS,
  NO_SKYBOX_ID,
  SKYBOX_TAB_ID,
  skyBoxProxy,
  syncSkyBoxProxy,
} from './SkyBox/_dbg__SkyBoxShared';
import { buildBaseFolder } from './SkyBox/_dbg__BaseFolder';
import { buildEnvironmentFolder } from './SkyBox/_dbg__EnvironmentFolder';
import { buildSunFolder } from './SkyBox/_dbg__SunFolder';
import { buildMoonFolder } from './SkyBox/_dbg__MoonFolder';
import { buildStarsFolder } from './SkyBox/_dbg__StarsFolder';
import { buildDayNightFolder, syncDayNightTransport } from './SkyBox/_dbg__DayNightFolder';
import { buildAtmosphereFolder } from './SkyBox/_dbg__AtmosphereFolder';
import { buildAmbientLightFolder } from './SkyBox/_dbg__AmbientLightFolder';
import { buildCloudsFolder } from './SkyBox/_dbg__CloudsFolder';
import { buildGroundFolder } from './SkyBox/_dbg__GroundFolder';

const LS_KEY_UI = 'AEK_debugSkyBoxUI';
let debuggerCreated = false;

// Before any sky box activates: the first scene load reads the migrated overrides
if (IS_DEBUG_ENV) migrateLegacySkyBoxLS();

// The Lights tab shows a sky box's lights as managed, with a link here
_registerManagerDebugInfo(SKYBOX_MANAGER_ID, {
  label: 'Sky box',
  icon: 'cloudSun',
  tabId: SKYBOX_TAB_ID,
});

// Selection (session-only: on load, the scene default wins)

type SkyBoxSelectPayload = { sceneId: string; prev: string | null; next: string | null };

const selectSkyBox = (sceneId: string, id: string | null) => {
  if (getCurrentSceneId() === sceneId) void setActiveSkyBox(id, sceneId);
};

_registerUndoRedoActionHandler<SkyBoxSelectPayload>('skybox.select', {
  undo: ({ sceneId, prev }) => selectSkyBox(sceneId, prev),
  redo: ({ sceneId, next }) => selectSkyBox(sceneId, next),
});

const buildSelectFolder = (): DebuggerPaneItem => {
  const sceneId = getCurrentSceneId();
  const sceneDefs = sceneId ? _getSkyBoxRegistry().get(sceneId) : undefined;
  const defaultId = sceneId ? getSceneDefaultSkyBoxId(sceneId) : null;
  const options = [
    ...[...(sceneDefs?.values() || [])].map((def) => ({
      text: `${def.debugData?.name || def.id}${def.id === defaultId ? ' [*default]' : ''}`,
      value: def.id,
    })),
    { text: '[No skybox]', value: NO_SKYBOX_ID },
  ].sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const toId = (value: unknown) => (String(value) === NO_SKYBOX_ID ? null : String(value));

  return {
    type: 'folder',
    id: 'sceneSkyBoxes',
    title: "Scene's skyboxes",
    content: [
      {
        key: 'skyBoxId',
        target: skyBoxProxy.select,
        label: 'Sky boxes in scene',
        options,
        onChange: (value, e) => {
          if (!sceneId) return;
          const prev = toId(e.prev);
          const next = toId(value);
          selectSkyBox(sceneId, next);
          if (prev === next) return;
          _recordUndoRedoAction<SkyBoxSelectPayload>('skybox.select', 'Sky box: select', {
            sceneId,
            prev,
            next,
          });
        },
      },
    ],
  };
};

// Copy JSON (there is no write-back to the asset files)

const META_KEYS = ['$schema', '__sourcePath', '__saveData', 'sceneId'] as const;

/** The active sky box's resolved definition (with its overrides), minus meta, as JSON. */
const getActiveSkyBoxJSON = () => {
  const active = getActiveSkyBox();
  if (!active) return null;
  const def: Record<string, unknown> = { ...active.def };
  for (const key of META_KEYS) delete def[key];
  // A texture given in code isn't JSON
  const base: Record<string, unknown> = { ...active.def.base };
  delete base.texture;
  def.base = base;
  return JSON.stringify(def, null, 2);
};

const copySkyBoxJSON = async () => {
  const json = getActiveSkyBoxJSON();
  if (!json) return;
  try {
    await navigator.clipboard.writeText(json);
    addToast({
      toasterId: DEBUG_TOASTER_ID,
      title: 'Copied sky box JSON',
      message: getActiveSkyBox()?.id,
    });
  } catch {
    lwarn('Could not copy the sky box JSON to the clipboard, logging it instead:');
    llog(json);
  }
};

// Clear LS

/** Re-activates the active sky box when its scene's overrides were cleared, so it drops them. */
const reapplyAfterClear = (clearedSceneIds: string[]) => {
  const active = getActiveSkyBox();
  if (active && clearedSceneIds.includes(active.sceneId)) {
    void setActiveSkyBox(active.id, active.sceneId);
  }
};

const createClearOverridesButton = () =>
  createClearListLSButton({
    hasData: () => getSceneIdsWithOverrides().length > 0,
    watchKey: SKYBOX_DEBUG_OVERRIDES_LS_KEY,
    onClear: () => {
      const sceneIds = getSceneIdsWithOverrides();
      const clear = (ids: string[]) => {
        clearSkyBoxOverrides(ids);
        reapplyAfterClear(ids);
      };
      if (sceneIds.length > 1) {
        confirmClearScope({
          onClearAllScenes: () => clear(sceneIds),
          onClearThisScene: () => {
            const sceneId = getCurrentSceneId();
            if (sceneId) clear([sceneId]);
          },
        });
      } else {
        clear(sceneIds);
      }
    },
  });

// Tab

const buildSkyBoxDebugGUI = () => {
  // Set before createDebuggerTab: it can build the tab right away, and the tab's own build
  // must not come back here.
  debuggerCreated = true;
  createDebuggerTab({
    id: SKYBOX_TAB_ID,
    title: 'Sky box controls',
    icon: 'cloudSun',
    // The overrides are scene-scoped (module-owned); the tab's own data is only its UI state,
    // so both clear buttons are custom
    uiLsKey: LS_KEY_UI,
    clearLSButton: false,
    headerButtons: () => [
      createClearTabLSButton({
        hasData: () => lsKeyHasData(LS_KEY_UI),
        watchKey: LS_KEY_UI,
        onClear: () => lsRemoveItem(LS_KEY_UI),
      }),
      createClearOverridesButton(),
    ],
    // The day-night readouts and derived positions move on their own
    refreshIntervalMs: 250,
    onRefresh: () => {
      syncSkyBoxProxy();
      syncDayNightTransport();
    },
    content: () => [
      {
        pane: true,
        content: [
          buildSelectFolder(),
          buildDayNightFolder(),
          buildBaseFolder(),
          buildSunFolder(),
          buildMoonFolder(),
          buildStarsFolder(),
          buildAtmosphereFolder(),
          buildCloudsFolder(),
          buildGroundFolder(),
          buildAmbientLightFolder(),
          buildEnvironmentFolder(),
          {
            type: 'button',
            title: 'Copy JSON',
            disabled: () => !getActiveSkyBox(),
            onClick: () => void copySkyBoxJSON(),
          },
        ],
      },
    ],
  });
};

let pendingRebuild: boolean | null = null;

/**
 * Builds the tab the first time, then rebuilds (default) or refreshes it. Called by SkyBox.ts
 * whenever the registry or the active sky box changes. Deferred to a microtask (coalesced), so
 * a change made from one of the tab's own bindings never rebuilds the pane inside its handler.
 */
export const _createSkyBoxDebugGUI = (opts?: { rebuild?: boolean }) => {
  if (!IS_DEBUG_ENV) return;
  if (!debuggerCreated) {
    buildSkyBoxDebugGUI();
    return;
  }
  const rebuild = opts?.rebuild !== false;
  if (pendingRebuild !== null) {
    pendingRebuild ||= rebuild;
    return;
  }
  pendingRebuild = rebuild;
  queueMicrotask(() => {
    const doRebuild = Boolean(pendingRebuild);
    pendingRebuild = null;
    updateDebuggerTab(SKYBOX_TAB_ID, { rebuild: doRebuild });
  });
};
