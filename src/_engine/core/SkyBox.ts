import * as THREE from 'three/webgpu';
import {
  normalWorld,
  uniform,
  normalView,
  positionViewDirection,
  cameraViewMatrix,
  pmremTexture,
  reflectVector,
} from 'three/tsl';
import { lerror, lwarn } from '../utils/Logger';
import {
  getCurrentScene,
  getCurrentSceneId,
  getRootScene,
  getScene,
  isCurrentScene,
} from './Scene';
import { getRenderer } from './Renderer';
import { getTexture, loadTextureAsync } from './Texture';
import { isDebugEnvironment } from './Config';
import { createNewDebuggerPane, createDebuggerTab } from '../debug/DebuggerGUI';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import {
  changeDebugEnvBallRoughness,
  getDebugToolsState,
  setDebugEnvBallMaterial,
} from '../debug/DebugTools';
import { isHDR } from '../utils/helpers';
import { ListBladeApi, Pane } from 'tweakpane';
import { BladeController, View } from '@tweakpane/core';
import { getSvgIcon } from './UI/icons/SvgIcon';

type SkyBoxProps = {
  id: string;
  name?: string;
  isCurrent?: boolean; // Default is true
  sceneId?: string;
} & (
  | {
      type: '';
      params: null;
    }
  | {
      type: 'EQUIRECTANGULAR';
      params: {
        file?: string | THREE.Texture | THREE.DataTexture;
        path?: string;
        textureId?: string;
        /** Default is THREE.SRGBColorSpace */
        colorSpace?: THREE.ColorSpace;
        roughness?: number;
        // @TODO: check if equiTextRotate can be added (just rotate)
      };
    }
  | {
      type: 'CUBETEXTURE';
      params: {
        fileNames: string[];
        path?: string;
        textureId?: string;
        /** Default is THREE.SRGBColorSpace */
        colorSpace?: THREE.ColorSpace;
        roughness?: number;
        cubeTextRotate?: number; // @TODO: change this to just rotate
        flipY?: boolean;
      };
    }
  | {
      type: 'SKYANDSUN';
      params: null;
    }
);

type SkyBoxState = {
  id: string;
  name?: string;
  isCurrent?: boolean;
  isDefaultForScene?: boolean;
  type: '' | 'EQUIRECTANGULAR' | 'CUBETEXTURE' | 'SKYANDSUN';
  equiRectFile: string;
  equiRectTextureId: string;
  equiRectColorSpace: THREE.ColorSpace;
  equiRectRoughness: number;
  cubeTextFile: string[];
  cubeTextPath: string;
  cubeTextTextureId: string;
  cubeTextColorSpace: THREE.ColorSpace;
  cubeTextRoughness: number;
  cubeTextRotate: number;
  cubeTextFlipY: boolean;
  envBallRoughness: number;
  sceneSkyBoxesFolderExpanded: boolean;
};

const LS_KEY_ALL_STATES = 'debugSkyBoxStates';
const LS_KEY_UI = 'debugSkyBoxUI';
const NO_SKYBOX_ID = '__no_skybox';
let defaultRoughness = 0;
const pmremRoughnessBg = uniform(defaultRoughness);

const defaultSkyBoxState: SkyBoxState = {
  id: NO_SKYBOX_ID,
  type: '',
  equiRectFile: '',
  equiRectTextureId: '',
  equiRectColorSpace: THREE.SRGBColorSpace,
  equiRectRoughness: defaultRoughness,
  cubeTextFile: [],
  cubeTextPath: '',
  cubeTextTextureId: '',
  cubeTextColorSpace: THREE.SRGBColorSpace,
  cubeTextRoughness: defaultRoughness,
  cubeTextRotate: 0,
  cubeTextFlipY: false,
  envBallRoughness: defaultRoughness,
  sceneSkyBoxesFolderExpanded: false,
};
let skyBoxState = { ...defaultSkyBoxState };
let allSkyBoxStates: {
  [sceneId: string]: {
    [id: string]: SkyBoxState;
  };
} = {};
let debuggerCreated = false;
let cubeTexture: THREE.CubeTexture | null = null;
let skyBoxDebugGUI: Pane | null = null;

let debugSkyBoxUIState = {
  currentFolderExpanded: true,
  scenesSkyBoxesListExpanded: true,
};

/**
 * Creates either a sky box (equirectangular, cube texture, or sky and sun). The sky and sun type ("SKYANDSUN") includes a dynamic sun element in the sky.
 * @param skyBoxProps (object) object that has different property's based on the type property, {@link SkyBoxProps}
 * @param doNotUpdateDebuggerSceneDefault (boolean) optional flag to be used only within the sky box debugger
 */
export const createSkyBox = async (
  { id, name, sceneId, isCurrent, type, params }: SkyBoxProps,
  doNotUpdateDebuggerSceneDefault?: boolean // This is to keep the [*default] indicator in the debugger listings when the debugger changes the sky box
) => {
  const renderer = getRenderer();
  if (!renderer) {
    const msg = `Could not find renderer in createSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  let scene = getCurrentScene();
  if (sceneId) scene = getScene(sceneId);
  const isCurScene = isCurrentScene(scene?.userData.id);
  if (!scene) {
    const msg = `Could not find ${sceneId ? `scene with id "${sceneId}"` : 'current scene'} in createSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  const givenOrCurrentSceneId = scene.userData.id;
  if (!givenOrCurrentSceneId) {
    const msg = 'Could not find current scene id in createSkyBox.';
    lerror(msg);
    throw new Error(msg);
  }

  let skyBoxStateToBeAdded = {
    ...defaultSkyBoxState,
    isCurrent: isCurrent !== false,
  };
  if (!allSkyBoxStates[givenOrCurrentSceneId]) allSkyBoxStates[givenOrCurrentSceneId] = {};
  if (!allSkyBoxStates[givenOrCurrentSceneId][id]) {
    allSkyBoxStates[givenOrCurrentSceneId][id] = { ...defaultSkyBoxState };
  }

  if (params && 'roughness' in params) {
    // @TODO: refactor this to save the original input value as default value (the value to reset to)
    defaultRoughness = params.roughness !== undefined ? params.roughness : defaultRoughness;
    skyBoxStateToBeAdded.equiRectRoughness = defaultRoughness;
    skyBoxStateToBeAdded.cubeTextRoughness = defaultRoughness;
  }

  if (isDebugEnvironment()) {
    const savedAllSkyBoxStates = lsGetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    allSkyBoxStates = { ...allSkyBoxStates, ...savedAllSkyBoxStates };
    const curSceneState = allSkyBoxStates[givenOrCurrentSceneId][id];
    skyBoxStateToBeAdded = { ...skyBoxStateToBeAdded, ...(curSceneState || {}) };

    if (!doNotUpdateDebuggerSceneDefault) {
      const sceneSkyBoxes = allSkyBoxStates[givenOrCurrentSceneId];
      const sceneSkyBoxKeys = Object.keys(sceneSkyBoxes);
      for (let i = 0; i < sceneSkyBoxKeys.length; i++) {
        const ssb = sceneSkyBoxes[sceneSkyBoxKeys[i]];
        ssb.isDefaultForScene = false;
      }
    }
  }

  skyBoxStateToBeAdded.id = id;
  skyBoxStateToBeAdded.type = type;

  if (type === 'EQUIRECTANGULAR') {
    // EQUIRECTANGULAR
    const file = params.file;
    const textureId = params.textureId;
    if (!file && !textureId) {
      lerror('Provide either file or textureId in the equirectangular params in createSkyBox.');
      return;
    }
    let equirectTexture: THREE.Texture | THREE.DataTexture | null = null;
    let envTexture: null | THREE.Texture | THREE.DataTexture = null;

    if (isCurScene && skyBoxStateToBeAdded.isCurrent) {
      if (typeof file === 'string' || textureId) {
        // File is a string or textureId was provided (texture has been already loaded)
        if (isHDR(file as string)) {
          // @TODO: cache equirectangular textures
          equirectTexture = await loadTextureAsync({
            id: textureId,
            fileName: file as string,
            path: params.path,
            useRGBELoader: true,
            throwOnError: isDebugEnvironment(),
          });
          // equirectTexture.magFilter = THREE.LinearFilter;
          // equirectTexture.minFilter = THREE.LinearMipMapLinearFilter;
          // equirectTexture.anisotropy = 16;
        } else {
          equirectTexture = file
            ? await loadTextureAsync({
                id: textureId,
                fileName: file as string,
                throwOnError: isDebugEnvironment(),
              })
            : getTexture(textureId || '');
        }
        if (!equirectTexture) {
          const msg = `Could not find or load equirectangular texture in createSkyBox (params: ${JSON.stringify(params)}).`;
          lerror(msg);
          return;
        }
        equirectTexture.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
        envTexture = equirectTexture;
      } else if (file) {
        // File is a Texture/DataTexture
        file.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
        equirectTexture = file;
        envTexture = file;
      }

      // Use sky box as environment map
      if (!envTexture) {
        const msg = 'Could not find envTexture in createSkyBox';
        lerror(msg);
        throw new Error(msg);
      }
      envTexture.mapping = THREE.EquirectangularReflectionMapping;
      const reflectVec = positionViewDirection
        .negate()
        .reflect(normalView)
        .transformDirection(cameraViewMatrix);
      pmremRoughnessBg.value = skyBoxStateToBeAdded.equiRectRoughness;
      const backgroundEnvNode = pmremTexture(envTexture, normalWorld, pmremRoughnessBg);

      const rootScene = getRootScene() as THREE.Scene;
      rootScene.backgroundNode = backgroundEnvNode;
      rootScene.environmentNode = backgroundEnvNode;
      scene.userData.backgroundNodeTextureId = textureId || envTexture.userData.id;
      if (isDebugEnvironment()) {
        const pmremRoughnessBall = uniform(skyBoxStateToBeAdded.equiRectRoughness);
        const pmremNodeBall = pmremTexture(envTexture, reflectVec, pmremRoughnessBall);
        setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
      }
    }

    // Add to skyBoxStateToBeAdded
    skyBoxStateToBeAdded.equiRectFile = typeof file === 'string' ? file : '';
    skyBoxStateToBeAdded.equiRectTextureId = textureId
      ? textureId
      : equirectTexture?.userData.id || undefined;
    skyBoxStateToBeAdded.equiRectColorSpace =
      params.colorSpace !== undefined ? params.colorSpace : THREE.SRGBColorSpace;
  } else if (type === 'CUBETEXTURE') {
    // CUBETEXTURE
    const { fileNames, path, textureId, flipY } = params;

    if (isCurScene && skyBoxStateToBeAdded.isCurrent) {
      cubeTexture = (await loadTextureAsync({
        id: textureId,
        fileName: fileNames,
        path,
        throwOnError: isDebugEnvironment(),
      })) as THREE.CubeTexture;
      cubeTexture.userData.id = textureId || cubeTexture.uuid;
      cubeTexture.generateMipmaps = true;
      cubeTexture.minFilter = THREE.LinearMipmapLinearFilter;
      cubeTexture.colorSpace = params.colorSpace || defaultSkyBoxState.cubeTextColorSpace;

      pmremRoughnessBg.value = skyBoxStateToBeAdded.cubeTextRoughness;
      const rotateYMatrix = new THREE.Matrix4();
      rotateYMatrix.makeRotationY(Math.PI * skyBoxStateToBeAdded.cubeTextRotate);
      const backgroundUV = reflectVector.xyz.mul(uniform(rotateYMatrix)).mul(flipY ? 1 : -1);
      if (isCurScene && isCurrent !== false) {
        const rootScene = getRootScene() as THREE.Scene;
        rootScene.backgroundNode = pmremTexture(cubeTexture, backgroundUV, pmremRoughnessBg);
      }
      scene.userData.backgroundNodeTextureId = textureId || cubeTexture.userData.id;
      if (isDebugEnvironment()) {
        const pmremRoughnessBall = uniform(skyBoxStateToBeAdded.cubeTextRoughness);
        const pmremNodeBall = pmremTexture(cubeTexture, backgroundUV.mul(-1), pmremRoughnessBall);
        setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
      }
    }

    // Add to skyBoxStateToBeAdded
    skyBoxStateToBeAdded.cubeTextFile = fileNames;
    skyBoxStateToBeAdded.cubeTextPath = path || defaultSkyBoxState.cubeTextPath;
    skyBoxStateToBeAdded.cubeTextTextureId = textureId || cubeTexture?.userData.id || undefined;
    skyBoxStateToBeAdded.cubeTextColorSpace =
      params.colorSpace !== undefined ? params.colorSpace : defaultSkyBoxState.cubeTextColorSpace;
    skyBoxStateToBeAdded.cubeTextRotate =
      params.cubeTextRotate !== undefined
        ? params.cubeTextRotate
        : defaultSkyBoxState.cubeTextRotate;
    skyBoxStateToBeAdded.cubeTextFlipY = Boolean(flipY);
  } else if (type === 'SKYANDSUN') {
    // SKYANDSUN
    // @TODO: implement SKYANDSUN
    lwarn('At the moment SKYANDSUN skybox type is not supported (maybe in the future).'); // @TODO: remove when fully implemented
  }

  if (skyBoxStateToBeAdded.isCurrent) {
    // If the sky box is set to current, then set all the scene's existing sky boxes as not current
    const curSceneStates = allSkyBoxStates[givenOrCurrentSceneId];
    const curSceneStatesKeys = Object.keys(curSceneStates);

    for (let i = 0; i < curSceneStatesKeys.length; i++) {
      const key = curSceneStatesKeys[i];
      if (allSkyBoxStates[givenOrCurrentSceneId][key]) {
        allSkyBoxStates[givenOrCurrentSceneId][key].isCurrent = false;
        if (!doNotUpdateDebuggerSceneDefault) {
          allSkyBoxStates[givenOrCurrentSceneId][key].isDefaultForScene = false;
        }
      }
    }
    if (!doNotUpdateDebuggerSceneDefault) skyBoxStateToBeAdded.isDefaultForScene = true;
  }
  allSkyBoxStates[givenOrCurrentSceneId][id] = {
    ...defaultSkyBoxState,
    ...skyBoxStateToBeAdded,
    name,
  };

  if (skyBoxStateToBeAdded.isCurrent) {
    skyBoxState = { ...skyBoxState, ...allSkyBoxStates[givenOrCurrentSceneId][id] };
  }

  buildSkyBoxDebugGUI();
};

/**
 * Deletes the current scene's current sky box
 */
export const deleteCurrentSkyBox = () => {
  const rootScene = getRootScene() as THREE.Scene;
  rootScene.backgroundNode = null;
  rootScene.environmentNode = null;
  skyBoxState = { ...defaultSkyBoxState };

  const sceneId = getCurSceneSkyBoxSceneId();
  const curSceneStates = allSkyBoxStates[sceneId];
  const curSceneStatesKeys = Object.keys(curSceneStates);
  for (let i = 0; i < curSceneStatesKeys.length; i++) {
    const key = curSceneStatesKeys[i];
    if (allSkyBoxStates[sceneId][key]) {
      allSkyBoxStates[sceneId][key].isCurrent = false;
    }
  }
};

/**
 * Creates the sky box debug GUI for the first time
 */
const createSkyBoxDebugGUI = () => {
  const icon = getSvgIcon('cloudSun');
  createDebuggerTab({
    id: 'skyBoxControls',
    buttonText: icon,
    title: 'Sky box controls',
    orderNr: 5,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('skyBox', `${icon} Sky Box Controls`);
      skyBoxDebugGUI = debugGUI;
      buildSkyBoxDebugGUI();
      return container;
    },
  });
  debuggerCreated = true;
};

/**
 * Build the debug GUI
 */
export const buildSkyBoxDebugGUI = () => {
  if (!isDebugEnvironment()) return;
  if (!debuggerCreated) createSkyBoxDebugGUI();

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
      const debugToolsState = getDebugToolsState();
      if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(e.value);
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
    const debugToolsState = getDebugToolsState();
    if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(defaultRoughness);
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
      const debugToolsState = getDebugToolsState();
      if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(e.value);
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
    const debugToolsState = getDebugToolsState();
    if (!debugToolsState.env.separateBallValues) changeDebugEnvBallRoughness(defaultRoughness);
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
    value: findScenesCurrentSkyBoxState().id,
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
      setTimeout(() => buildSkyBoxDebugGUI(), 0);
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
          name: sbState.name,
          sceneId: getCurSceneSkyBoxSceneId(),
          isCurrent: true,
        },
        true
      );
      lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    }, 0);
  });
};

const extractSkyBoxParamsFromState = (state: SkyBoxState) => {
  if (state.type === 'EQUIRECTANGULAR') {
    return {
      type: state.type,
      params: {
        file: state.equiRectFile || undefined,
        textureId: state.equiRectTextureId || undefined,
        colorSpace: state.equiRectColorSpace || undefined,
        roughness: state.equiRectRoughness || undefined,
      },
    } as SkyBoxProps;
  }
  if (state.type === 'CUBETEXTURE') {
    return {
      type: state.type,
      params: {
        fileNames: state.cubeTextFile || undefined,
        path: state.cubeTextPath || undefined,
        textureId: state.cubeTextTextureId || undefined,
        colorSpace: state.cubeTextColorSpace || undefined,
        roughness: state.cubeTextRoughness || undefined,
        cubeTextRotate: state.cubeTextRotate || undefined,
        flipY: state.cubeTextFlipY || undefined,
      },
    } as SkyBoxProps;
  }
  if (state.type === 'SKYANDSUN') {
    return {
      type: state.type,
      params: null,
    } as SkyBoxProps;
  }
  return {
    type: '',
    params: null,
  } as SkyBoxProps;
};

const getCurSceneSkyBoxSceneId = () => {
  const sceneId = getCurrentSceneId();
  if (!sceneId) {
    const msg = 'Could not find current scene id in getCurSceneSkyBoxSceneId.';
    lerror(msg);
    throw new Error(msg);
  }
  return sceneId;
};

const findScenesCurrentSkyBoxState = () => {
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

/**
 * Clears the current sky box state and root scene's background and environment nodes
 */
export const clearSkyBox = () => {
  skyBoxState = { ...defaultSkyBoxState };
  const rootScene = getRootScene() as THREE.Scene;
  if (rootScene) {
    rootScene.backgroundNode = null;
    rootScene.environmentNode = null;
  }
  buildSkyBoxDebugGUI();
};

/**
 * Get pmremRoughnessBg (the environment map roughness shader node)
 * @returns ShaderNodeObject<THREE.UniformNode<number>>
 */
export const getEnvMapRoughnessBg = () => pmremRoughnessBg;
