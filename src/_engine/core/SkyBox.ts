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
import { getTexture, loadTexture } from './Texture';
import { isDebugEnvironment } from './Config';
import { createNewDebuggerPane, createDebuggerTab } from '../debug/DebuggerGUI';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import {
  changeDebugEnvBallRoughness,
  getDebugToolsState,
  setDebugEnvBallMaterial,
} from '../debug/DebugTools';
import { RGBELoader } from 'three/examples/jsm/Addons.js';
import { isHDR } from '../utils/helpers';
import { ListBladeApi, Pane } from 'tweakpane';
import { BladeController, View } from '@tweakpane/core';

type SkyBoxProps = {
  id: string;
  name?: string; // @TODO
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
        textureId?: string;
        colorSpace?: THREE.ColorSpace;
        isEnvMap?: boolean;
        roughness?: number;
      };
    }
  | {
      type: 'CUBETEXTURE';
      params: {
        fileNames: string[];
        path?: string;
        textureId?: string;
        colorSpace?: THREE.ColorSpace;
        roughness?: number;
        cubeTextRotate?: number;
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
  type: '' | 'EQUIRECTANGULAR' | 'CUBETEXTURE' | 'SKYANDSUN';
  equiRectFolderExpanded: boolean;
  equiRectFile: string;
  equiRectTextureId: string;
  equiRectColorSpace: THREE.ColorSpace;
  equiRectIsEnvMap: boolean;
  equiRectRoughness: number;
  cubeTextFolderExpanded: boolean;
  cubeTextFile: string; // Check if this works, there should an array of strings
  cubeTextTextureId: string;
  cubeTextColorSpace: THREE.ColorSpace;
  cubeTextRoughness: number;
  cubeTextRotate: number;
  envBallRoughness: number;
  sceneSkyBoxesFolderExpanded: boolean;
};

const LS_KEY_ALL_STATES = 'debugAllSkyBoxStates';
let defaultRoughness = 0.5;
const pmremRoughnessBg = uniform(defaultRoughness);

const defaultSkyBoxState: SkyBoxState = {
  id: '',
  type: '',
  equiRectFolderExpanded: false,
  equiRectFile: '',
  equiRectTextureId: '',
  equiRectColorSpace: THREE.SRGBColorSpace,
  equiRectIsEnvMap: false,
  equiRectRoughness: defaultRoughness,
  cubeTextFolderExpanded: false,
  cubeTextFile: '',
  cubeTextTextureId: '',
  cubeTextColorSpace: THREE.SRGBColorSpace,
  cubeTextRoughness: defaultRoughness,
  cubeTextRotate: 0,
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

/**
 * Creates either a sky box (equirectangular, cube texture, or sky and sun). The sky and sun type ("SKYANDSUN") includes a dynamic sun element in the sky.
 * @param skyBoxProps object that has different property's based on the type property, {@link SkyBoxProps}
 */
export const addSkyBox = async ({ id, name, sceneId, isCurrent, type, params }: SkyBoxProps) => {
  const renderer = getRenderer();
  if (!renderer) {
    const msg = `Could not find renderer in addSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  let scene = getCurrentScene();
  if (sceneId) scene = getScene(sceneId);
  const isCurScene = isCurrentScene(scene?.userData.id);
  if (!scene) {
    const msg = `Could not find ${sceneId ? `scene with id "${sceneId}"` : 'current scene'} in addSkyBox (type: ${type}).`;
    lerror(msg);
    throw new Error(msg);
  }

  const givenOrCurrentSceneId = scene.userData.id;
  if (!givenOrCurrentSceneId) {
    const msg = 'Could not find current scene id in addSkyBox.';
    lerror(msg);
    throw new Error(msg);
  }

  let skyBoxStateToBeAdded = { ...defaultSkyBoxState, ...findScenesCurrentSkyBoxState() };
  if (!allSkyBoxStates[givenOrCurrentSceneId]) allSkyBoxStates[givenOrCurrentSceneId] = {};
  if (!allSkyBoxStates[givenOrCurrentSceneId][id]) {
    allSkyBoxStates[givenOrCurrentSceneId][id] = { ...defaultSkyBoxState };
  }

  if (params && 'roughness' in params) {
    defaultRoughness = params.roughness || 0.5;
    skyBoxStateToBeAdded.equiRectRoughness = defaultRoughness;
    skyBoxStateToBeAdded.cubeTextRoughness = defaultRoughness;
  }

  if (isDebugEnvironment()) {
    const savedAllSkyBoxStates = lsGetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    allSkyBoxStates = { ...allSkyBoxStates, ...savedAllSkyBoxStates };
    const curSceneState = allSkyBoxStates[givenOrCurrentSceneId][id];
    skyBoxStateToBeAdded = { ...skyBoxStateToBeAdded, ...(curSceneState || {}) };
  }

  skyBoxStateToBeAdded.id = id;
  skyBoxStateToBeAdded.type = type;

  if (type === 'EQUIRECTANGULAR') {
    // EQUIRECTANGULAR
    const file = params.file;
    const textureId = params.textureId;
    if (!file && !textureId) {
      lerror('Provide either file or textureId in the equirectangular params in addSkyBox.');
      return;
    }
    let envTexture: null | THREE.Texture | THREE.DataTexture = null;
    if (typeof file === 'string' || textureId) {
      // File is a string or textureId was provided (texture was preloaded)
      let equirectTexture: THREE.Texture | THREE.DataTexture | null = null;
      if (isHDR(file as string)) {
        // @TODO: create a cache for these and load them when needed to reload
        equirectTexture = await new RGBELoader().loadAsync(file as string);
        // equirectTexture.magFilter = THREE.LinearFilter;
        // equirectTexture.minFilter = THREE.LinearMipMapLinearFilter;
        // equirectTexture.anisotropy = 16;
      } else {
        equirectTexture = file
          ? loadTexture({
              id: textureId,
              fileName: file as string,
              throwOnError: isDebugEnvironment(),
            })
          : getTexture(textureId || '');
      }
      if (!equirectTexture) {
        const msg = `Could not find or load equirectangular texture in addSkyBox (params: ${JSON.stringify(params)}).`;
        lerror(msg);
        return;
      }
      if (typeof file === 'string') skyBoxStateToBeAdded.equiRectFile = file;
      skyBoxStateToBeAdded.equiRectTextureId = textureId ? textureId : equirectTexture.userData.id;
      equirectTexture.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
      envTexture = equirectTexture;
    } else if (file) {
      // File is a Texture/DataTexture
      file.colorSpace = params.colorSpace || THREE.SRGBColorSpace;
      envTexture = file;
    }

    // Use sky box as environment map
    if (!envTexture) {
      const msg = 'Could not find envTexture in addSkyBox';
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
    if (isCurrent !== false) {
      const rootScene = getRootScene() as THREE.Scene;
      rootScene.backgroundNode = backgroundEnvNode;
      rootScene.environmentNode = backgroundEnvNode;
    }
    scene.userData.backgroundNodeTextureId = textureId || envTexture.userData.id;
    if (isDebugEnvironment()) {
      const pmremRoughnessBall = uniform(skyBoxStateToBeAdded.equiRectRoughness);
      const pmremNodeBall = pmremTexture(envTexture, reflectVec, pmremRoughnessBall);
      setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
    }
  } else if (type === 'CUBETEXTURE') {
    // CUBETEXTURE
    const { fileNames, path, textureId } = params;

    cubeTexture = await new THREE.CubeTextureLoader().setPath(path || './').loadAsync(fileNames);
    cubeTexture.userData.id = textureId || cubeTexture.uuid;
    cubeTexture.generateMipmaps = true;
    cubeTexture.minFilter = THREE.LinearMipmapLinearFilter;
    cubeTexture.colorSpace = params.colorSpace || THREE.SRGBColorSpace;

    pmremRoughnessBg.value = skyBoxStateToBeAdded.cubeTextRoughness;
    const rotateYMatrix = new THREE.Matrix4();
    rotateYMatrix.makeRotationY(Math.PI * skyBoxStateToBeAdded.cubeTextRotate);
    const backgroundUV = reflectVector.xyz.mul(uniform(rotateYMatrix));
    if (isCurScene) {
      const rootScene = getRootScene() as THREE.Scene;
      rootScene.backgroundNode = pmremTexture(cubeTexture, backgroundUV, pmremRoughnessBg);
    }
    scene.userData.backgroundNodeTextureId = textureId || cubeTexture.userData.id;
    if (isDebugEnvironment()) {
      const pmremRoughnessBall = uniform(skyBoxStateToBeAdded.cubeTextRoughness);
      const pmremNodeBall = pmremTexture(cubeTexture, backgroundUV.mul(-1), pmremRoughnessBall);
      setDebugEnvBallMaterial(pmremNodeBall, pmremRoughnessBall);
    }

    lwarn('CUBETEXTURE skybox type is under work in progress and may not work properly.'); // @TODO: remove when fully implemented
  } else if (type === 'SKYANDSUN') {
    // SKYANDSUN
    // @TODO: implement SKYANDSUN
    lwarn('At the moment SKYANDSUN skybox type is not supported (maybe in the future).'); // @TODO: remove when fully implemented
  }

  if (isCurrent !== false) {
    // If the sky box is set to current, then set all the scene's existing sky boxes as not current
    const curSceneStates = allSkyBoxStates[givenOrCurrentSceneId];
    const curSceneStatesKeys = Object.keys(curSceneStates);
    for (let i = 0; i < curSceneStatesKeys.length; i++) {
      const key = curSceneStatesKeys[i];
      if (allSkyBoxStates[givenOrCurrentSceneId][key]) {
        allSkyBoxStates[givenOrCurrentSceneId][key].isCurrent = false;
      }
    }
  }
  allSkyBoxStates[givenOrCurrentSceneId][id] = {
    ...defaultSkyBoxState,
    ...skyBoxStateToBeAdded,
    name,
    isCurrent: !(isCurrent === false),
  };

  if (isDebugEnvironment()) {
    const savedAllSkyBoxStates = lsGetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    allSkyBoxStates = { ...allSkyBoxStates, ...savedAllSkyBoxStates };
  }

  skyBoxState = { ...skyBoxState, ...allSkyBoxStates[givenOrCurrentSceneId][id] };

  buildSkyBoxDebugGUI();
};

/**
 * Creates the sky box debug GUI for the first time
 */
const createSkyBoxDebugGUI = () => {
  createDebuggerTab({
    id: 'skyBoxControls',
    buttonText: 'SKYBOX',
    title: 'Sky box controls',
    orderNr: 5,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('skyBox', 'Sky Box Controls');
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

  // Equirectangular
  const equiRectFolder = debugGUI
    .addFolder({
      title: 'Current: Equirectangular sky box params',
      hidden: skyBoxState.type !== 'EQUIRECTANGULAR',
      expanded: skyBoxState.equiRectFolderExpanded,
    })
    .on('fold', (state) => {
      const sceneId = getCurSceneSkyBoxSceneId();
      const curSceneState = allSkyBoxStates[sceneId][skyBoxState.id];
      if (curSceneState) {
        allSkyBoxStates[sceneId][skyBoxState.id].equiRectFolderExpanded = state.expanded;
      } else {
        allSkyBoxStates[sceneId][skyBoxState.id] = {
          ...defaultSkyBoxState,
          equiRectFolderExpanded: state.expanded,
        };
      }
      lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
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
  equiRectFolder.addBinding(skyBoxState, 'equiRectIsEnvMap', {
    label: 'Is environment map',
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
      expanded: skyBoxState.cubeTextFolderExpanded,
    })
    .on('fold', (state) => {
      const sceneId = getCurSceneSkyBoxSceneId();
      const curSceneState = allSkyBoxStates[sceneId][skyBoxState.id];
      if (curSceneState) {
        allSkyBoxStates[sceneId][skyBoxState.id].cubeTextFolderExpanded = state.expanded;
      } else {
        allSkyBoxStates[sceneId][skyBoxState.id] = {
          ...defaultSkyBoxState,
          cubeTextFolderExpanded: state.expanded,
        };
      }
      lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    });
  cubeTextureFolder.addBinding(skyBoxState, 'type', {
    label: 'Type',
    readonly: true,
    options: [{ value: skyBoxState.type }],
  });
  cubeTextureFolder.addBinding(skyBoxState, 'cubeTextFile', {
    label: 'File path or URL',
    readonly: true,
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
      expanded: skyBoxState.sceneSkyBoxesFolderExpanded,
    })
    .on('fold', (state) => {
      const sceneId = getCurSceneSkyBoxSceneId();
      const curSceneState = allSkyBoxStates[sceneId][skyBoxState.id];
      if (curSceneState) {
        allSkyBoxStates[sceneId][skyBoxState.id].sceneSkyBoxesFolderExpanded = state.expanded;
      } else {
        allSkyBoxStates[sceneId][skyBoxState.id] = {
          ...defaultSkyBoxState,
          sceneSkyBoxesFolderExpanded: state.expanded,
        };
      }
      lsSetItem(LS_KEY_ALL_STATES, allSkyBoxStates);
    });
  const sceneId = getCurSceneSkyBoxSceneId();
  const sceneSkyBoxes = allSkyBoxStates[sceneId];
  const sceneSkyBoxesKeys = Object.keys(sceneSkyBoxes || {});
  const scenesSkyBoxesDropDown = sceneSkyBoxesFolder.addBlade({
    view: 'list',
    label: "Scene's sky boxes",
    value: findScenesCurrentSkyBoxState().id,
    options: sceneSkyBoxesKeys
      .map((key) => ({
        text: sceneSkyBoxes[key].name || sceneSkyBoxes[key].id,
        value: sceneSkyBoxes[key].id,
      }))
      .sort((a, b) => {
        if (a.text < b.text) return -1;
        if (a.text > b.text) return 1;
        return 0;
      }),
  }) as ListBladeApi<BladeController<View>>;
  scenesSkyBoxesDropDown.on('change', (e) => {
    const value = String(e.value);
    console.log(value);
  });
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
  let curState = { ...defaultSkyBoxState };
  const sceneId = getCurrentSceneId();
  if (!sceneId) {
    clearSkyBox();
    return curState;
  }
  if (!allSkyBoxStates[sceneId]) allSkyBoxStates[sceneId] = {};
  const sceneSkyboxStatesKeys = Object.keys(allSkyBoxStates[sceneId]);
  for (let i = 0; i < sceneSkyboxStatesKeys.length; i++) {
    const state = allSkyBoxStates[sceneId][sceneSkyboxStatesKeys[i]];
    if (state?.isCurrent) curState = state;
  }
  return curState;
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
