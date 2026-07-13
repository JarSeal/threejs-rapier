import { uniform } from 'three/tsl';
import { ListBladeApi, Pane } from 'tweakpane';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerPane } from '../../debug/DebuggerGUI';
import { IS_DEBUG_ENV } from '../Config';
import { lsGetItem, lsSetItem } from '../../utils/LocalAndSessionStorage';
import {
  clearSkyBox,
  createSkyBox,
  defaultRoughness,
  defaultSkyBoxState,
  deleteCurrentSkyBox,
  extractSkyBoxParamsFromState,
  getCurSceneSkyBoxSceneId,
  LS_KEY_ALL_STATES,
  NO_SKYBOX_ID,
  SkyBoxState,
} from '../SkyBox';
import { BladeController, View } from '@tweakpane/core';
import { getCurrentSceneId } from '../Scene';

const LS_KEY_UI = 'AEK_debugSkyBoxUI';
const pmremRoughnessBg = uniform(defaultRoughness);
let skyBoxDebugGUI: Pane | null = null;
let debuggerCreated = false;
let debugSkyBoxUIState = {
  currentFolderExpanded: true,
  scenesSkyBoxesListExpanded: true,
};

/**
 * Creates the sky box debug GUI for the first time
 */
const buildSkyBoxDebugGUI = (
  skyBoxState: SkyBoxState,
  allSkyBoxStates: {
    [sceneId: string]: {
      [id: string]: SkyBoxState;
    };
  }
) => {
  const icon = getSvgIcon('cloudSun');
  createDebuggerTab({
    id: 'skyBoxControls',
    buttonText: icon,
    title: 'Sky box controls',
    orderNr: 5,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('skyBox', `${icon} Sky Box Controls`);
      skyBoxDebugGUI = debugGUI;
      _createSkyBoxDebugGUI(skyBoxState, allSkyBoxStates);
      return container;
    },
  });
  debuggerCreated = true;
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
  if (!debuggerCreated) buildSkyBoxDebugGUI(skyBoxState, allSkyBoxStates);

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
      pmremRoughnessBg.value = e.value;
      // const debugToolsState = getDebugToolsState();
      // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(e.value);
      const sceneId = getCurSceneSkyBoxSceneId();
      const curSceneState = allSkyBoxStates[sceneId][skyBoxState.id];
      if (curSceneState) {
        allSkyBoxStates[sceneId][skyBoxState.id].equiRectRoughness = e.value;
      } else {
        allSkyBoxStates[sceneId][skyBoxState.id] = {
          ...defaultSkyBoxState,
          equiRectRoughness: e.value,
        };
      }
      lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    });
  equiRectFolder.addButton({ title: 'Reset' }).on('click', () => {
    skyBoxState.equiRectRoughness = defaultRoughness;
    pmremRoughnessBg.value = defaultRoughness;
    // const debugToolsState = getDebugToolsState();
    // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(defaultRoughness);
    const sceneId = getCurSceneSkyBoxSceneId();
    allSkyBoxStates[sceneId][skyBoxState.id].equiRectRoughness = defaultRoughness;
    lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    debugGUI.refresh();
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
      pmremRoughnessBg.value = e.value;
      // const debugToolsState = getDebugToolsState();
      // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(e.value);
      const sceneId = getCurSceneSkyBoxSceneId();
      const curSceneState = allSkyBoxStates[sceneId][skyBoxState.id];
      if (curSceneState) {
        allSkyBoxStates[sceneId][skyBoxState.id].cubeTextRoughness = e.value;
      } else {
        allSkyBoxStates[sceneId][skyBoxState.id] = {
          ...defaultSkyBoxState,
          cubeTextRoughness: e.value,
        };
      }
      lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
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
    skyBoxState.cubeTextRoughness = defaultRoughness;
    pmremRoughnessBg.value = defaultRoughness;
    // const debugToolsState = getDebugToolsState();
    // if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(defaultRoughness);
    const sceneId = getCurSceneSkyBoxSceneId();
    allSkyBoxStates[sceneId][skyBoxState.id].cubeTextRoughness = defaultRoughness;
    lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    debugGUI.refresh();
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
  const scenesSkyBoxesDropDown = sceneSkyBoxesFolder.addBlade({
    view: 'list',
    label: 'Sky boxes in scene',
    value: findScenesCurrentSkyBoxState(allSkyBoxStates).id,
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
    if (id === NO_SKYBOX_ID) {
      deleteCurrentSkyBox();
      lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
      // We have to use setTimeout, because the debugGUI is rebuilt
      setTimeout(() => _createSkyBoxDebugGUI(skyBoxState, allSkyBoxStates), 0);
      return;
    }
    const sbState = sceneSkyBoxes[id];
    sbState.isCurrent = true;
    lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    // We have to use setTimeout, because the debugGUI is rebuilt
    setTimeout(async () => {
      await createSkyBox(
        {
          ...extractSkyBoxParamsFromState(sbState),
          id,
          sceneId: getCurSceneSkyBoxSceneId(),
          isCurrent: true,
          ...(sbState?.name ? { debugData: { name: sbState.name } } : {}),
        },
        true
      );
      lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    }, 0);
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
