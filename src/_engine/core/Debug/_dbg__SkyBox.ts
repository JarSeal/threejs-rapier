import { ListBladeApi, Pane } from 'tweakpane';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
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
import { BladeController, View } from '@tweakpane/core';
import { getCurrentSceneId } from '../Scene';
import { lwarn } from '../../utils/Logger';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from './_dbg__UndoRedo';

type AllSkyBoxStates = { [sceneId: string]: { [id: string]: SkyBoxState } };

const LS_KEY_UI = 'AEK_debugSkyBoxUI';
let skyBoxDebugGUI: Pane | null = null;
/** SkyBox.ts replaces its state objects whenever a sky box is created or cleared and passes the
 * new ones on every rebuild, so the tab and the undo/redo handlers use the latest ones. */
let latestSkyBoxState: SkyBoxState = { ...defaultSkyBoxState };
let latestAllSkyBoxStates: AllSkyBoxStates = {};
let debuggerCreated = false;
let debugSkyBoxUIState = {
  currentFolderExpanded: true,
  scenesSkyBoxesListExpanded: true,
};

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
  createSkyBoxDebugGUI();
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
 * Creates the sky box debug GUI for the first time
 */
const buildSkyBoxDebugGUI = () => {
  // Set before createDebuggerTab: it can build the tab right away, and the tab's own build
  // must not come back here.
  debuggerCreated = true;
  const icon = getSvgIcon('cloudSun');
  createDebuggerTab({
    id: 'skyBoxControls',
    buttonText: icon,
    title: 'Sky box controls',
    container: () => {
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
      const { container, debugGUI } = createNewDebuggerPane('skyBox', `${icon} Sky Box Controls`, [
        clearTabBtn,
        clearListBtn,
      ]);
      skyBoxDebugGUI = debugGUI;
      _createSkyBoxDebugGUI(latestSkyBoxState, latestAllSkyBoxStates);
      return container;
    },
  });
};

/**
 * Build the debug GUI
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
  if (!debuggerCreated) buildSkyBoxDebugGUI();

  if (!skyBoxDebugGUI) return;
  const debugGUI = skyBoxDebugGUI;

  const blades = debugGUI.children || [];
  for (let i = 0; i < blades.length; i++) {
    blades[i].dispose();
  }

  debugSkyBoxUIState = { ...debugSkyBoxUIState, ...lsGetItem(LS_KEY_UI, debugSkyBoxUIState) };

  // Equirectangular
  const equiRectFolder = debugGUI
    .addFolder({
      title: 'Current: Equirectangular sky box params',
      hidden: skyBoxState.type !== 'EQUIRECTANGULAR',
      expanded: debugSkyBoxUIState.currentFolderExpanded,
    })
    .on('fold', (state) => {
      debugSkyBoxUIState.currentFolderExpanded = state.expanded;
      lsSetItem(LS_KEY_UI, debugSkyBoxUIState);
    });
  equiRectFolder.addBinding(skyBoxState, 'type', {
    label: 'Type',
    readonly: true,
  });
  equiRectFolder.addBinding(skyBoxState, 'equiRectFile', {
    label: 'File path or URL',
    readonly: true,
  });
  equiRectFolder.addBinding(skyBoxState, 'equiRectTextureId', {
    label: 'Texture id',
    readonly: true,
  });
  equiRectFolder.addBinding(skyBoxState, 'equiRectColorSpace', {
    label: 'Color space',
    readonly: true,
  });
  equiRectFolder
    .addBinding(skyBoxState, 'equiRectRoughness', {
      label: 'Roughness',
      step: 0.001,
      min: 0,
      max: 1,
    })
    .on('change', (e) => {
      // const debugToolsState = getDebugToolsState();
      // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(e.value);
      const sceneId = getCurSceneSkyBoxSceneId();
      // The binding has already written skyBoxState, so the previous value is the stored one
      const prev =
        allSkyBoxStates[sceneId]?.[skyBoxState.id]?.equiRectRoughness ?? defaultRoughness;
      writeSkyBoxRoughness(sceneId, skyBoxState.id, 'EQUIRECTANGULAR', e.value);
      recordSkyBoxRoughness('skybox.roughness', {
        sceneId,
        skyBoxId: skyBoxState.id,
        kind: 'EQUIRECTANGULAR',
        prev,
        next: e.value,
      });
    });
  equiRectFolder.addButton({ title: 'Reset' }).on('click', () => {
    // const debugToolsState = getDebugToolsState();
    // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(defaultRoughness);
    const sceneId = getCurSceneSkyBoxSceneId();
    const prev = skyBoxState.equiRectRoughness;
    writeSkyBoxRoughness(sceneId, skyBoxState.id, 'EQUIRECTANGULAR', defaultRoughness);
    debugGUI.refresh();
    recordSkyBoxRoughness('skybox.resetRoughness', {
      sceneId,
      skyBoxId: skyBoxState.id,
      kind: 'EQUIRECTANGULAR',
      prev,
      next: defaultRoughness,
    });
  });

  // Cubetexture
  const cubeTextureFolder = debugGUI
    .addFolder({
      title: 'Current: Cube texture sky box params',
      hidden: skyBoxState.type !== 'CUBETEXTURE',
      expanded: debugSkyBoxUIState.currentFolderExpanded,
    })
    .on('fold', (state) => {
      debugSkyBoxUIState.currentFolderExpanded = state.expanded;
      lsSetItem(LS_KEY_UI, debugSkyBoxUIState);
    });
  cubeTextureFolder.addBinding(skyBoxState, 'type', {
    label: 'Type',
    readonly: true,
    options: [{ value: skyBoxState.type }],
  });
  cubeTextureFolder.addBinding(skyBoxState, 'cubeTextPath', {
    label: 'Texture path',
    readonly: true,
  });
  const files = { v: skyBoxState.cubeTextFile.join('\n') };
  cubeTextureFolder.addBinding(files, 'v', {
    readonly: true,
    multiline: true,
    label: 'Files',
    rows: 3,
    interval: 0,
  });
  cubeTextureFolder.addBinding(skyBoxState, 'cubeTextTextureId', {
    label: 'Texture id',
    readonly: true,
  });
  cubeTextureFolder.addBinding(skyBoxState, 'cubeTextColorSpace', {
    label: 'Color space',
    readonly: true,
  });
  cubeTextureFolder
    .addBinding(skyBoxState, 'cubeTextRoughness', {
      label: 'Roughness',
      step: 0.001,
      min: 0,
      max: 1,
    })
    .on('change', (e) => {
      // const debugToolsState = getDebugToolsState();
      // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(e.value);
      const sceneId = getCurSceneSkyBoxSceneId();
      // The binding has already written skyBoxState, so the previous value is the stored one
      const prev =
        allSkyBoxStates[sceneId]?.[skyBoxState.id]?.cubeTextRoughness ?? defaultRoughness;
      writeSkyBoxRoughness(sceneId, skyBoxState.id, 'CUBETEXTURE', e.value);
      recordSkyBoxRoughness('skybox.roughness', {
        sceneId,
        skyBoxId: skyBoxState.id,
        kind: 'CUBETEXTURE',
        prev,
        next: e.value,
      });
    });
  // @TODO: show cubeTextRotate
  // cubeTextureFolder
  //   .addBinding(skyBoxState, 'cubeTextRotate', {
  //     label: 'Rotate',
  //     step: 0.001,
  //     min: 0,
  //     max: 1,
  //   })
  //   .on('change', (e) => {});
  cubeTextureFolder.addButton({ title: 'Reset' }).on('click', () => {
    // const debugToolsState = getDebugToolsState();
    // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(defaultRoughness);
    const sceneId = getCurSceneSkyBoxSceneId();
    const prev = skyBoxState.cubeTextRoughness;
    writeSkyBoxRoughness(sceneId, skyBoxState.id, 'CUBETEXTURE', defaultRoughness);
    debugGUI.refresh();
    recordSkyBoxRoughness('skybox.resetRoughness', {
      sceneId,
      skyBoxId: skyBoxState.id,
      kind: 'CUBETEXTURE',
      prev,
      next: defaultRoughness,
    });
  });

  // Scene's skyboxes
  const sceneSkyBoxesFolder = debugGUI
    .addFolder({
      title: "Scene's skyboxes",
      expanded: debugSkyBoxUIState.scenesSkyBoxesListExpanded,
    })
    .on('fold', (state) => {
      debugSkyBoxUIState.scenesSkyBoxesListExpanded = state.expanded;
      lsSetItem(LS_KEY_UI, debugSkyBoxUIState);
    });
  const sceneId = getCurSceneSkyBoxSceneId();
  const sceneSkyBoxes = {
    ...allSkyBoxStates[sceneId],
    [NO_SKYBOX_ID]: { ...defaultSkyBoxState, id: NO_SKYBOX_ID, name: '[No skybox]' },
  } as { [key: string]: SkyBoxState };
  const sceneSkyBoxesKeys = Object.keys(sceneSkyBoxes || {});
  const selectedSkyBoxId = findScenesCurrentSkyBoxState(allSkyBoxStates).id || NO_SKYBOX_ID;
  const scenesSkyBoxesDropDown = sceneSkyBoxesFolder.addBlade({
    view: 'list',
    label: 'Sky boxes in scene',
    value: selectedSkyBoxId,
    options: sceneSkyBoxesKeys
      .map((key) => ({
        text: `${sceneSkyBoxes[key].name || sceneSkyBoxes[key].id}${sceneSkyBoxes[key].isDefaultForScene ? ' [*default]' : ''}`,
        value: sceneSkyBoxes[key].id,
      }))
      .sort((a, b) => {
        if (a.text < b.text) return -1;
        if (a.text > b.text) return 1;
        return 0;
      }),
  }) as ListBladeApi<BladeController<View>>;
  scenesSkyBoxesDropDown.on('change', (e) => {
    const id = String(e.value);
    selectSkyBox(sceneId, id);
    if (id !== selectedSkyBoxId) {
      _recordUndoRedoAction<SkyBoxSelectPayload>('skybox.select', 'Sky box: select', {
        sceneId,
        prev: selectedSkyBoxId,
        next: id,
      });
    }
  });
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
