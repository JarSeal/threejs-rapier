import {
  createDebuggerTab,
  updateDebuggerTab,
  type DebuggerPaneItem,
} from '../../debug/DebuggerGUI';
import { IS_DEBUG_ENV } from '../Config';
import { lsRemoveItem } from '../../utils/LocalAndSessionStorage';
import { createClearTabLSButton, lsKeyHasData } from './_dbg__ClearLSButtons';
import {
  _getSkyBoxRegistry,
  getActiveSkyBox,
  getSceneDefaultSkyBoxId,
  setActiveSkyBox,
  updateSkyBox,
  type SkyBoxUpdate,
} from '../SkyBox/SkyBox';
import { ENV_DEFAULTS } from '../SkyBox/layers/base';
import { getCurrentSceneId } from '../Scene';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from './_dbg__UndoRedo';

// p111 Phase 2: the scene's sky box dropdown and the background roughness, on the new SkyBox
// API (not persisted). Phase 3 rewrites the tab folder by folder.

const LS_KEY_UI = 'AEK_debugSkyBoxUI';
const TAB_ID = 'skyBoxControls';
const NO_SKYBOX_ID = '__noSkyBox';
let debuggerCreated = false;

// What the panes bind to, synced from the active sky box before every build and refresh
const selectProxy = { skyBoxId: NO_SKYBOX_ID };
const envProxy = { backgroundRoughness: ENV_DEFAULTS.backgroundRoughness };

const syncProxies = () => {
  const active = getActiveSkyBox();
  selectProxy.skyBoxId = active?.id ?? NO_SKYBOX_ID;
  envProxy.backgroundRoughness =
    active?.def.env?.backgroundRoughness ?? ENV_DEFAULTS.backgroundRoughness;
};

// Undo/redo: the handlers resolve the sky box by scene and id every time

type SkyBoxParamPayload = {
  sceneId: string;
  skyBoxId: string;
  /** A layer value's path in the definition, eg. 'env.backgroundRoughness'. */
  path: string;
  prev: unknown;
  next: unknown;
};
type SkyBoxSelectPayload = { sceneId: string; prev: string | null; next: string | null };

/** `'env.backgroundRoughness', 0.2` → `{ env: { backgroundRoughness: 0.2 } }` */
const toUpdate = (path: string, value: unknown) =>
  path.split('.').reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as SkyBoxUpdate;

const applyParam = async ({ sceneId, skyBoxId, path }: SkyBoxParamPayload, value: unknown) => {
  if (getCurrentSceneId() !== sceneId) return;
  await updateSkyBox(skyBoxId, toUpdate(path, value));
};

_registerUndoRedoActionHandler<SkyBoxParamPayload>('skybox.param', {
  undo: (payload) => applyParam(payload, payload.prev),
  redo: (payload) => applyParam(payload, payload.next),
});
_registerUndoRedoActionHandler<SkyBoxSelectPayload>('skybox.select', {
  undo: ({ sceneId, prev }) => {
    if (getCurrentSceneId() === sceneId) void setActiveSkyBox(prev, sceneId);
  },
  redo: ({ sceneId, next }) => {
    if (getCurrentSceneId() === sceneId) void setActiveSkyBox(next, sceneId);
  },
});

const buildSkyBoxItems = (): DebuggerPaneItem[] => {
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

  return [
    {
      type: 'folder',
      id: 'sceneSkyBoxes',
      title: "Scene's skyboxes",
      content: [
        {
          key: 'skyBoxId',
          target: selectProxy,
          label: 'Sky boxes in scene',
          options,
          onChange: (value, e) => {
            if (!sceneId) return;
            const toId = (v: unknown) => (String(v) === NO_SKYBOX_ID ? null : String(v));
            const prev = toId(e.prev);
            const next = toId(value);
            void setActiveSkyBox(next, sceneId);
            if (prev !== next) {
              _recordUndoRedoAction<SkyBoxSelectPayload>('skybox.select', 'Sky box: select', {
                sceneId,
                prev,
                next,
              });
            }
          },
        },
      ],
    },
    {
      type: 'folder',
      id: 'environment',
      title: 'Environment',
      hidden: () => {
        const active = getActiveSkyBox();
        return !active || active.def.base.type === 'COLOR';
      },
      content: [
        {
          key: 'backgroundRoughness',
          target: envProxy,
          label: 'Background roughness',
          step: 0.001,
          min: 0,
          max: 1,
          onChange: (value, e) => {
            const active = getActiveSkyBox();
            if (!active) return;
            const next = Number(value);
            void updateSkyBox(active.id, { env: { backgroundRoughness: next } });
            if (Number(e.prev) === next) return;
            _recordOrCoalesceUndoRedoAction<SkyBoxParamPayload>(
              'skybox.param',
              `Sky box ${active.id}: background roughness`,
              {
                sceneId: active.sceneId,
                skyBoxId: active.id,
                path: 'env.backgroundRoughness',
                prev: Number(e.prev),
                next,
              },
              `${active.sceneId}.${active.id}.env.backgroundRoughness`
            );
          },
        },
      ],
    },
  ];
};

const buildSkyBoxDebugGUI = () => {
  // Set before createDebuggerTab: it can build the tab right away, and the tab's own build
  // must not come back here.
  debuggerCreated = true;
  createDebuggerTab({
    id: TAB_ID,
    title: 'Sky box controls',
    icon: 'cloudSun',
    uiLsKey: LS_KEY_UI,
    clearLSButton: false,
    headerButtons: () => [
      createClearTabLSButton({
        hasData: () => lsKeyHasData(LS_KEY_UI),
        watchKey: LS_KEY_UI,
        onClear: () => lsRemoveItem(LS_KEY_UI),
      }),
    ],
    onRefresh: syncProxies,
    content: () => [{ pane: true, content: buildSkyBoxItems() }],
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
    updateDebuggerTab(TAB_ID, { rebuild: doRebuild });
  });
};
