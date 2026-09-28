import {
  createDebuggerTab,
  updateDebuggerTab,
  type DebuggerPaneItem,
} from '../../debug/DebuggerGUI';
import { IS_DEBUG_ENV } from '../Config';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import {
  confirmClearScope,
  createClearListLSButton,
  createClearTabLSButton,
  lsKeyHasData,
} from './_dbg__ClearLSButtons';
import {
  clearSkyBox,
  createSkyBox,
  createSkyBoxDebugGUI,
  defaultRoughness,
  defaultSkyBoxState,
  deleteCurrentSkyBox,
  extractSkyBoxParamsFromState,
  getCurSceneSkyBoxSceneId,
  getEnvMapRoughnessBg,
  LS_KEY_ALL_STATES,
  NO_SKYBOX_ID,
  SkyBoxState,
} from '../SkyBox';
import { getCurrentSceneId } from '../Scene';
import { lwarn } from '../../utils/Logger';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from './_dbg__UndoRedo';

type AllSkyBoxStates = { [sceneId: string]: { [id: string]: SkyBoxState } };

const LS_KEY_UI = 'AEK_debugSkyBoxUI';
const TAB_ID = 'skyBoxControls';
/** SkyBox.ts replaces its state objects whenever a sky box is created or cleared and passes the
 * new ones on every rebuild, so the tab and the undo/redo handlers use the latest ones. */
let latestSkyBoxState: SkyBoxState = { ...defaultSkyBoxState };
let latestAllSkyBoxStates: AllSkyBoxStates = {};
let debuggerCreated = false;

// Undo/redo

type RoughnessKind = 'EQUIRECTANGULAR' | 'CUBETEXTURE';
const ROUGHNESS_FIELD = {
  EQUIRECTANGULAR: 'equiRectRoughness',
  CUBETEXTURE: 'cubeTextRoughness',
} as const;
type SkyBoxRoughnessPayload = {
  sceneId: string;
  skyBoxId: string;
  kind: RoughnessKind;
  prev: number;
  next: number;
};
type SkyBoxSelectPayload = { sceneId: string; prev: string; next: string };

/** Writes a sky box's roughness to its state, to the rendered sky when it's the current sky
 * box, and to LS. */
const writeSkyBoxRoughness = (
  sceneId: string,
  skyBoxId: string,
  kind: RoughnessKind,
  value: number
) => {
  const field = ROUGHNESS_FIELD[kind];
  if (!latestAllSkyBoxStates[sceneId]) latestAllSkyBoxStates[sceneId] = {};
  const sceneStates = latestAllSkyBoxStates[sceneId];
  if (sceneStates[skyBoxId]) {
    sceneStates[skyBoxId][field] = value;
  } else {
    sceneStates[skyBoxId] = { ...defaultSkyBoxState, [field]: value };
  }
  if (latestSkyBoxState.id === skyBoxId && latestSkyBoxState.type === kind) {
    latestSkyBoxState[field] = value;
    getEnvMapRoughnessBg().value = value;
  }
  lsSetItem(LS_KEY_ALL_STATES, latestAllSkyBoxStates);
};

const recordSkyBoxRoughness = (
  actionType: 'skybox.roughness' | 'skybox.resetRoughness',
  payload: SkyBoxRoughnessPayload
) => {
  if (payload.prev === payload.next) return;
  if (actionType === 'skybox.resetRoughness') {
    _recordUndoRedoAction(actionType, `Sky box ${payload.skyBoxId}: reset roughness`, payload);
    return;
  }
  _recordOrCoalesceUndoRedoAction(
    actionType,
    `Sky box ${payload.skyBoxId}: roughness`,
    payload,
    `${payload.sceneId}.${payload.skyBoxId}.${payload.kind}`
  );
};

/** Makes a scene's sky box current (or removes the current one with NO_SKYBOX_ID). */
const selectSkyBox = (sceneId: string, id: string) => {
  if (id === NO_SKYBOX_ID) {
    deleteCurrentSkyBox();
    lsSetItem(LS_KEY_ALL_STATES, latestAllSkyBoxStates);
    // We have to use setTimeout, because the debugGUI is rebuilt
    setTimeout(() => createSkyBoxDebugGUI(), 0);
    return;
  }
  const sbState = latestAllSkyBoxStates[sceneId]?.[id];
  if (!sbState) {
    lwarn(`Could not find sky box "${id}" in scene "${sceneId}", skipping.`);
    return;
  }
  sbState.isCurrent = true;
  lsSetItem(LS_KEY_ALL_STATES, latestAllSkyBoxStates);
  // We have to use setTimeout, because the debugGUI is rebuilt
  setTimeout(async () => {
    await createSkyBox(
      {
        ...extractSkyBoxParamsFromState(sbState),
        id,
        sceneId,
        isCurrent: true,
        ...(sbState.name ? { debugData: { name: sbState.name } } : {}),
      },
      true
    );
    lsSetItem(LS_KEY_ALL_STATES, latestAllSkyBoxStates);
  }, 0);
};

const applyRoughnessUndoRedo = (payload: SkyBoxRoughnessPayload, value: number) => {
  writeSkyBoxRoughness(payload.sceneId, payload.skyBoxId, payload.kind, value);
  updateDebuggerTab(TAB_ID);
};
const roughnessUndoHandler = {
  undo: (payload: SkyBoxRoughnessPayload) => applyRoughnessUndoRedo(payload, payload.prev),
  redo: (payload: SkyBoxRoughnessPayload) => applyRoughnessUndoRedo(payload, payload.next),
};
_registerUndoRedoActionHandler('skybox.roughness', roughnessUndoHandler);
_registerUndoRedoActionHandler('skybox.resetRoughness', roughnessUndoHandler);
_registerUndoRedoActionHandler<SkyBoxSelectPayload>('skybox.select', {
  undo: ({ sceneId, prev }) => selectSkyBox(sceneId, prev),
  redo: ({ sceneId, next }) => selectSkyBox(sceneId, next),
});

/**
 * Creates the sky box debug tab for the first time
 */
const buildSkyBoxDebugGUI = () => {
  // Set before createDebuggerTab: it can build the tab right away, and the tab's own build
  // must not come back here.
  debuggerCreated = true;
  createDebuggerTab({
    id: TAB_ID,
    title: 'Sky box controls',
    icon: 'cloudSun',
    // The sky box states are scene-scoped (module-owned); the tab's own data is only its UI
    // state, so both clear buttons are custom
    uiLsKey: LS_KEY_UI,
    clearLSButton: false,
    headerButtons: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => lsKeyHasData(LS_KEY_UI),
        watchKey: LS_KEY_UI,
        onClear: () => lsRemoveItem(LS_KEY_UI),
      });
      const clearListBtn = createClearListLSButton({
        hasData: () => {
          const current = lsGetItem(LS_KEY_ALL_STATES, {}) as {
            [sceneId: string]: { [id: string]: SkyBoxState };
          };
          return Object.values(current).some((scene) => Object.keys(scene || {}).length > 0);
        },
        watchKey: LS_KEY_ALL_STATES,
        onClear: () => {
          const current = lsGetItem(LS_KEY_ALL_STATES, {}) as {
            [sceneId: string]: { [id: string]: SkyBoxState };
          };
          const sceneIdsWithData = Object.keys(current).filter(
            (id) => Object.keys(current[id] || {}).length > 0
          );
          const applyClear = (sceneIds: string[]) => {
            for (const sceneId of sceneIds) delete current[sceneId];
            if (Object.keys(current).length === 0) lsRemoveItem(LS_KEY_ALL_STATES);
            else lsSetItem(LS_KEY_ALL_STATES, current);
          };
          if (sceneIdsWithData.length > 1) {
            confirmClearScope({
              onClearAllScenes: () => applyClear(sceneIdsWithData),
              onClearThisScene: () => {
                const sceneId = getCurrentSceneId();
                if (sceneId) applyClear([sceneId]);
              },
            });
          } else {
            applyClear(sceneIdsWithData);
          }
        },
      });
      return [clearTabBtn, clearListBtn];
    },
    content: () => [{ pane: true, content: buildSkyBoxItems() }],
  });
};

/**
 * Build the debug GUI (called by SkyBox.ts with the latest states whenever they change)
 */
export const _createSkyBoxDebugGUI = (
  skyBoxState: SkyBoxState,
  allSkyBoxStates: {
    [sceneId: string]: {
      [id: string]: SkyBoxState;
    };
  }
) => {
  if (!IS_DEBUG_ENV) return;
  latestSkyBoxState = skyBoxState;
  latestAllSkyBoxStates = allSkyBoxStates;
  if (!debuggerCreated) {
    buildSkyBoxDebugGUI();
    return;
  }
  // Structural: the state objects the bindings target are replaced
  updateDebuggerTab(TAB_ID, { rebuild: true });
};

/** A roughness input (and its Reset button) of the current sky box. */
const roughnessItems = (
  skyBoxState: SkyBoxState,
  kind: RoughnessKind
): DebuggerPaneItem<SkyBoxState>[] => [
  {
    key: ROUGHNESS_FIELD[kind],
    target: skyBoxState,
    label: 'Roughness',
    step: 0.001,
    min: 0,
    max: 1,
    onChange: (value, e) => {
      // const debugToolsState = getDebugToolsState();
      // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(value);
      const sceneId = getCurSceneSkyBoxSceneId();
      writeSkyBoxRoughness(sceneId, skyBoxState.id, kind, Number(value));
      recordSkyBoxRoughness('skybox.roughness', {
        sceneId,
        skyBoxId: skyBoxState.id,
        kind,
        prev: Number(e.prev),
        next: Number(value),
      });
    },
  },
  {
    type: 'button',
    title: 'Reset',
    onClick: () => {
      // const debugToolsState = getDebugToolsState();
      // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(defaultRoughness);
      const sceneId = getCurSceneSkyBoxSceneId();
      const prev = skyBoxState[ROUGHNESS_FIELD[kind]];
      writeSkyBoxRoughness(sceneId, skyBoxState.id, kind, defaultRoughness);
      updateDebuggerTab(TAB_ID);
      recordSkyBoxRoughness('skybox.resetRoughness', {
        sceneId,
        skyBoxId: skyBoxState.id,
        kind,
        prev,
        next: defaultRoughness,
      });
    },
  },
];

const buildSkyBoxItems = (): DebuggerPaneItem<SkyBoxState>[] => {
  const skyBoxState = latestSkyBoxState;
  const allSkyBoxStates = latestAllSkyBoxStates;

  const sceneId = getCurSceneSkyBoxSceneId();
  const sceneSkyBoxes = {
    ...allSkyBoxStates[sceneId],
    [NO_SKYBOX_ID]: { ...defaultSkyBoxState, id: NO_SKYBOX_ID, name: '[No skybox]' },
  } as { [key: string]: SkyBoxState };
  const selectedSkyBoxId = findScenesCurrentSkyBoxState(allSkyBoxStates).id || NO_SKYBOX_ID;
  const selectProxy = { skyBoxId: selectedSkyBoxId };

  return [
    // Equirectangular (the two "Current" folders share one folder state)
    {
      type: 'folder',
      id: 'current',
      title: 'Current: Equirectangular sky box params',
      hidden: skyBoxState.type !== 'EQUIRECTANGULAR',
      content: [
        { key: 'type', target: skyBoxState, label: 'Type', readonly: true },
        { key: 'equiRectFile', target: skyBoxState, label: 'File path or URL', readonly: true },
        { key: 'equiRectTextureId', target: skyBoxState, label: 'Texture id', readonly: true },
        { key: 'equiRectColorSpace', target: skyBoxState, label: 'Color space', readonly: true },
        ...roughnessItems(skyBoxState, 'EQUIRECTANGULAR'),
      ],
    },

    // Cubetexture
    {
      type: 'folder',
      id: 'current',
      title: 'Current: Cube texture sky box params',
      hidden: skyBoxState.type !== 'CUBETEXTURE',
      content: [
        {
          key: 'type',
          target: skyBoxState,
          label: 'Type',
          readonly: true,
          options: [{ value: skyBoxState.type }],
        },
        { key: 'cubeTextPath', target: skyBoxState, label: 'Texture path', readonly: true },
        {
          key: 'v',
          target: { v: skyBoxState.cubeTextFile.join('\n') },
          readonly: true,
          multiline: true,
          label: 'Files',
          rows: 3,
          interval: 0,
        },
        { key: 'cubeTextTextureId', target: skyBoxState, label: 'Texture id', readonly: true },
        { key: 'cubeTextColorSpace', target: skyBoxState, label: 'Color space', readonly: true },
        // @TODO: show cubeTextRotate (step 0.001, min 0, max 1)
        ...roughnessItems(skyBoxState, 'CUBETEXTURE'),
      ],
    },

    // Scene's skyboxes
    {
      type: 'folder',
      id: 'sceneSkyBoxes',
      title: "Scene's skyboxes",
      content: [
        {
          key: 'skyBoxId',
          target: selectProxy,
          label: 'Sky boxes in scene',
          options: Object.keys(sceneSkyBoxes)
            .map((key) => ({
              text: `${sceneSkyBoxes[key].name || sceneSkyBoxes[key].id}${sceneSkyBoxes[key].isDefaultForScene ? ' [*default]' : ''}`,
              value: sceneSkyBoxes[key].id,
            }))
            .sort((a, b) => {
              if (a.text < b.text) return -1;
              if (a.text > b.text) return 1;
              return 0;
            }),
          onChange: (value, e) => {
            const id = String(value);
            selectSkyBox(sceneId, id);
            if (id !== e.prev) {
              _recordUndoRedoAction<SkyBoxSelectPayload>('skybox.select', 'Sky box: select', {
                sceneId,
                prev: String(e.prev),
                next: id,
              });
            }
          },
        },
      ],
    },
  ];
};

const findScenesCurrentSkyBoxState = (allSkyBoxStates: {
  [sceneId: string]: {
    [id: string]: SkyBoxState;
  };
}) => {
  const sceneId = getCurrentSceneId();
  if (!sceneId) {
    clearSkyBox();
    return { ...defaultSkyBoxState };
  }
  if (!allSkyBoxStates[sceneId]) allSkyBoxStates[sceneId] = {};
  const sceneSkyboxStatesKeys = Object.keys(allSkyBoxStates[sceneId]);
  for (let i = 0; i < sceneSkyboxStatesKeys.length; i++) {
    const state = allSkyBoxStates[sceneId][sceneSkyboxStatesKeys[i]];
    if (state?.isCurrent) return state;
  }
  return { ...defaultSkyBoxState };
};
